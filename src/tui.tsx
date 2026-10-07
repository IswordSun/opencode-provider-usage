/** @jsxImportSource @opentui/solid */
/**
 * opencode-provider-usage — TUI plugin.
 *
 * Renders the active provider's usage/balance in the footer status row and
 * opens a detail dialog on click or `/quota`. All data comes from the server
 * plugin over RPC (`isword.provider-usage`); this plugin never touches
 * credentials or the network.
 *
 * Robustness: every RPC payload is re-validated through `parseSnapshot`
 * before it reaches the render tree, the initial fetch retries with backoff
 * while the server plugin is still starting, `/quota` refreshes are bounded
 * by a timeout, and all subscriptions are torn down on cleanup.
 */

import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal, type JSX } from "solid-js";
import { formatDuration, formatReset, fmtDelta, stamp } from "./format.js";
import { matchProvider, providerDefs } from "./providers.js";
import { ProviderUsage } from "./rpc.js";
import type { ProviderFailure, ProviderState, Snapshot } from "./types.js";
import { EMPTY_SNAPSHOT } from "./types.js";
import { parseSnapshot } from "./validate.js";

const INITIAL_LOAD_ATTEMPTS = 10;
const REFRESH_TIMEOUT_MS = 15_000;

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

function failureLabel(state: ProviderFailure): string {
	if (state.code === "rate_limit" && state.retryAt) {
		const remainingMs = Date.parse(state.retryAt) - Date.now();
		if (Number.isFinite(remainingMs) && remainingMs > 0) {
			return `限流退避中 ${formatDuration(remainingMs / 1000)}`;
		}
	}
	return FAILURE_LABELS[state.code] ?? "查询失败";
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

		// --- state ---------------------------------------------------------------

		const applySnapshot = (input: unknown): void => {
			if (disposed) return;
			setSnap(parseSnapshot(input));
		};

		// The server plugin may register its RPC slightly after the TUI starts;
		// retry with backoff instead of giving up on the first failure.
		void (async () => {
			for (let attempt = 0; attempt < INITIAL_LOAD_ATTEMPTS && !disposed; attempt++) {
				try {
					const result = (await usage.get({})) as { snapshot?: unknown };
					applySnapshot(result?.snapshot);
					return;
				} catch {
					await sleep(Math.min(500 * 2 ** attempt, 8_000));
				}
			}
		})();

		let unsubscribe: (() => void) | undefined;
		try {
			unsubscribe = usage.events.on("updated", (event) => applySnapshot(event.data?.snapshot));
		} catch {
			// RPC not registered yet; the retry loop above will populate state.
		}

		// --- helpers -------------------------------------------------------------

		const activeProviderID = () => context.ui.model.current()?.providerID;
		const activeDef = () => matchProvider(defs, { providerID: activeProviderID() });
		const currentSessionID = (): string | undefined => {
			const route = context.ui.router.current();
			return route.type === "session" ? route.sessionID : undefined;
		};

		function statusText(state: ProviderState): JSX.Element {
			if (!state.ok) {
				return <text fg={color.muted}>⚡ {failureLabel(state)}</text>;
			}
			const data = state.data;
			if (data.kind === "balance") {
				return <text fg={toneColor(data.tone)}>{data.text}</text>;
			}
			const now = new Date();
			return (
				<box flexDirection="row" flexShrink={0}>
					<text fg={color.muted}>⚡ </text>
					<For each={data.segments}>
						{(seg, index) => (
							<>
								{index() > 0 ? <text fg={color.muted}> </text> : null}
								<text fg={toneColor(segmentTone(seg.percent))}>
									{seg.label}:{seg.percent}%
								</text>
								{seg.delta ? <text fg={color.muted}>({fmtDelta(seg.delta)}%)</text> : null}
								{seg.reset ? <text fg={color.muted}>→{formatReset(seg.reset, now)}</text> : null}
							</>
						)}
					</For>
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
			return parts.length ? `• 趋势: ${parts.join(" · ")}` : undefined;
		}

		interface Block {
			title: string;
			lines: string[];
		}

		/** One-line summary used by the compact `/quota all` view. */
		function summaryLine(state: ProviderState): string {
			if (!state.ok) return `✗ ${failureLabel(state)}`;
			if (state.data.kind === "balance") return state.data.text;
			return state.data.segments
				.map((seg) => `${seg.label} ${seg.percent}%${seg.delta ? `(${fmtDelta(seg.delta)}%)` : ""}`)
				.join(" · ");
		}

		function detailBlocks(snapshot: Snapshot, onlyName?: string): Block[] {
			const blocks: Block[] = [];
			for (const def of defs) {
				if (onlyName && def.name !== onlyName) continue;
				const state = snapshot.providers[def.name];
				if (!state) continue;

				// The "all" view stays one line per provider so the dialog fits
				// whatever height the host gives it; the single-provider view
				// keeps the full detail lines.
				if (!onlyName) {
					blocks.push({ title: def.title, lines: [summaryLine(state)] });
					continue;
				}
				if (!state.ok) {
					blocks.push({
						title: `${def.title} — ✗`,
						lines: [`• ${failureLabel(state)}: ${state.error}`],
					});
					continue;
				}
				const lines = [...state.data.detailLines];
				const trend = trendLine(state);
				if (trend) lines.push(trend);
				lines.push(`• 更新于 ${stamp(new Date(state.fetchedAt))}`);
				blocks.push({ title: state.data.title, lines });
			}
			return blocks;
		}

		function Details(props: { onlyName?: string; sessionID?: string }): JSX.Element {
			const blocks = () => {
				const list = detailBlocks(snap(), props.onlyName);
				if (list.length) return list;
				return [{ title: "模型额度", lines: ["• 暂无数据（等待首次刷新或检查 API Key）"] }];
			};
			const sessionCost = () => {
				if (!props.sessionID) return undefined;
				const cost = context.data.session.cost(props.sessionID);
				return Number.isFinite(cost) && cost > 0 ? `• 本会话成本 $${cost.toFixed(3)}` : undefined;
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
					<text fg={color.base}>模型额度明细</text>
					<For each={blocks()}>
						{(block) => (
							<box flexDirection="column">
								<text fg={color.muted}>{block.title}</text>
								<For each={block.lines}>{(line) => <text fg={color.base}>{line}</text>}</For>
							</box>
						)}
					</For>
					<Show when={sessionCost()}>{(line) => <text fg={color.base}>{line()}</text>}</Show>
					<text fg={color.muted}>
						更新于 {stamp(new Date(snap().updatedAt))} · /quota all 查看全部
					</text>
				</box>
			);
		}

		function openDetails(onlyName?: string, sessionID?: string): void {
			if (disposed) return;
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
			unsubscribe?.();
			disposePrompt();
			disposeHome();
		};
	},
});
