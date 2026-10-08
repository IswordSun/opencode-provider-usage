/**
 * opencode-provider-usage — server plugin.
 *
 * Owns credential resolution and network access, refreshes account-level
 * usage/balance for every supported provider, and exposes the result over RPC
 * to the TUI plugin (and any other client).
 *
 * Providers: opencode/opencode-go, deepseek, stepfun, zai/zhipu,
 * moonshot/kimi, siliconflow, openrouter, skywork, novita, openai-codex.
 *
 * This module is the opencode-facing shell: discovery, credentials, storage,
 * RPC, timers, and logging. The refresh state machine itself (states, cache
 * TTL, backoff, trend samples) lives in `refresher.ts` and is unit tested.
 *
 * Robustness properties:
 * - Credentials resolve through the integration API first, then environment
 *   variables, then a cached read of the legacy `auth.json`.
 * - All shared state lives in a module-level coordinator, so several plugin
 *   instances (one per location) share one polling loop.
 * - Only adapters with a resolvable key enter the snapshot; a key that
 *   disappears removes its provider on the next round.
 * - The snapshot survives restarts: it is seeded from plugin storage on the
 *   first attach, and trend samples are persisted alongside it.
 */

import { readFileSync, appendFileSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { hostOf, providerDefs, type ProviderDef } from "./providers.js";
import { UsageRefresher, type KeyedProvider } from "./refresher.js";
import { ProviderUsage } from "./rpc.js";
import type { Snapshot, UsageData } from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 500;
const POLL_INTERVAL_MS = 120_000;
const TURN_THROTTLE_MS = 5_000;
const SAMPLES_SAVE_DEBOUNCE_MS = 30_000;
const LEGACY_AUTH_CACHE_MS = 30_000;
const MAX_LOGGED_DETAIL = 200;
/** Debug log size cap before truncation. */
const DEBUG_LOG_MAX_BYTES = 1_000_000;

const AUTH_PATH = join(homedir(), ".local/share/opencode/auth.json");
const DEBUG_LOG_PATH = join(homedir(), ".local/share/opencode/log/provider-usage.log");
const DEBUG = process.env.OPENCODE_PROVIDER_USAGE_DEBUG === "1";

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
	const line = `[provider-usage] ${new Date().toISOString()} ${message}${suffix}`;
	console.log(line);
	// The plugin host has no logging channel, so opt-in debugging goes to a
	// dedicated file (rotated by truncation) next to opencode's own logs.
	if (!DEBUG) return;
	try {
		try {
			if (statSync(DEBUG_LOG_PATH).size > DEBUG_LOG_MAX_BYTES) truncateSync(DEBUG_LOG_PATH);
		} catch {
			// First write or missing file.
		}
		appendFileSync(DEBUG_LOG_PATH, `${line}\n`);
	} catch {
		// Logging must never break the plugin.
	}
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
const subscribers = new Set<Subscriber>();

let abort: AbortController | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let refreshTask: ReturnType<UsageRefresher["refresh"]> | undefined;
let lastRefreshAt = 0;
let lastSamplesSaveAt = 0;
let seeded = false;
let lastDiscoverySignature = "";

const refresher = new UsageRefresher({
	fetchUsage,
	isAborted: () => abort?.signal.aborted ?? false,
	log,
	onSamplesChanged: () => noteSamplesChanged(),
});

/** One provider fetch with timeout, one retry, and shutdown-aware aborts. */
async function fetchUsage(def: ProviderDef, key: string): Promise<UsageData | undefined> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (abort?.signal.aborted) throw lastError ?? new Error("aborted");
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
			if (attempt < 1) await sleep(RETRY_DELAY_MS, abort?.signal);
		} finally {
			clearTimeout(timer);
			abort?.signal.removeEventListener("abort", onParentAbort);
		}
	}
	throw lastError;
}

function publishSnapshot(snapshot: Snapshot): void {
	for (const subscriber of subscribers) {
		subscriber.persist(snapshot);
		subscriber.publish(snapshot);
	}
}

