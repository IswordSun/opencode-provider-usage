/** @jsxImportSource @opentui/solid */
/**
 * opencode-provider-usage — TUI plugin.
 *
 * Renders the active provider's usage/balance in the footer status row and
 * opens a detail dialog on click or `/quota`. All data comes from the server
 * plugin over RPC (`isword.provider-usage`); this plugin never touches
 * credentials or the network.
 *
 * Presentation: percent providers render coloured progress bars per window
 * (single view) or an aligned one-line summary (`/quota all`); balance
 * providers render the amount in its severity colour. Robustness: every RPC
 * payload is re-validated through `parseSnapshot` before it reaches the
 * render tree, the initial fetch retries with backoff while the server
 * plugin is still starting, `/quota` refreshes are bounded by a timeout,
 * and all subscriptions are torn down on cleanup.
 */

import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal, type JSX } from "solid-js";
import { barParts, formatDuration, formatReset, fmtDelta, stamp } from "./format.js";
import { matchProvider, providerDefs, type ProviderDef } from "./providers.js";
import { ProviderUsage } from "./rpc.js";
import type { ProviderFailure, ProviderState, Snapshot, UsageSegment } from "./types.js";
import { EMPTY_SNAPSHOT } from "./types.js";
import { parseSnapshot } from "./validate.js";

const INITIAL_LOAD_ATTEMPTS = 10;
const REFRESH_TIMEOUT_MS = 15_000;
/** Safety re-pull cadence in case `updated` events were missed. */
const SAFETY_POLL_MS = 120_000;
const BAR_WIDTH = 20;
const FOOTER_BAR_WIDTH = 5;
const NAME_WIDTH = 12;
/** Below this terminal width the footer drops its mini bars. */
const NARROW_WIDTH = 100;

const FAILURE_LABELS: Record<string, string> = {
	no_key: "无key",
	auth: "key无效",
	rate_limit: "限流退避中",
	empty: "查询失败",
	network: "查询失败",
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return Promise.race([promise, sleep(ms).then(() => undefined)]).catch(() => undefined);
}

function segmentTone(percent: number): "success" | "warning" | "error" {
	return percent >= 85 ? "error" : percent >= 60 ? "warning" : "success";
}

/** Worst severity across windows, used for the bolt and summary colour. */
function worstTone(segments: readonly UsageSegment[]): "success" | "warning" | "error" {
	let tone: "success" | "warning" | "error" = "success";
	for (const seg of segments) {
		const next = segmentTone(seg.percent);
		if (next === "error") return "error";
		if (next === "warning") tone = "warning";
	}
	return tone;
}

function failureLabel(state: ProviderFailure): string {
	if (state.code === "rate_limit" && state.retryAt) {
		const remainingMs = Date.parse(state.retryAt) - Date.now();
		if (Number.isFinite(remainingMs) && remainingMs > 0) {
			return `限流退避中 ${formatDuration(remainingMs / 1000)}`;
		}
	}
	return FAILURE_LABELS[state.code] ?? "查询失败";
}

/** The window that binds hardest right now (highest percent). */
function worstSegment(segments: readonly UsageSegment[]): UsageSegment | undefined {
	let worst: UsageSegment | undefined;
	for (const seg of segments) {
		if (!worst || seg.percent > worst.percent) worst = seg;
	}
	return worst;
}

/** `→ 重置 21:40（剩 3h）`; caller prefixes the separator space. */
function resetSuffix(seg: UsageSegment, now: Date): string {
	if (!seg.reset) return "";
	const time = formatReset(seg.reset, now);
	const remainingMs = Date.parse(seg.reset) - now.getTime();
	if (Number.isFinite(remainingMs) && remainingMs > 0) {
		return `→ 重置 ${time}（剩 ${formatDuration(remainingMs / 1000)}）`;
	}
	return `→ 重置 ${time}`;
}

