/**
 * Core refresh state machine, extracted from the plugin so it can be unit
 * tested with an injected clock and fake fetches.
 *
 * Owns, per provider: the latest state, the last good result (which expires
 * after `cachedTtlMs`), rate-limit backoff, and trend samples. Everything
 * that touches opencode (credentials, network, storage, RPC) is injected by
 * the caller.
 */

import { Backoff } from "./backoff.js";
import type { ProviderDef } from "./providers.js";
import { SampleStore, type UsageSample } from "./samples.js";
import type {
	FailureCode,
	PercentUsage,
	ProviderState,
	Snapshot,
	UsageData,
} from "./types.js";
import { isStale, parseSnapshot } from "./validate.js";

/**
 * How long a cached "last good" result may stand in for a failing fetch
 * before the failure is shown instead. Without this a revoked key keeps
 * displaying its last balance forever.
 */
export const CACHED_RESULT_TTL_MS = 15 * 60_000;

export interface KeyedProvider {
	readonly def: ProviderDef;
	readonly key: string;
}

export interface RefresherOptions {
	/** Performs one provider fetch; may throw HttpError-like errors. */
	readonly fetchUsage: (def: ProviderDef, key: string) => Promise<UsageData | undefined>;
	/** Injected clock for deterministic tests. */
	readonly now?: () => number;
	/** Cached-result TTL; defaults to CACHED_RESULT_TTL_MS. */
	readonly cachedTtlMs?: number;
	/** True while the coordinator is shutting down; in-flight results are dropped. */
	readonly isAborted?: () => boolean;
	readonly log?: (message: string, detail?: unknown) => void;
	/** Called after trend samples changed (caller decides about persisting). */
	readonly onSamplesChanged?: () => void;
}