function noteSamplesChanged(): void {
	if (Date.now() - lastSamplesSaveAt < SAMPLES_SAVE_DEBOUNCE_MS) return;
	lastSamplesSaveAt = Date.now();
	for (const subscriber of subscribers) subscriber.persistSamples(refresher.samplesJSON());
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
 * at a known endpoint are picked up without configuration.
 */
async function discoverKeyedDefs(): Promise<KeyedProvider[]> {
	const sources = await collectProviderSources();
	const entries = await Promise.all(
		defs.map(async (def) => {
			const matched = sources.filter((source) => {
				if (source.disabled) return false;
				if (def.ids.includes(source.integrationID ?? source.id)) return true;
				const host = hostOf(source.baseURL);
				return host !== undefined && def.hosts.includes(host);
			});
			// Sources matched by host/integration are tried first, then the
			// adapter's own id aliases (connected integrations, legacy auth).
			const integrationIDs = [
				...new Set([...matched.map((s) => s.integrationID ?? s.id), ...def.ids]),
			];
			const key = await resolveKeyAny({ integrationIDs, envKeys: def.envKeys, authIDs: def.authIDs });
			return key ? { def, key } : undefined;
		}),
	);
	return entries.filter((entry): entry is KeyedProvider => entry !== undefined);
}

async function doRefresh(): Promise<Snapshot> {
	let snapshot = refresher.snapshot();
	try {
		const keyed = await discoverKeyedDefs();
		const signature = keyed
			.map((entry) => entry.def.name)
			.sort()
			.join(",");
		if (signature !== lastDiscoverySignature) {
			lastDiscoverySignature = signature;
			log(`providers with keys: ${signature || "(none)"}`);
		}
		snapshot = await refresher.refresh(keyed);
	} catch (err) {
		log("refresh loop error", err instanceof Error ? err.message : err);
	}
	publishSnapshot(snapshot);
	lastRefreshAt = Date.now();
	return snapshot;
}

function refresh(force: boolean): Promise<Snapshot> {
	if (refreshTask) return refreshTask;
	if (!force && Date.now() - lastRefreshAt < TURN_THROTTLE_MS) {
		return Promise.resolve(refresher.snapshot());
	}
	const task = doRefresh().finally(() => {
		refreshTask = undefined;
	});
	refreshTask = task;
	return task;
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

let legacyAuthCache: { at: number; value: Record<string, { key?: string }> | undefined } | undefined;

function readLegacyAuth(): Record<string, { key?: string }> | undefined {
	const now = Date.now();
	if (legacyAuthCache && now - legacyAuthCache.at < LEGACY_AUTH_CACHE_MS) {
		return legacyAuthCache.value;
	}
	let value: Record<string, { key?: string }> | undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
		if (typeof parsed === "object" && parsed !== null) {
			value = parsed as Record<string, { key?: string }>;
		}
	} catch {
		value = undefined; // Missing or corrupt file: treated as absent.
	}
	legacyAuthCache = { at: now, value };
	return value;
}

export default Plugin.define({
	id: "isword.provider-usage",
	async setup(ctx) {
		const registration = await ctx.rpc.register(ProviderUsage, {
			get: async () => ({ snapshot: refresher.snapshot() }),
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
		// after a restart instead of returning an empty world.
		if (!seeded) {
			seeded = true;
			try {
				const storedSnapshot: unknown = await ctx.storage.get("snapshot");
				const storedSamples: unknown = await ctx.storage.get("samples");
				refresher.seed(storedSnapshot, storedSamples);
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
		const cold = Object.keys(refresher.snapshot().providers).length === 0;
		void refresh(cold || Date.now() - lastRefreshAt > TURN_THROTTLE_MS).catch(() => {});

		return async () => {
			events.abort();
			subscribers.delete(subscriber);
			// Best-effort final persist while this instance still can.
			subscriber.persist(refresher.snapshot());
			subscriber.persistSamples(refresher.samplesJSON());
			await registration.dispose();
			maybeStop();
		};
	},
});