export default Plugin.define({
	id: "isword.provider-usage.tui",
	setup(context) {
		const defs = providerDefs();
		const usage = context.client.rpc(ProviderUsage);
		const [snap, setSnap] = createSignal<Snapshot>(EMPTY_SNAPSHOT);
		let disposed = false;

		const theme = context.theme;
		const color = {
			base: theme.text.base,
			muted: theme.text.muted,
			success: theme.text.feedback.success.base,
			warning: theme.text.feedback.warning.base,
			error: theme.text.feedback.error.base,
		};
		const toneColor = (tone: "success" | "warning" | "error") => color[tone];

		/** Terminal width, reactive on resize; narrow terminals drop the bars. */
		const readWidth = (): number => {
			const width = (context.renderer as { width?: unknown } | undefined)?.width;
			return typeof width === "number" && width > 0 ? width : Number.POSITIVE_INFINITY;
		};
		const [termWidth, setTermWidth] = createSignal(readWidth());
		const [costTick, setCostTick] = createSignal(0);
		const onResize = (): void => {
			setTermWidth(readWidth());
		};
		try {
			context.renderer.on("resize", onResize);
		} catch {
			// Resize events unavailable; width refreshes on the safety poll.
		}

		// --- state ---------------------------------------------------------------

		const applySnapshot = (input: unknown): void => {
			if (disposed) return;
			setSnap(parseSnapshot(input));
		};

		const load = async (): Promise<boolean> => {
			try {
				const result = (await usage.get({})) as { snapshot?: unknown };
				applySnapshot(result?.snapshot);
				// Width is not always observable through resize events; refresh
				// it whenever we re-poll so narrow/wide switches converge.
				setTermWidth(readWidth());
				return true;
			} catch {
				return false;
			}
		};

		// The server plugin may register its RPC slightly after the TUI
		// starts; retry with backoff instead of giving up on the first
		// failure, and (re)try subscribing to updates once it answers.
		let unsubscribe: (() => void) | undefined;
		let subscribed = false;
		const trySubscribe = (): void => {
			if (disposed || subscribed) return;
			try {
				const stop = usage.events.on("updated", (event) => applySnapshot(event.data?.snapshot));
				unsubscribe = stop;
				subscribed = true;
			} catch {
				// RPC not registered yet.
			}
		};

		void (async () => {
			for (let attempt = 0; attempt < INITIAL_LOAD_ATTEMPTS && !disposed; attempt++) {
				if (await load()) {
					trySubscribe();
					return;
				}
				await sleep(Math.min(500 * 2 ** attempt, 8_000));
			}
		})();

		// Safety net: re-pull on the server's polling cadence in case update
		// events were missed (server restarted, subscription dropped).
		const safetyPoll = setInterval(() => void load(), SAFETY_POLL_MS);
		trySubscribe();

		// --- helpers -------------------------------------------------------------

		const activeProviderID = () => context.ui.model.current()?.providerID;
		const activeDef = () => matchProvider(defs, { providerID: activeProviderID() });
		const currentSessionID = (): string | undefined => {
			const route = context.ui.router.current();
			return route.type === "session" ? route.sessionID : undefined;
		};

		// --- footer ---------------------------------------------------------------

		function statusText(state: ProviderState): JSX.Element {
			if (!state.ok) {
				return <text fg={color.muted}>⚡ {failureLabel(state)}</text>;
			}
			if (state.data.kind === "balance") {
				return <text fg={toneColor(state.data.tone)}>{state.data.text}</text>;
			}
			const now = new Date();
			const segments = state.data.segments;
			const worst = worstSegment(segments);
			const withBars = termWidth() >= NARROW_WIDTH;
			return (
				<box flexDirection="row" flexShrink={0}>
					<text fg={toneColor(worstTone(segments))}>⚡ </text>
					<For each={segments}>
						{(seg, index) => {
							const tone = segmentTone(seg.percent);
							const parts = barParts(seg.percent, FOOTER_BAR_WIDTH);
							return (
								<>
									{index() > 0 ? <text fg={color.muted}> · </text> : null}
									{withBars ? (
										<>
											<text fg={toneColor(tone)}>{parts.filled}</text>
											<text fg={color.muted}>{parts.empty} </text>
										</>
									) : null}
									<text fg={toneColor(tone)}>
										{seg.label} {seg.percent}%
									</text>
									{seg === worst && seg.delta ? (
										<text fg={color.muted}> {fmtDelta(seg.delta)}%</text>
									) : null}
								</>
							);
						}}
					</For>
					{worst?.reset && worst.percent > 0 ? (
						<text fg={color.muted}> →{formatReset(worst.reset, now)}</text>
					) : null}
				</box>
			);
		}

		// --- dialog ----------------------------------------------------------------

		/** One window as a coloured progress-bar row. */
		function BarRow(props: { seg: UsageSegment }): JSX.Element {
			const now = new Date();
			const parts = barParts(props.seg.percent, BAR_WIDTH);
			const tone = segmentTone(props.seg.percent);
			const percent = `${String(props.seg.percent).padStart(3)}%`;
			return (
				<box flexDirection="row">
					<text fg={color.base}>{`${props.seg.label.padEnd(4)} `}</text>
					<text fg={toneColor(tone)}>{parts.filled}</text>
					<text fg={color.muted}>{parts.empty}</text>
					<text fg={toneColor(tone)}>{` ${percent}`}</text>
					{props.seg.delta ? (
						<text fg={color.muted}>{` ${fmtDelta(props.seg.delta)}%`}</text>
					) : null}
					{props.seg.status ? <text fg={color.warning}>{` ⚠${props.seg.status}`}</text> : null}
					{props.seg.note ? <text fg={color.muted}>{` ${props.seg.note}`}</text> : null}
					<text fg={color.muted}>{` ${resetSuffix(props.seg, now)}`}</text>
				</box>
			);
		}

		function trendLine(state: ProviderState): string | undefined {
			if (!state.ok || state.data.kind !== "percent") return undefined;
			const parts: string[] = [];
			for (const seg of state.data.segments) {
				if (!seg.delta) continue;
				let part = `${seg.label} ${fmtDelta(seg.delta)}%`;
				if (seg.etaMs !== undefined) part += `（按当前速率 ~${formatDuration(seg.etaMs / 1000)}后用满）`;
				parts.push(part);
			}
			return parts.length ? parts.join(" · ") : undefined;
		}

		/** Detailed block for the single-provider view. */
		function DetailBlock(props: { def: ProviderDef; state: ProviderState }): JSX.Element {
			const failure = () => (props.state.ok ? undefined : props.state);
			const percent = () => (props.state.ok && props.state.data.kind === "percent" ? props.state.data : undefined);
			const balance = () => (props.state.ok && props.state.data.kind === "balance" ? props.state.data : undefined);
			const extras = () => (props.state.ok ? props.state.data.detailLines : []);
			const updatedAt = () => (props.state.ok ? stamp(new Date(props.state.fetchedAt)) : undefined);
			return (
				<box flexDirection="column">
					<text fg={color.base}>{props.state.ok ? props.state.data.title : `${props.def.title} — ✗`}</text>
					<Show when={percent()}>
						{(data) => (
							<box flexDirection="column">
								<For each={data().segments}>{(seg) => <BarRow seg={seg} />}</For>
							</box>
						)}
					</Show>
					<Show when={balance()}>
						{(data) => <text fg={toneColor(data().tone)}>{data().text}</text>}
					</Show>
					<For each={extras()}>{(line) => <text fg={color.muted}>· {line}</text>}</For>
					<Show when={trendLine(props.state)}>
						{(line) => <text fg={color.muted}>· 趋势 {line()}</text>}
					</Show>
					<Show when={failure()}>
						{(fail) => (
							<text fg={color.error}>
								✗ {failureLabel(fail())} — {fail().error}
							</text>
						)}
					</Show>
					<Show when={updatedAt()}>
						{(stampText) => <text fg={color.muted}>更新于 {stampText()}</text>}
					</Show>
				</box>
			);
		}

		/** One aligned line for the `/quota all` view. */
		function SummaryRow(props: { def: ProviderDef; state: ProviderState }): JSX.Element {
			const summary = (): { text: string; tone: "success" | "warning" | "error" } => {
				const state = props.state;
				if (!state.ok) return { text: `✗ ${failureLabel(state)}`, tone: "error" };
				if (state.data.kind === "balance") return { text: state.data.text, tone: state.data.tone };
				return {
					text: state.data.segments
						.map((seg) => `${seg.label} ${seg.percent}%${seg.delta ? `(${fmtDelta(seg.delta)}%)` : ""}`)
						.join(" · "),
					tone: worstTone(state.data.segments),
				};
			};
			const row = summary();
			return (
				<box flexDirection="row" gap={1}>
					<text fg={color.muted}>{props.def.name.padEnd(NAME_WIDTH)}</text>
					<text fg={toneColor(row.tone)}>{row.text}</text>
				</box>
			);
		}

		function Details(props: { onlyName?: string; sessionID?: string }): JSX.Element {
			const visible = () => {
				const snapshot = snap();
				return defs
					.filter((def) => (props.onlyName ? def.name === props.onlyName : true))
					.map((def) => ({ def, state: snapshot.providers[def.name] }))
					.filter((entry): entry is { def: ProviderDef; state: ProviderState } => entry.state !== undefined);
			};
			const emptyHint = () =>
				props.onlyName
					? "当前提供商未配置 API Key，或暂无对应的用量查询接口"
					: "暂无数据：没有发现已配置 key 的提供商（/connect 连接后再试）";
			const sessionCost = () => {
				costTick(); // re-read after the open-time sync lands
				if (!props.sessionID) return undefined;
				const cost = context.data.session.cost(props.sessionID);
				return Number.isFinite(cost) && cost > 0 ? `本会话成本 $${cost.toFixed(3)}` : undefined;
			};
			return (
				<box
					flexDirection="column"
					paddingLeft={2}
					paddingRight={2}
					paddingTop={1}
					paddingBottom={1}
					gap={1}
					backgroundColor={theme.background.base}
				>
					<box flexDirection="row" gap={1}>
						<text fg={color.base}>模型额度明细</text>
						<text fg={color.muted}>· /quota all 查看全部</text>
					</box>
					<Show when={visible().length > 0} fallback={<text fg={color.muted}>{emptyHint()}</text>}>
						<For each={visible()}>
							{(entry) =>
								props.onlyName ? (
									<DetailBlock def={entry.def} state={entry.state} />
								) : (
									<SummaryRow def={entry.def} state={entry.state} />
								)
							}
						</For>
					</Show>
					<Show when={sessionCost()}>{(line) => <text fg={color.muted}>{line()}</text>}</Show>
					<text fg={color.muted}>更新于 {stamp(new Date(snap().updatedAt))}</text>
				</box>
			);
		}

		function openDetails(onlyName?: string, sessionID?: string): void {
			if (disposed) return;
			// Session cost is only accurate after the store synced; re-render
			// once it lands so the line can appear.
			if (sessionID) {
				void context.data.session
					.sync(sessionID)
					.then(() => setCostTick((tick) => tick + 1))
					.catch(() => {});
			}
			context.ui.dialog.set({ size: "large", centered: true });
			context.ui.dialog.show(() => <Details onlyName={onlyName} sessionID={sessionID} />);
		}

		async function handleQuota(input?: string): Promise<void> {
			if (disposed) return;
			const all = (input ?? "").trim().toLowerCase() === "all";
			const result = await withTimeout(usage.refresh(all ? { all: true } : {}), REFRESH_TIMEOUT_MS);
			if (result) applySnapshot((result as { snapshot?: unknown })?.snapshot);
			openDetails(all ? undefined : activeDef()?.name, currentSessionID());
		}

		// --- slots ---------------------------------------------------------------

		const statusSlot = (sessionID?: string) => {
			const state = () => {
				const def = activeDef();
				return def ? snap().providers[def.name] : undefined;
			};
			return (
				<Show when={state()}>
					{(value) => (
						<box
							flexShrink={0}
							paddingLeft={1}
							onMouseUp={() => openDetails(activeDef()?.name, sessionID)}
						>
							{statusText(value())}
						</box>
					)}
				</Show>
			);
		};

		const disposePrompt = context.ui.slot({
			append: "prompt.footer.status",
			render: (input) => statusSlot(input.sessionID),
		});
		const disposeHome = context.ui.slot({
			append: "home.footer.status",
			render: () => statusSlot(),
		});

		// --- commands ------------------------------------------------------------

		context.keymap.layer(() => ({
			mode: "global",
			commands: [
				{
					id: "isword.provider-usage.show",
					title: "Show provider usage",
					group: "Provider Usage",
					palette: true,
					slash: { name: "quota", aliases: ["balance"], arguments: true },
					run: (input) => {
						void handleQuota(input);
					},
				},
			],
		}));

		return () => {
			disposed = true;
			clearInterval(safetyPoll);
			try {
				context.renderer.off("resize", onResize);
			} catch {
				// Listener was never attached.
			}
			unsubscribe?.();
			disposePrompt();
			disposeHome();
		};
	},
});
