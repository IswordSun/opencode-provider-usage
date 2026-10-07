/**
 * opencode-provider-usage — server plugin.
 *
 * Owns credential resolution and network access, refreshes account-level
 * usage/balance for every supported provider, and exposes the result over RPC
 * to the TUI plugin (and any other client).
 *
 * Providers: opencode/opencode-go, deepseek, stepfun, zai/zhipu, openai-codex.
 *
 * Robustness properties:
 * - Credentials resolve through the integration API first
 *   (`ctx.integration.connection.active` + `resolve`), then environment
 *   variables, then a cached read of the legacy `auth.json`.
 * - All shared state lives in a module-level coordinator, so several plugin
 *   instances (one per location) share one polling loop instead of hammering
 *   the endpoints N times.
 * - 429 responses back off exponentially per provider (10 min base, doubling
 *   to 60 min); other failures are surfaced explicitly instead of reusing
 *   stale data. The last good result per provider is kept as a fallback.
 * - The snapshot survives restarts: it is seeded from plugin storage on the
 *   first attach, and trend samples are persisted alongside it.
 * - Every step is defensive: unexpected throws in the refresh loop are caught
 *   and logged, never propagated into opencode.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { Backoff } from "./backoff.js";
import { providerDefs, type ProviderDef } from "./providers.js";
import { ProviderUsage } from "./rpc.js";
import { SampleStore } from "./samples.js";
import type { FailureCode, PercentUsage, ProviderState, Snapshot, UsageData } from "./types.js";
import { parseSnapshot } from "./validate.js";

const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 500;
const POLL_INTERVAL_MS = 120_000;
const TURN_THROTTLE_MS = 5_000;
const FETCH_ATTEMPTS = 2;
const SAMPLES_SAVE_DEBOUNCE_MS = 30_000;
const LEGACY_AUTH_CACHE_MS = 30_000;
const MAX_LOGGED_DETAIL = 200;

const AUTH_PATH = join(homedir(), ".local/share/opencode/auth.json");

interface AuthEntry {
	key?: string;
}

interface Subscriber {
	/** Resolve a credential, or undefined when this instance cannot. */
	readonly resolveKey: (def: ProviderDef) => Promise<string | undefined>;
	/** Persist the snapshot into this instance's plugin storage. */
	readonly persist: (snapshot: Snapshot) => void;
	/** Persist trend samples into this instance's plugin storage. */
	readonly persistSamples: (data: unknown) => void;
	/** Push the snapshot to RPC listeners of this instance. */
	readonly publish: (snapshot: Snapshot) => void;
}

function log(message: string, detail?: unknown): void {
	const suffix =
		detail === undefined
			? ""
			: ` ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, MAX_LOGGED_DETAIL)}`;
	console.log(`[provider-usage] ${message}${suffix}`);
}

