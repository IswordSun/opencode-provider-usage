/** @jsxImportSource @opentui/solid */
/**
 * opencode-provider-usage — TUI plugin.
 *
 * Renders the active provider's usage/balance in the sidebar footer and
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
import { barParts, cells, formatDuration, formatReset, fmtDelta, padCells, stamp, trimToCells } from "./format.js";
import { matchProvider, providerDefs, type ProviderDef } from "./providers.js";
import { ProviderUsage } from "./rpc.js";
import type { ProviderFailure, ProviderState, Snapshot, Tone, UsageSegment } from "./types.js";
import { EMPTY_SNAPSHOT } from "./types.js";
import { parseSnapshot } from "./validate.js";

const INITIAL_LOAD_ATTEMPTS = 10;
const REFRESH_TIMEOUT_MS = 15_000;
/** Safety re-pull cadence in case `updated` events were missed. */
const SAFETY_POLL_MS = 120_000;
const BAR_WIDTH = 20;
/** Width of the mini bars in the sidebar block. */
const SIDEBAR_BAR_WIDTH = 10;
const NAME_WIDTH = 12;
/** Usable cell width of the large detail dialog body (60-col frame minus padding). */
const BUDGET_CELLS = 56;

const FAILURE_LABELS: Record<string, string> = {
	no_key: "no key",
	auth: "invalid key",
	rate_limit: "backing off",
	empty: "fetch failed",
	network: "fetch failed",
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
			return `backing off ${formatDuration(remainingMs / 1000)}`;
		}
	}
	return FAILURE_LABELS[state.code] ?? "fetch failed";
}

/** The window that binds hardest right now (highest percent). */
function worstSegment(segments: readonly UsageSegment[]): UsageSegment | undefined {
	let worst: UsageSegment | undefined;
	for (const seg of segments) {
		if (!worst || seg.percent > worst.percent) worst = seg;
	}
	return worst;
}

/** `→ 21:40 (3h left)`; caller prefixes the separator space. */
function resetSuffix(seg: UsageSegment, now: Date): string {
	if (!seg.reset) return "";
	const time = formatReset(seg.reset, now);
	const remainingMs = Date.parse(seg.reset) - now.getTime();
	if (Number.isFinite(remainingMs) && remainingMs > 0) {
		return `→ ${time} (${formatDuration(remainingMs / 1000)} left)`;
	}
	return `→ ${time}`;
}

/**
 * Usage gradient palettes. Six steps from "plenty left" to "exhausted"; a
 * light-theme set keeps contrast on pale backgrounds. Reset countdowns get a
 * cyan accent and trend deltas point up (hot) / down (cool).
 */
const USAGE_STEPS = [15, 30, 45, 60, 75, 90, 101] as const;
const DARK_PALETTE = {
	usage: ["#4ade80", "#a3e635", "#eab308", "#f59e0b", "#fb923c", "#ef4444"],
	tone: { success: "#4ade80", warning: "#facc15", error: "#f87171" } as Record<Tone, string>,
	reset: "#22d3ee",
	deltaUp: "#fb923c",
	deltaDown: "#4ade80",
};
const LIGHT_PALETTE = {
	usage: ["#16a34a", "#65a30d", "#ca8a04", "#d97706", "#ea580c", "#dc2626"],
	tone: { success: "#16a34a", warning: "#ca8a04", error: "#dc2626" } as Record<Tone, string>,
	reset: "#0891b2",
	deltaUp: "#ea580c",
	deltaDown: "#16a34a",
};
type Palette = typeof DARK_PALETTE;

function usageColor(percent: number, palette: Palette): string {
	for (let i = 0; i < USAGE_STEPS.length; i++) {
		if (percent < USAGE_STEPS[i]) return palette.usage[i];
	}
	return palette.usage[palette.usage.length - 1];
}