function statusOf(err: unknown): number | undefined {
	const status = (err as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

export class UsageRefresher {
	private readonly fetchUsage: RefresherOptions["fetchUsage"];
	private readonly now: () => number;
	private readonly cachedTtlMs: number;
	private readonly isAborted: () => boolean;
	private readonly log: (message: string, detail?: unknown) => void;
	private readonly onSamplesChanged?: () => void;
	private readonly backoff: Backoff;
	private samples: SampleStore;
	private readonly states = new Map<string, ProviderState>();
	private readonly lastGood = new Map<string, Extract<ProviderState, { ok: true }>>();
	private readonly loggedState = new Map<string, string>();
	private cache: Snapshot = { updatedAt: new Date(0).toISOString(), providers: {} };

	constructor(options: RefresherOptions) {
		this.fetchUsage = options.fetchUsage;
		this.now = options.now ?? Date.now;
		this.cachedTtlMs = options.cachedTtlMs ?? CACHED_RESULT_TTL_MS;
		this.isAborted = options.isAborted ?? (() => false);
		this.log = options.log ?? (() => {});
		this.onSamplesChanged = options.onSamplesChanged;
		this.backoff = new Backoff({ now: this.now });
		this.samples = new SampleStore(undefined, this.now);
	}

	snapshot(): Snapshot {
		return this.cache;
	}

	samplesJSON(): Record<string, UsageSample[]> {
		return this.samples.toJSON();
	}

	/** Seeds from persisted data so `snapshot()` answers before the first fetch. */
	seed(snapshotInput: unknown, samplesInput?: unknown): void {
		const parsed = parseSnapshot(snapshotInput);
		for (const [name, state] of Object.entries(parsed.providers)) {
			if (this.states.has(name)) continue;
			// Providers without a key must be rediscovered, never seeded.
			if (!state.ok && state.code === "no_key") continue;
			this.states.set(name, state);
			if (state.ok) this.lastGood.set(name, state);
		}
		this.samples = new SampleStore(samplesInput, this.now);
		this.samples.prune();
		this.rebuild();
	}

	/** Runs one refresh round; providers absent from `keyed` leave the snapshot. */
	async refresh(keyed: readonly KeyedProvider[]): Promise<Snapshot> {
		const keyedNames = new Set(keyed.map((entry) => entry.def.name));
		for (const name of [...this.states.keys()]) {
			if (keyedNames.has(name)) continue;
			this.states.delete(name);
			this.lastGood.delete(name);
			this.loggedState.delete(name);
		}
		await Promise.all(keyed.map(({ def, key }) => this.refreshProvider(def, key)));
		this.rebuild();
		return this.cache;
	}

	private rebuild(): void {
		const providers: Record<string, ProviderState> = {};
		for (const [name, state] of this.states) providers[name] = state;
		// parseSnapshot doubles as the JSON sanitizer: it strips `undefined`
		// fields the RPC encoder would reject and re-normalizes every value.
		this.cache = parseSnapshot({ updatedAt: new Date(this.now()).toISOString(), providers });
	}

	private withTrend(provider: string, data: UsageData): UsageData {
		if (data.kind !== "percent") return data;
		const segments = data.segments.map((segment) => {
			const trend = this.samples.trend(provider, segment.label);
			const next: PercentUsage["segments"][number] = { ...segment, delta: trend.delta };
			if (trend.etaMs !== undefined) next.etaMs = trend.etaMs;
			return next;
		});
		return { ...data, segments };
	}

	private classify(err: unknown): { code: FailureCode; error: string } {
		const status = statusOf(err);
		if (status === 401 || status === 403) {
			return { code: "auth", error: `API key may be revoked (HTTP ${status})` };
		}
		if (status === 429) return { code: "rate_limit", error: "backing off" };
		if (status) return { code: "network", error: `fetch failed (HTTP ${status})` };
		return {
			code: "network",
			error: `fetch failed (${err instanceof Error ? err.message : "network error or timeout"})`,
		};
	}

	private transition(def: ProviderDef, state: ProviderState): void {
		const signature = state.ok ? `ok:${state.data.kind}` : `fail:${state.code}`;
		if (this.loggedState.get(def.name) === signature) return;
		this.loggedState.set(def.name, signature);
		if (state.ok) this.log(`${def.name} recovered`);
		else this.log(`${def.name} ${state.code}: ${state.error}`);
	}

	private async refreshProvider(def: ProviderDef, key: string): Promise<void> {
		const remaining = this.backoff.remaining(def.name);
		if (remaining > 0) {
			const cached = this.lastGood.get(def.name);
			if (cached && !isStale(cached.fetchedAt, this.cachedTtlMs, this.now())) {
				this.states.set(def.name, cached);
				return;
			}
			this.states.set(def.name, {
				ok: false,
				code: "rate_limit",
				error: "backing off",
				fetchedAt: new Date(this.now()).toISOString(),
				retryAt: new Date(this.now() + remaining).toISOString(),
			});
			return;
		}

		if (this.isAborted()) return; // Shutdown raced the round; keep what we had.

		try {
			const raw = await this.fetchUsage(def, key);
			if (this.isAborted()) return;
			if (!raw) {
				const failure: ProviderState = {
					ok: false,
					code: "empty",
					error: "empty response",
					fetchedAt: new Date(this.now()).toISOString(),
				};
				this.states.set(def.name, failure);
				this.transition(def, failure);
				return;
			}
			this.backoff.clear(def.name);
			// Record the fresh sample before computing the trend so the
			// current point participates (and a window reset zeroes it out
			// instead of reporting a bogus negative delta).
			this.samples.record(def.name, raw.kind === "percent" ? raw.segments : []);
			this.onSamplesChanged?.();
			const data = this.withTrend(def.name, raw);
			const success: ProviderState = {
				ok: true,
				data,
				fetchedAt: new Date(this.now()).toISOString(),
			};
			this.states.set(def.name, success);
			this.lastGood.set(def.name, success);
			this.transition(def, success);
		} catch (err) {
			if (this.isAborted()) return; // Keep whatever we had.
			if (statusOf(err) === 429) this.backoff.strike(def.name);
			const { code, error } = this.classify(err);
			const cached = this.lastGood.get(def.name);
			if (cached && !isStale(cached.fetchedAt, this.cachedTtlMs, this.now())) {
				this.states.set(def.name, cached);
				return;
			}
			const failure: ProviderState = {
				ok: false,
				code,
				error,
				fetchedAt: new Date(this.now()).toISOString(),
			};
			const retryAt = this.backoff.retryAt(def.name);
			if (retryAt) failure.retryAt = retryAt;
			this.states.set(def.name, failure);
			this.transition(def, failure);
		}
	}
}