function statusOf(err: unknown): number | undefined {
	const status = (err as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

// --- shared coordinator (one per server process) ---------------------------

const defs = providerDefs();
const states = new Map<string, ProviderState>();
const lastGood = new Map<string, Extract<ProviderState, { ok: true }>>();
const backoff = new Backoff();
const subscribers = new Set<Subscriber>();
const loggedState = new Map<string, string>();

let samples = new SampleStore();
let abort: AbortController | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let refreshTask: Promise<Snapshot> | undefined;
let lastRefreshAt = 0;
let lastSamplesSaveAt = 0;
let seeded = false;
let snapshotCache: Snapshot = { updatedAt: new Date(0).toISOString(), providers: {} };

function rebuildSnapshot(): void {
	const providers: Record<string, ProviderState> = {};
	for (const def of defs) {
		const state = states.get(def.name);
		if (state) providers[def.name] = state;
	}
	// parseSnapshot doubles as the JSON sanitizer: it strips `undefined`
	// fields the RPC encoder would reject and re-normalizes every value.
	snapshotCache = parseSnapshot({ updatedAt: new Date().toISOString(), providers });
}

function publishSnapshot(snapshot: Snapshot): void {
	for (const subscriber of subscribers) {
		subscriber.persist(snapshot);
		subscriber.publish(snapshot);
	}
}

function logTransition(def: ProviderDef, state: ProviderState): void {
	const signature = state.ok ? `ok:${state.data.kind}` : `fail:${state.code}`;
	if (loggedState.get(def.name) === signature) return;
	loggedState.set(def.name, signature);
	if (state.ok) {
		log(`${def.name} 恢复正常`);
	} else {
		log(`${def.name} ${state.code}: ${state.error}`);
	}
}

async function resolveKeyAny(def: ProviderDef): Promise<string | undefined> {
	for (const subscriber of subscribers) {
		try {
			const key = await subscriber.resolveKey(def);
			if (key) return key;
		} catch {
			// Try the next subscriber.
		}
	}
	return undefined;
}

let legacyAuthCache: { at: number; value: Record<string, AuthEntry> | undefined } | undefined;

function readLegacyAuth(): Record<string, AuthEntry> | undefined {
	const now = Date.now();
	if (legacyAuthCache && now - legacyAuthCache.at < LEGACY_AUTH_CACHE_MS) {
		return legacyAuthCache.value;
	}
	let value: Record<string, AuthEntry> | undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
		if (typeof parsed === "object" && parsed !== null) value = parsed as Record<string, AuthEntry>;
	} catch {
		value = undefined; // Missing or corrupt file: treated as absent.
	}
	legacyAuthCache = { at: now, value };
	return value;
}

function withTrend(provider: string, data: UsageData): UsageData {
	if (data.kind !== "percent") return data;
	const segments = data.segments.map((segment) => {
		const trend = samples.trend(provider, segment.label);
		const next: PercentUsage["segments"][number] = { ...segment, delta: trend.delta };
		if (trend.etaMs !== undefined) next.etaMs = trend.etaMs;
		return next;
	});
	return { ...data, segments };
}

async function fetchUsage(def: ProviderDef, key: string): Promise<UsageData | undefined> {
	let lastError: unknown;
	for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
		if (abort?.signal.aborted) throw lastError ?? new Error("已停止");
		const controller = new AbortController();
		const onParentAbort = () => controller.abort();
		abort?.signal.addEventListener("abort", onParentAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			return await def.fetch(key, controller.signal, {});
		} catch (err) {
			lastError = err;
			const status = statusOf(err);
			// Auth rejections and rate limits are never worth retrying here.
			if (status === 401 || status === 403 || status === 429) break;
			if (attempt < FETCH_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS, abort?.signal);
		} finally {
			clearTimeout(timer);
			abort?.signal.removeEventListener("abort", onParentAbort);
		}
	}
	throw lastError;
}

function classify(err: unknown): { code: FailureCode; error: string } {
	const status = statusOf(err);
	if (status === 401 || status === 403) return { code: "auth", error: `API Key 可能已失效（HTTP ${status}）` };
	if (status === 429) return { code: "rate_limit", error: "限流退避中" };
	if (status) return { code: "network", error: `查询失败（HTTP ${status}）` };
	return { code: "network", error: `查询失败（${err instanceof Error ? err.message : "网络异常或超时"}）` };
}

async function refreshProvider(def: ProviderDef): Promise<ProviderState> {
	const previous = states.get(def.name);

	const remaining = backoff.remaining(def.name);
	if (remaining > 0) {
		const cached = lastGood.get(def.name);
		if (cached) {
			states.set(def.name, cached);
			return cached;
		}
		const failure: ProviderState = {
			ok: false,
			code: "rate_limit",
			error: "限流退避中",
			fetchedAt: new Date().toISOString(),
			retryAt: new Date(Date.now() + remaining).toISOString(),
		};
		states.set(def.name, failure);
		return failure;
	}

	const key = await resolveKeyAny(def);
	if (abort?.signal.aborted) return previous ?? { ok: false, code: "network", error: "已停止", fetchedAt: new Date().toISOString() };
	if (!key) {
		const failure: ProviderState = {
			ok: false,
			code: "no_key",
			error: "未配置 API Key",
			fetchedAt: new Date().toISOString(),
		};
		states.set(def.name, failure);
		logTransition(def, failure);
		return failure;
	}

	try {
		const raw = await fetchUsage(def, key);
		if (abort?.signal.aborted) return previous ?? { ok: false, code: "network", error: "已停止", fetchedAt: new Date().toISOString() };
		if (!raw) {
			const failure: ProviderState = {
				ok: false,
				code: "empty",
				error: "接口返回为空",
				fetchedAt: new Date().toISOString(),
			};
			states.set(def.name, failure);
			logTransition(def, failure);
			return failure;
		}
		backoff.clear(def.name);
		const data = withTrend(def.name, raw);
		samples.record(def.name, data.kind === "percent" ? data.segments : []);
		noteSamplesChanged();
		const success: ProviderState = { ok: true, data, fetchedAt: new Date().toISOString() };
		states.set(def.name, success);
		lastGood.set(def.name, success);
		logTransition(def, success);
		return success;
	} catch (err) {
		if (abort?.signal.aborted) {
			// Shutdown raced the request; keep whatever we had.
			return previous ?? { ok: false, code: "network", error: "已停止", fetchedAt: new Date().toISOString() };
		}
		const status = statusOf(err);
		if (status === 429) backoff.strike(def.name);
		const { code, error } = classify(err);
		const cached = lastGood.get(def.name);
		if (cached) {
			states.set(def.name, cached);
			return cached;
		}
		const failure: ProviderState = { ok: false, code, error, fetchedAt: new Date().toISOString() };
		const retryAt = backoff.retryAt(def.name);
		if (retryAt) failure.retryAt = retryAt;
		states.set(def.name, failure);
		logTransition(def, failure);
		return failure;
	}
}

