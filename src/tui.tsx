/** @jsxImportSource @opentui/solid */
/**
 * opencode-provider-usage — TUI plugin.
 *
 * Renders the active provider's usage/balance in the footer status row and
 * opens a detail dialog on click or `/quota`. All data comes from the server
 * plugin over RPC (`isword.provider-usage`); this plugin never touches
 * credentials or the network.
 */

import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal, type JSX } from "solid-js";
import { formatDuration, formatReset, fmtDelta, stamp } from "./format.js";
import { matchProvider, providerDefs } from "./providers.js";
import { ProviderUsage } from "./rpc.js";
import type { ProviderState, Snapshot, UsageSegment } from "./types.js";
import { EMPTY_SNAPSHOT } from "./types.js";

const FAILURE_LABELS: Record<string, string> = {
	no_key: "无key",
	auth: "key无效",
	rate_limit: "限流退避中",
	empty: "查询失败",
	network: "查询失败",
};

function segmentTone(percent: number): "success" | "warning" | "error" {
	return percent >= 85 ? "error" : percent >= 60 ? "warning" : "success";
}

export default Plugin.define({
	id: "isword.provider-usage.tui",
	setup(context) {
		const defs = providerDefs();
		const usage = context.client.rpc(ProviderUsage);
		const [snap, setSnap] = createSignal<Snapshot>(EMPTY_SNAPSHOT);

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

		const load = async () => {
			try {
				const result = (await usage.get({})) as { snapshot: Snapshot };
				setSnap(result.snapshot);
			} catch {
				// Server plugin not ready yet; the event stream will catch up.
			}
		};
		void load();
		const unsubscribe = usage.events.on("updated", (event) => {
			setSnap(event.data.snapshot as Snapshot);
		});

		// --- helpers -------------------------------------------------------------

		const activeProviderID = () => context.ui.model.current()?.providerID;
		const activeDef = () => matchProvider(defs, { providerID: activeProviderID() });
		const currentSessionID = (): string | undefined => {
			const route = context.ui.router.current();
			return route.type === "session" ? route.sessionID : undefined;
		};

		function statusText(state: ProviderState): JSX.Element {
			if (!state.ok) {
				return <text fg={color.muted}>⚡ {FAILURE_LABELS[state.code] ?? "查询失败"}</text>;
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
				if (seg.etaMs && Number.isFinite(seg.etaMs)) {
					part += `（按当前速率 ~${formatDuration(seg.etaMs / 1000)}后用满）`;
				}
				parts.push(part);
			}
			return parts.length ? `• 趋势: ${parts.join(" · ")}` : undefined;
		}

		interface Block {
			title: string;
			lines: string[];
		}

		function detailBlocks(snapshot: Snapshot, onlyName?: string): Block[] {
			const blocks: Block[] = [];
			for (const def of defs) {
				if (onlyName && def.name !== onlyName) continue;
				const state = snapshot.providers[def.name];
				if (!state) continue;
				if (!state.ok) {
					blocks.push({
						title: `${def.title} — ✗`,
						lines: [`• ${FAILURE_LABELS[state.code] ?? "查询失败"}: ${state.error}`],
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
				return cost > 0 ? `• 本会话成本 $${cost.toFixed(3)}` : undefined;
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
			context.ui.dialog.set({ size: "large", centered: true });
			context.ui.dialog.show(() => <Details onlyName={onlyName} sessionID={sessionID} />);
		}

		async function handleQuota(input?: string): Promise<void> {
			const all = (input ?? "").trim().toLowerCase() === "all";
			try {
				const result = (await usage.refresh(all ? { all: true } : {})) as { snapshot: Snapshot };
				setSnap(result.snapshot);
			} catch {
				// Keep the cached snapshot and show what we have.
			}
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
						<box flexShrink={0} paddingLeft={1} onMouseUp={() => openDetails(activeDef()?.name, sessionID)}>
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
			unsubscribe();
			disposePrompt();
			disposeHome();
		};
	},
});
