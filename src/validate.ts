/**
 * Defensive parsing for snapshot payloads.
 *
 * The RPC schema is deliberately permissive, so every consumer re-validates
 * here before rendering: malformed entries are dropped (never thrown), numbers
 * are clamped, and strings are coerced. A corrupt snapshot degrades to
 * `EMPTY_SNAPSHOT` instead of breaking the status bar.
 */

import type {
	BalanceUsage,
	FailureCode,
	PercentUsage,
	ProviderState,
	Snapshot,
	Tone,
	UsageSegment,
} from "./types.js";
import { EMPTY_SNAPSHOT } from "./types.js";

const FAILURE_CODES: ReadonlySet<string> = new Set([
	"no_key",
	"auth",
	"rate_limit",
	"empty",
	"network",
]);
const TONES: ReadonlySet<string> = new Set(["success", "warning", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoString(value: unknown): string | undefined {
	const text = string(value);
	if (text === undefined) return undefined;
	const time = Date.parse(text);
	return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Rounds and clamps into the 0-100 range. */
export function clampPercent(value: unknown): number | undefined {
	const n = finite(value);
	if (n === undefined) return undefined;
	return Math.max(0, Math.min(100, Math.round(n)));
}

function detailLines(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((line): line is string => typeof line === "string").slice(0, 64);
}

function parseSegments(value: unknown): UsageSegment[] {
	if (!Array.isArray(value)) return [];
	const segments: UsageSegment[] = [];
	for (const raw of value.slice(0, 16)) {
		if (!isRecord(raw)) continue;
		const percent = clampPercent(raw.percent);
		const label = string(raw.label);
		if (percent === undefined || label === undefined) continue;
		const segment: UsageSegment = { label, percent };
		const reset = isoString(raw.reset);
		if (reset) segment.reset = reset;
		const delta = finite(raw.delta);
		if (delta !== undefined) segment.delta = Math.max(-100, Math.min(100, Math.round(delta)));
		const etaMs = finite(raw.etaMs);
		if (etaMs !== undefined && etaMs > 0 && etaMs <= 7 * 86_400_000) segment.etaMs = etaMs;
		const status = string(raw.status);
		if (status) segment.status = status.slice(0, 16);
		const note = string(raw.note);
		if (note) segment.note = note.slice(0, 48);
		segments.push(segment);
	}
	return segments;
}

function parseUsage(value: unknown): PercentUsage | BalanceUsage | undefined {
	if (!isRecord(value)) return undefined;
	const title = string(value.title) ?? "Usage";
	if (value.kind === "balance") {
		const text = string(value.text);
		if (text === undefined) return undefined;
		const tone = string(value.tone);
		const usage: BalanceUsage = {
			kind: "balance",
			title,
			text,
			tone: tone !== undefined && TONES.has(tone) ? (tone as Tone) : "success",
			detailLines: detailLines(value.detailLines),
		};
		return usage;
	}
	const segments = parseSegments(value.segments);
	if (!segments.length) return undefined;
	const usage: PercentUsage = { kind: "percent", title, segments, detailLines: detailLines(value.detailLines) };
	return usage;
}

function parseProviderState(value: unknown): ProviderState | undefined {
	if (!isRecord(value)) return undefined;
	const fetchedAt = isoString(value.fetchedAt) ?? new Date().toISOString();

	if (value.ok === true) {
		const data = parseUsage(value.data);
		if (!data) return undefined;
		return { ok: true, data, fetchedAt };
	}
	if (value.ok === false) {
		const code = string(value.code);
		const failure: ProviderState = {
			ok: false,
			code: code !== undefined && FAILURE_CODES.has(code) ? (code as FailureCode) : "network",
			error: string(value.error) ?? "fetch failed",
			fetchedAt,
		};
		const retryAt = isoString(value.retryAt);
		if (retryAt) failure.retryAt = retryAt;
		return failure;
	}
	return undefined;
}

/** Sanitizes an untrusted snapshot; invalid provider entries are dropped. */
export function parseSnapshot(input: unknown): Snapshot {
	if (!isRecord(input)) return { ...EMPTY_SNAPSHOT };
	const providersRaw = input.providers;
	if (!isRecord(providersRaw)) return { updatedAt: isoString(input.updatedAt) ?? EMPTY_SNAPSHOT.updatedAt, providers: {} };

	const providers: Record<string, ProviderState> = {};
	for (const [name, value] of Object.entries(providersRaw)) {
		if (name.length > 64) continue;
		const state = parseProviderState(value);
		if (state) providers[name] = state;
	}
	return { updatedAt: isoString(input.updatedAt) ?? EMPTY_SNAPSHOT.updatedAt, providers };
}

/**
 * True when a cached result is too old to present as current. Missing or
 * unparsable timestamps count as stale so a broken payload never lingers.
 */
export function isStale(iso: string | undefined, maxAgeMs: number, now: number = Date.now()): boolean {
	if (!iso) return true;
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return true;
	return now - time > maxAgeMs;
}