function noteSamplesChanged(): void {
	if (Date.now() - lastSamplesSaveAt < SAMPLES_SAVE_DEBOUNCE_MS) return;
	lastSamplesSaveAt = Date.now();
	for (const subscriber of subscribers) subscriber.persistSamples(samples.toJSON());
}

async function doRefresh(): Promise<Snapshot> {
	try {
		await Promise.all(defs.map((def) => refreshProvider(def)));
	} catch (err) {
		log("刷新循环异常", err instanceof Error ? err.message : err);
	}
	rebuildSnapshot();
	publishSnapshot(snapshotCache);
	lastRefreshAt = Date.now();
	return snapshotCache;
}

function refresh(force: boolean): Promise<Snapshot> {
	if (refreshTask) return refreshTask;
	if (!force && Date.now() - lastRefreshAt < TURN_THROTTLE_MS) {
		return Promise.resolve(snapshotCache);
	}
	refreshTask = doRefresh().finally(() => {
		refreshTask = undefined;
	});
	return refreshTask;
}

function ensureStarted(): void {
	if (pollTimer || abort) return;
	abort = new AbortController();
	pollTimer = setInterval(() => void refresh(false).catch(() => {}), POLL_INTERVAL_MS);
}

function maybeStop(): void {
	if (subscribers.size > 0) return;
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = undefined;
	abort?.abort();
	abort = undefined;
	refreshTask = undefined;
}

// --- plugin ----------------------------------------------------------------

export default Plugin.define({
	id: "isword.provider-usage",
	async setup(ctx) {
		const registration = await ctx.rpc.register(ProviderUsage, {
			get: async () => ({ snapshot: snapshotCache }),
			refresh: async () => ({ snapshot: await refresh(true) }),
		});

		const subscriber: Subscriber = {
			resolveKey: async (def) => {
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
			},
			persist: (snapshot) => {
				void ctx.storage.set("snapshot", snapshot as never).catch(() => {});
			},
			persistSamples: (data) => {
				void ctx.storage.set("samples", data as never).catch(() => {});
			},
			publish: (snapshot) => {
				void registration.events.emit("updated", { snapshot }).catch(() => {});
			},
		};

		subscribers.add(subscriber);
		ensureStarted();

		// Seed the last persisted snapshot so `get` answers immediately
		// after a restart instead of returning an empty world.
		if (!seeded) {
			seeded = true;
			try {
				const storedSnapshot: unknown = await ctx.storage.get("snapshot");
				const parsed = parseSnapshot(storedSnapshot);
				for (const [name, state] of Object.entries(parsed.providers)) {
					if (states.has(name)) continue;
					states.set(name, state);
					if (state.ok) lastGood.set(name, state);
				}
				const storedSamples: unknown = await ctx.storage.get("samples");
				samples = new SampleStore(storedSamples);
				samples.prune();
				rebuildSnapshot();
			} catch {
				// Seeding is best-effort.
			}
		}

		// Live-ish updates while a multi-turn run is in progress, plus a
		// refresh when credentials change.
		const events = new AbortController();
		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: events.signal })) {
					const type = event.type;
					if (type === "session.idle" || type === "session.execution.succeeded") {
						void refresh(false).catch(() => {});
					} else if (type === "credential.updated" || type === "credential.switched") {
						legacyAuthCache = undefined;
						void refresh(true).catch(() => {});
					}
				}
			} catch {
				// Stream aborted during shutdown.
			}
		})();

		// Cold start (no seeded data) forces a refresh; otherwise the throttle
		// decides, so a second location attaching does not re-hit the APIs.
		const cold = Object.keys(snapshotCache.providers).length === 0;
		void refresh(cold || Date.now() - lastRefreshAt > TURN_THROTTLE_MS).catch(() => {});

		return async () => {
			events.abort();
			subscribers.delete(subscriber);
			// Best-effort final persist while this instance still can.
			subscriber.persist(snapshotCache);
			subscriber.persistSamples(samples.toJSON());
			await registration.dispose();
			maybeStop();
		};
	},
});