export default Plugin.define({
	id: "isword.provider-usage.tui",
	setup(context) {
		const defs = providerDefs();
		const usage = context.client.rpc(ProviderUsage);
		const [snap, setSnap] = createSignal<Snapshot>(EMPTY_SNAPSHOT);
		let disposed = false;

		const theme = context.theme;
		const palette: Palette =
			(context as unknown as { themeMode?: unknown }).themeMode === "light" ? LIGHT_PALETTE : DARK_PALETTE;
		const color = {
			base: theme.text.base,
			muted: theme.text.muted,
		};
		const toneColor = (tone: Tone) => palette.tone[tone];
		const barColor = (percent: number) => usageColor(percent, palette);

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

		// --- sidebar ----------------------------------------------------------------

		/** Compact quota block for the sidebar: one mini bar row per window. */
		function SidebarRows(state: ProviderState): JSX.Element {
			if (!state.ok) {
				return <text fg={toneColor("error")}>⚡ {failureLabel(state)}</text>;
			}
			if (state.data.kind === "balance") {
				return <text fg={toneColor(state.data.tone)}>{state.data.text}</text>;
			}
			const now = new Date();
			const segments = state.data.segments;
			const worst = worstSegment(segments);
			return (
				<box flexDirection="column">
					<For each={segments}>
						{(seg) => {
							const parts = barParts(seg.percent, SIDEBAR_BAR_WIDTH);
							const fill = barColor(seg.percent);
							return (
								<box flexDirection="row" flexWrap="no-wrap">
									<text fg={color.muted} flexShrink={0}>{padCells(seg.label, 3)} </text>
									{parts.filled ? <text fg={fill} flexShrink={0}>{parts.filled}</text> : null}
									{parts.empty ? <text fg={color.muted} flexShrink={0}>{parts.empty}</text> : null}
									<text fg={fill} flexShrink={0}>{` ${String(seg.percent).padStart(3)}%`}</text>
								</box>
							);
						}}
					</For>
					{worst?.reset && worst.percent > 0 ? (
						<text fg={palette.reset}> {resetSuffix(worst, now)}</text>
					) : null}
				</box>
			);
		}

		// --- dialog ----------------------------------------------------------------

		/**
		 * One window as a coloured progress-bar row pair. Column widths
		 * (label, bar, percent) come from the parent so every window of the
		 * provider lines up on identical columns; the sub line carries the
		 * credits note and trend delta.
		 */
		function BarRow(props: { seg: UsageSegment; labelWidth: number; barWidth: number; budget: number }): JSX.Element {
			const now = new Date()
			const percentText = ` ${String(props.seg.percent).padStart(3)}%`
			const resetText = resetSuffix(props.seg, now)
			const noteText = props.seg.note
			const deltaText = props.seg.delta !== undefined ? `${fmtDelta(props.seg.delta)}%` : undefined
			const labelText = `${padCells(props.seg.label, props.labelWidth)} `

			const parts = barParts(props.seg.percent, props.barWidth)
			const fill = barColor(props.seg.percent)
			const deltaFg = (props.seg.delta ?? 0) > 0 ? palette.deltaUp : palette.deltaDown
			return (
				<box flexDirection="column">
					<box flexDirection="row" flexWrap="no-wrap">
						<text fg={color.base} flexShrink={0}>{labelText}</text>
						{parts.filled ? <text fg={fill} flexShrink={0}>{parts.filled}</text> : null}
						{parts.empty ? <text fg={color.muted} flexShrink={0}>{parts.empty}</text> : null}
						<text fg={fill} flexShrink={0}>{percentText}</text>
						{resetText ? <text fg={palette.reset} flexShrink={0}>{` ${resetText}`}</text> : null}
						{props.seg.status ? <text fg={toneColor("warning")} flexShrink={0}>{` ⚠${props.seg.status}`}</text> : null}
					</box>
					{noteText || deltaText ? (
						<box flexDirection="row" paddingLeft={props.labelWidth + 1}>
							{noteText ? (
								<text fg={color.muted} flexShrink={0}>
									{trimToCells(noteText, Math.max(8, props.budget - props.labelWidth - 1 - (deltaText ? cells(deltaText) + 3 : 0)))}
								</text>
							) : null}
							{deltaText ? <text fg={deltaFg} flexShrink={0}>{`${noteText ? " · " : ""}${deltaText}`}</text> : null}
						</box>
					) : null}
				</box>
			)
		}

		function trendLine(state: ProviderState): string | undefined {
			if (!state.ok || state.data.kind !== "percent") return undefined;
			const parts: string[] = [];
			for (const seg of state.data.segments) {
				if (!seg.delta) continue;
				let part = `${seg.label} ${fmtDelta(seg.delta)}%`;
				if (seg.etaMs !== undefined) part += ` (full in ~${formatDuration(seg.etaMs / 1000)})`;
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
			return (
				<box flexDirection="column">
					<text fg={color.base}>{props.state.ok ? props.state.data.title : `${props.def.title} — ✗`}</text>
					<Show when={percent()}>
						{(data) => {
							const segs = data().segments
							const now = new Date()
							const labelWidth = Math.max(4, Math.min(8, ...segs.map((s) => cells(s.label))))
							const resetWidth = Math.max(0, ...segs.map((s) => cells(resetSuffix(s, now))))
							const budget = Math.max(28, Math.min(termWidth() - 12, BUDGET_CELLS))
							const barWidth = Math.max(
								6,
								Math.min(BAR_WIDTH, budget - (labelWidth + 1) - 5 - (resetWidth ? resetWidth + 1 : 0)),
							)
							return (
								<box flexDirection="column">
									<For each={segs}>
										{(seg) => <BarRow seg={seg} labelWidth={labelWidth} barWidth={barWidth} budget={budget} />}
									</For>
								</box>
							)
						}}
					</Show>
					<Show when={balance()}>
						{(data) => <text fg={toneColor(data().tone)}>{data().text}</text>}
					</Show>
					<For each={extras()}>{(line) => <text fg={color.muted}>· {trimToCells(line, BUDGET_CELLS - 2)}</text>}</For>
					<Show when={trendLine(props.state)}>
						{(line) => <text fg={color.muted}>· trend {trimToCells(line(), BUDGET_CELLS - 5)}</text>}
					</Show>
					<Show when={failure()}>
						{(fail) => (
							<text fg={toneColor("error")}>
								✗ {failureLabel(fail())} — {fail().error}
							</text>
						)}
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
					? "Current provider has no API key configured, or no usage endpoint is available for it"
					: "No data: no provider with a usable key was found (try again after /connect)";
			const sessionCost = () => {
				costTick(); // re-read after the open-time sync lands
				if (!props.sessionID) return undefined;
				const cost = context.data.session.cost(props.sessionID);
				return Number.isFinite(cost) && cost > 0 ? `session cost $${cost.toFixed(3)}` : undefined;
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
						<text fg={color.base}>Usage Details</text>
						<text fg={color.muted}>· /quota all for every provider</text>
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
					<text fg={color.muted}>updated {stamp(new Date(snap().updatedAt))}</text>
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

		const sidebarBlock = (sessionID?: string) => {
			const state = () => {
				const def = activeDef();
				return def ? snap().providers[def.name] : undefined;
			};
			return (
				<Show when={state()}>
					{(value) => {
						const def = activeDef();
						return (
							<box
								flexDirection="column"
								paddingLeft={1}
								paddingBottom={1}
								onMouseUp={() => openDetails(def?.name, sessionID)}
							>
								{def ? <text fg={color.muted} flexShrink={0}>⚡ {trimToCells(def.title, 18)}</text> : null}
								{SidebarRows(value())}
							</box>
						);
					}}
				</Show>
			);
		};

		const disposeSidebar = context.ui.slot({
			append: "sidebar.footer",
			render: (input?: { sessionID?: string }) => sidebarBlock(input?.sessionID),
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
			disposeSidebar();
		};
	},
});
