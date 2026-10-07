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
import { hostOf, providerDefs, type ProviderDef } from "./providers.js";
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

/** Credential request: integration candidates first, then env, then legacy. */
export interface CredentialRequest {
	readonly integrationIDs: readonly string[];
	readonly envKeys: readonly string[];
	readonly authIDs: readonly string[];
}

/** A provider as configured in opencode, normalized for discovery. */
export interface ProviderSource {
	readonly id: string;
	readonly integrationID?: string;
	readonly baseURL?: string;
	readonly disabled: boolean;
}

interface Subscriber {
	/** Resolve a credential, or undefined when this instance cannot. */
	readonly resolveKey: (request: CredentialRequest) => Promise<string | undefined>;
	/** Providers configured at this instance's location. */
	readonly listProviders: () => Promise<ProviderSource[]>;
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
let lastDiscoverySignature = "";
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

async function resolveKeyAny(request: CredentialRequest): Promise<string | undefined> {
	for (const subscriber of subscribers) {
		try {
			const key = await subscriber.resolveKey(request);
			if (key) return key;
		} catch {
			// Try the next subscriber.
		}
	}
	return undefined;
}

/** Collects the providers configured across every location, deduplicated. */
async function collectProviderSources(): Promise<ProviderSource[]> {
	const byKey = new Map<string, ProviderSource>();
	for (const subscriber of subscribers) {
		let list: ProviderSource[];
		try {
			list = await subscriber.listProviders();
		} catch {
			continue;
		}
		for (const source of list) {
			if (!source?.id) continue;
			byKey.set(`${source.id}\0${source.integrationID ?? ""}\0${source.baseURL ?? ""}`, source);
		}
	}
	return [...byKey.values()];
}

/**
 * Discovers which known usage adapters are actually usable: an adapter is
 * included only when a credential can be resolved for it. Matching uses the
 * provider's integration id and base-URL host, so custom providers pointing
 * at a known endpoint are picked up without configuration. Adapters without
 * a key are not part of the snapshot at all.
 */
async function discoverKeyedDefs(): Promise<Array<{ def: ProviderDef; key: string }>> {
	const sources = await collectProviderSources();
	const keyed: Array<{ def: ProviderDef; key: string }> = [];
	for (const def of defs) {
		const matched = sources.filter((source) => {
			if (source.disabled) return false;
			if (def.ids.includes(source.integrationID ?? source.id)) return true;
			const host = hostOf(source.baseURL);
			return host !== undefined && def.hosts.includes(host);
		});
		// Sources matched by host/integration are tried first, then the
		// adapter's own id aliases (connected integrations, legacy auth).
		const integrationIDs = [...new Set([...matched.map((s) => s.integrationID ?? s.id), ...def.ids])];
		const key = await resolveKeyAny({ integrationIDs, envKeys: def.envKeys, authIDs: def.authIDs });
		if (key) keyed.push({ def, key });
	}
	return keyed;
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

async function refreshProvider(def: ProviderDef, key: string): Promise<ProviderState> {
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

	if (abort?.signal.aborted) {
		return previous ?? { ok: false, code: "network", error: "已停止", fetchedAt: new Date().toISOString() };
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
		const keyed = await discoverKeyedDefs();
		const keyedNames = new Set(keyed.map((entry) => entry.def.name));
		const signature = keyed
			.map((entry) => entry.def.name)
			.sort()
			.join(",");
		if (signature !== lastDiscoverySignature) {
			lastDiscoverySignature = signature;
			log(`发现已配置 key 的提供商: ${signature || "（无）"}`);
		}
		// A provider whose key disappeared leaves the snapshot entirely.
		for (const name of [...states.keys()]) {
			if (keyedNames.has(name)) continue;
			states.delete(name);
			lastGood.delete(name);
			loggedState.delete(name);
		}
		await Promise.all(keyed.map(({ def, key }) => refreshProvider(def, key)));
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
			resolveKey: async (request) => {
				for (const id of request.integrationIDs) {
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
				for (const name of request.envKeys) {
					const value = process.env[name];
					if (value) return value;
				}
				const legacy = readLegacyAuth();
				for (const id of request.authIDs) {
					const value = legacy?.[id]?.key;
					if (typeof value === "string" && value) return value;
				}
				return undefined;
			},
			listProviders: async () => {
				const output = await ctx.provider.list();
				const list = Array.isArray(output) ? output : output.data;
				return list
					.filter((provider) => typeof provider?.id === "string")
					.map((provider) => ({
						id: provider.id,
						integrationID:
							typeof provider.integrationID === "string" ? provider.integrationID : undefined,
						baseURL:
							typeof provider.settings?.baseURL === "string" ? provider.settings.baseURL : undefined,
						disabled: provider.activation === "disabled",
					}));
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
		// after a restart instead of returning an empty world. Providers
		// without a key are never seeded (they must be rediscovered).
		if (!seeded) {
			seeded = true;
			try {
				const storedSnapshot: unknown = await ctx.storage.get("snapshot");
				const parsed = parseSnapshot(storedSnapshot);
				for (const [name, state] of Object.entries(parsed.providers)) {
					if (states.has(name)) continue;
					if (!state.ok && state.code === "no_key") continue;
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

		// Live-ish updates while a multi-turn run is in progress; credential,
		// provider, integration, and config changes re-run discovery.
		const events = new AbortController();
		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: events.signal })) {
					const type = event.type;
					if (type === "session.idle" || type === "session.execution.succeeded") {
						void refresh(false).catch(() => {});
					} else if (
						type === "credential.updated" ||
						type === "credential.switched" ||
						type === "provider.updated" ||
						type === "integration.updated" ||
						type === "config.updated"
					) {
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
