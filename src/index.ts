/**
 * opencode-provider-usage — server plugin.
 *
 * Owns credential resolution and network access, refreshes account-level
 * usage/balance for every supported provider, and exposes the result over RPC
 * to the TUI plugin (and any other client).
 *
 * Providers: opencode/opencode-go, deepseek, stepfun, zai/zhipu, openai-codex.
 *
 * Credentials resolve through the integration API first
 * (`ctx.integration.connection.active` + `resolve`), then environment
 * variables, then the legacy `auth.json`. 429 responses back off exponentially
 * per provider (10 min base, doubling to 60 min); other failures are surfaced
 * explicitly instead of reusing stale data.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { providerDefs, type ProviderDef } from "./providers.js";
import { ProviderUsage } from "./rpc.js";
import type {
	FailureCode,
	PercentUsage,
	ProviderState,
	Snapshot,
	UsageData,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 120_000;
const TURN_THROTTLE_MS = 5_000;
const RATE_LIMIT_BASE_MS = 10 * 60_000;
const RATE_LIMIT_MAX_MS = 60 * 60_000;
const FETCH_ATTEMPTS = 2;

const SAMPLES_TTL_MS = 3_600_000;
const SAMPLE_MAX = 60;
const SAMPLE_MIN_INTERVAL_MS = 60_000;
const TREND_MIN_SPAN_MS = 5 * 60_000;
const RESET_DROP_THRESHOLD = 25;

const AUTH_PATH = join(homedir(), ".local/share/opencode/auth.json");

interface UsageSample {
	p: number;
	t: number;
}

type SampleMap = Record<string, UsageSample[]>;

interface AuthEntry {
	key?: string;
}

function statusOf(err: unknown): number | undefined {
	const status = (err as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLegacyAuth(): Record<string, AuthEntry> | undefined {
	try {
		return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, AuthEntry>;
	} catch {
		return undefined;
	}
}

export default Plugin.define({
	id: "isword.provider-usage",
	async setup(ctx) {
		const defs = providerDefs();
		const defsByName = new Map(defs.map((def) => [def.name, def]));
		const states = new Map<string, ProviderState>();
		const lastGood = new Map<string, Extract<ProviderState, { ok: true }>>();
		const strikes = new Map<string, number>();
		const rateLimitedUntil = new Map<string, number>();
		let samples: SampleMap = {};

		const abort = new AbortController();
		let pollTimer: ReturnType<typeof setInterval> | undefined;
		let refreshTask: Promise<Snapshot> | undefined;
		let lastRefreshAt = 0;
		let lastSaveAt = 0;

		// --- persistence ---------------------------------------------------------

		try {
			const stored = (await ctx.storage.get("samples")) as SampleMap | undefined;
			if (stored && typeof stored === "object") samples = stored;
		} catch {
			// Corrupt or absent samples are not fatal.
		}

		function saveSamples(): void {
			const value: SampleMap = {};
			for (const [key, list] of Object.entries(samples)) if (list.length) value[key] = list;
			void ctx.storage.set("samples", value as never).catch(() => {});
			lastSaveAt = Date.now();
		}

		function noteSamplesChanged(): void {
			if (Date.now() - lastSaveAt < 30_000) return;
			saveSamples();
		}

		function recordSamples(provider: string, data: UsageData): void {
			if (data.kind !== "percent") return;
			const now = Date.now();
			for (const seg of data.segments) {
				const key = `${provider}:${seg.label}`;
				let list = samples[key];
				if (!list) {
					list = [];
					samples[key] = list;
				}
				const last = list[list.length - 1];
				if (last && seg.percent < last.p - RESET_DROP_THRESHOLD) list.length = 0;
				if (list.length && now - list[list.length - 1].t < SAMPLE_MIN_INTERVAL_MS) continue;
				list.push({ p: seg.percent, t: now });
				while (list.length && now - list[0].t > SAMPLES_TTL_MS) list.shift();
				while (list.length > SAMPLE_MAX) list.shift();
			}
		}

		function trendFor(provider: string, label: string): { delta: number; etaMs?: number } {
			const list = samples[`${provider}:${label}`];
			if (!list || list.length < 2) return { delta: 0 };
			const now = Date.now();
			const oldest = list[0];
			const spanMs = now - oldest.t;
			if (spanMs < TREND_MIN_SPAN_MS) return { delta: 0 };
			const latest = list[list.length - 1].p;
			const delta = latest - oldest.p;
			const ratePerHour = delta / (spanMs / 3_600_000);
			const etaMs =
				ratePerHour > 0 ? ((100 - latest) / ratePerHour) * 3_600_000 : Number.POSITIVE_INFINITY;
			return { delta, etaMs: etaMs <= 7 * 86_400_000 ? etaMs : undefined };
		}

		function withTrend(provider: string, data: PercentUsage): PercentUsage {
			return {
				...data,
				segments: data.segments.map((seg) => {
					const trend = trendFor(provider, seg.label);
					return { ...seg, delta: trend.delta, etaMs: trend.etaMs };
				}),
			};
		}

		// --- credentials ---------------------------------------------------------

		async function resolveKey(def: ProviderDef): Promise<string | undefined> {
			for (const id of def.integrationIDs) {
				try {
					const connection = await ctx.integration.connection.active(id);
					if (!connection) continue;
					const credential = await ctx.integration.connection.resolve(connection);
					if (!credential) continue;
					if (credential.type === "key") return credential.key;
					if (credential.type === "oauth") return credential.access;
				} catch {
					// Integration id not registered — try the next candidate.
				}
			}
			for (const name of def.envKeys) {
				const value = process.env[name];
				if (value) return value;
			}
			const legacy = readLegacyAuth();
			for (const id of def.authIDs) {
				const value = legacy?.[id]?.key;
				if (typeof value === "string" && value) return value;
			}
			return undefined;
		}

		// --- fetching ------------------------------------------------------------

		async function fetchWithRetry(
			def: ProviderDef,
			key: string,
		): Promise<UsageData | undefined> {
			let lastError: unknown;
			for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
				const controller = new AbortController();
				const onParentAbort = () => controller.abort();
				abort.signal.addEventListener("abort", onParentAbort, { once: true });
				const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
				try {
					return await def.fetch(key, controller.signal, {});
				} catch (err) {
					lastError = err;
					const status = statusOf(err);
					// Never retry an auth rejection; rate limits are handled by backoff.
					if (status === 401 || status === 403 || status === 429) break;
					if (attempt < FETCH_ATTEMPTS - 1) await sleep(500);
				} finally {
					clearTimeout(timer);
					abort.signal.removeEventListener("abort", onParentAbort);
				}
			}
			throw lastError;
		}

		function classify(err: unknown): { code: FailureCode; error: string } {
			const status = statusOf(err);
			if (status === 401 || status === 403) return { code: "auth", error: `API Key 可能已失效（HTTP ${status}）` };
			if (status === 429) return { code: "rate_limit", error: "限流退避中" };
			if (status) return { code: "network", error: `查询失败（HTTP ${status}）` };
			return { code: "network", error: "查询失败（网络异常或超时）" };
		}

		async function refreshProvider(def: ProviderDef): Promise<ProviderState> {
			const now = Date.now();
			const backoffUntil = rateLimitedUntil.get(def.name) ?? 0;
			if (now < backoffUntil) {
				const cached = lastGood.get(def.name);
				if (cached) {
					states.set(def.name, cached);
					return cached;
				}
				return {
					ok: false,
					code: "rate_limit",
					error: "限流退避中",
					fetchedAt: new Date(now).toISOString(),
					retryAt: new Date(backoffUntil).toISOString(),
				};
			}

			let key: string | undefined;
			try {
				key = await resolveKey(def);
			} catch {
				key = undefined;
			}
			if (abort.signal.aborted) return { ok: false, code: "no_key", error: "已停止", fetchedAt: new Date().toISOString() };
			if (!key) {
				const failure: ProviderState = {
					ok: false,
					code: "no_key",
					error: "未配置 API Key",
					fetchedAt: new Date().toISOString(),
				};
				states.set(def.name, failure);
				return failure;
			}

			try {
				const raw = await fetchWithRetry(def, key);
				if (!raw) {
					const failure: ProviderState = {
						ok: false,
						code: "empty",
						error: "接口返回为空",
						fetchedAt: new Date().toISOString(),
					};
					states.set(def.name, failure);
					return failure;
				}
				strikes.delete(def.name);
				rateLimitedUntil.delete(def.name);
				const data = raw.kind === "percent" ? withTrend(def.name, raw) : raw;
				recordSamples(def.name, data);
				noteSamplesChanged();
				const success: ProviderState = { ok: true, data, fetchedAt: new Date().toISOString() };
				states.set(def.name, success);
				lastGood.set(def.name, success);
				return success;
			} catch (err) {
				const status = statusOf(err);
				if (status === 429) {
					const count = (strikes.get(def.name) ?? 0) + 1;
					strikes.set(def.name, count);
					rateLimitedUntil.set(
						def.name,
						Date.now() + Math.min(RATE_LIMIT_BASE_MS * 2 ** (count - 1), RATE_LIMIT_MAX_MS),
					);
				}
				const { code, error } = classify(err);
				const cached = lastGood.get(def.name);
				if (cached) {
					states.set(def.name, cached);
					return cached;
				}
				const failure: ProviderState = {
					ok: false,
					code,
					error,
					fetchedAt: new Date().toISOString(),
				};
				states.set(def.name, failure);
				return failure;
			}
		}

		function snapshot(): Snapshot {
			const providers: Record<string, ProviderState> = {};
			for (const def of defs) {
				const state = states.get(def.name);
				if (state) providers[def.name] = state;
			}
			// Round-trip so optional `undefined` fields never reach the RPC
			// encoder (which only accepts JSON values).
			return JSON.parse(
				JSON.stringify({ updatedAt: new Date().toISOString(), providers }),
			) as Snapshot;
		}

		async function doRefresh(): Promise<Snapshot> {
			await Promise.all(defs.map((def) => refreshProvider(def)));
			const next = snapshot();
			void ctx.storage.set("snapshot", next as never).catch(() => {});
			void registration.events.emit("updated", { snapshot: next }).catch(() => {});
			lastRefreshAt = Date.now();
			return next;
		}

		function refresh(force: boolean): Promise<Snapshot> {
			if (refreshTask) return refreshTask;
			if (!force && Date.now() - lastRefreshAt < TURN_THROTTLE_MS) {
				return Promise.resolve(snapshot());
			}
			refreshTask = doRefresh().finally(() => {
				refreshTask = undefined;
			});
			return refreshTask;
		}

		// --- RPC -----------------------------------------------------------------

		const registration = await ctx.rpc.register(ProviderUsage, {
			get: async () => ({ snapshot: snapshot() }),
			refresh: async () => ({ snapshot: await refresh(true) }),
		});

		// --- lifecycle -----------------------------------------------------------

		pollTimer = setInterval(() => void refresh(false), POLL_INTERVAL_MS);

		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
					const type = event.type;
					if (type === "session.idle" || type === "session.execution.succeeded") {
						void refresh(false);
					} else if (type === "credential.updated" || type === "credential.switched") {
						void refresh(true);
					}
				}
			} catch {
				// Stream aborted during shutdown.
			}
		})();

		// Warm the cache immediately; the RPC already works and `get` returns an
		// empty snapshot until the first round finishes.
		void refresh(true);

		return async () => {
			abort.abort();
			if (pollTimer) clearInterval(pollTimer);
			await registration.dispose();
			saveSamples();
		};
	},
});
