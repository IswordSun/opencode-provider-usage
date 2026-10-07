/**
 * Usage-trend samples: percentage points per provider window, kept for one
 * hour and persisted by the server plugin. A sudden drop counts as a window
 * reset and clears the history for that window.
 *
 * The store is pure data plus an injectable clock so trends can be tested.
 */

export interface UsageSample {
	p: number;
	t: number;
}

export interface Trend {
	/** Percentage-point change over the observed span. */
	readonly delta: number;
	/** Estimated milliseconds until 100% at the current rate, when computable. */
	readonly etaMs?: number;
}

export const SAMPLES_TTL_MS = 3_600_000;
export const SAMPLE_MAX = 60;
export const SAMPLE_MIN_INTERVAL_MS = 60_000;
export const TREND_MIN_SPAN_MS = 5 * 60_000;
export const RESET_DROP_THRESHOLD = 25;
/** ETA beyond this is reported as "no estimate" instead of a huge number. */
const ETA_MAX_MS = 7 * 86_400_000;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseList(input: unknown, now: number): UsageSample[] {
	if (!Array.isArray(input)) return [];
	const fresh = input.filter(
		(s): s is UsageSample =>
			isFiniteNumber((s as UsageSample | undefined)?.p) &&
			isFiniteNumber((s as UsageSample | undefined)?.t) &&
			(s as UsageSample).t <= now + 60_000,
	);
	const list: UsageSample[] = [];
	for (const sample of fresh) {
		if (list.length && sample.t < list[list.length - 1].t) continue; // ignore non-monotonic junk
		list.push({ p: sample.p, t: sample.t });
	}
	while (list.length && now - list[0].t > SAMPLES_TTL_MS) list.shift();
	while (list.length > SAMPLE_MAX) list.shift();
	return list;
}

export class SampleStore {
	private readonly data = new Map<string, UsageSample[]>();
	private readonly now: () => number;

	constructor(input?: unknown, now: () => number = Date.now) {
		this.now = now;
		if (typeof input !== "object" || input === null) return;
		const current = this.now();
		for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
			const list = parseList(value, current);
			if (list.length) this.data.set(key, list);
		}
	}

	/** Records one observation for every window of a percent provider. */
	record(provider: string, segments: readonly { label: string; percent: number }[]): void {
		const now = this.now();
		for (const segment of segments) {
			if (!Number.isFinite(segment.percent)) continue;
			const key = `${provider}:${segment.label}`;
			let list = this.data.get(key);
			if (!list) {
				list = [];
				this.data.set(key, list);
			}
			const last = list[list.length - 1];
			// A big drop means the window reset; history no longer applies.
			if (last && segment.percent < last.p - RESET_DROP_THRESHOLD) list.length = 0;
			if (list.length && now - list[list.length - 1].t < SAMPLE_MIN_INTERVAL_MS) continue;
			list.push({ p: segment.percent, t: now });
			while (list.length && now - list[0].t > SAMPLES_TTL_MS) list.shift();
			while (list.length > SAMPLE_MAX) list.shift();
		}
	}

	/** Trend across the stored samples for one window. */
	trend(provider: string, label: string): Trend {
		const list = this.data.get(`${provider}:${label}`);
		if (!list || list.length < 2) return { delta: 0 };
		const now = this.now();
		const spanMs = now - list[0].t;
		if (spanMs < TREND_MIN_SPAN_MS) return { delta: 0 };
		const latest = list[list.length - 1].p;
		const delta = latest - list[0].p;
		const ratePerHour = delta / (spanMs / 3_600_000);
		if (ratePerHour <= 0 || !Number.isFinite(ratePerHour)) return { delta };
		const etaMs = ((100 - latest) / ratePerHour) * 3_600_000;
		if (!Number.isFinite(etaMs) || etaMs > ETA_MAX_MS) return { delta };
		return { delta, etaMs };
	}

	/** Drops samples older than the TTL; returns true when anything changed. */
	prune(): boolean {
		const now = this.now();
		let changed = false;
		for (const [key, list] of this.data) {
			const before = list.length;
			while (list.length && now - list[0].t > SAMPLES_TTL_MS) list.shift();
			if (!list.length) this.data.delete(key);
			if (list.length !== before || !this.data.has(key)) changed = true;
		}
		return changed;
	}

	toJSON(): Record<string, UsageSample[]> {
		const out: Record<string, UsageSample[]> = {};
		for (const [key, list] of this.data) if (list.length) out[key] = list;
		return out;
	}
}
