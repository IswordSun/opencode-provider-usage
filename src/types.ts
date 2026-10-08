/**
 * Shared snapshot contract between the server plugin (producer) and the TUI
 * plugin (consumer). Everything here is plain JSON.
 */

export type Tone = "success" | "warning" | "error";

export interface UsageSegment {
	/** Window label, e.g. "5h" / "7d" / "30d". */
	label: string;
	/** Percent used, 0-100. */
	percent: number;
	/** ISO timestamp of the next window reset, when known. */
	reset?: string;
	/** Percentage-point change vs the oldest sample in the trend window. */
	delta?: number;
	/** Estimated milliseconds until 100% at the current burn rate. */
	etaMs?: number;
	/** Provider-reported window status when not "ok" (e.g. "limited"). */
	status?: string;
	/** Short supplementary text for this window (e.g. "12/240 pts used"). */
	note?: string;
}

export interface PercentUsage {
	kind: "percent";
	title: string;
	segments: UsageSegment[];
	detailLines: string[];
}

export interface BalanceUsage {
	kind: "balance";
	title: string;
	/** Compact status-bar text, e.g. "💰 ¥300.69". */
	text: string;
	tone: Tone;
	detailLines: string[];
}

export type UsageData = PercentUsage | BalanceUsage;

export type FailureCode = "no_key" | "auth" | "rate_limit" | "empty" | "network";

export interface ProviderFailure {
	ok: false;
	code: FailureCode;
	error: string;
	/** ISO time of this attempt. */
	fetchedAt: string;
	/** ISO time until which this provider is backing off (HTTP 429). */
	retryAt?: string;
}

export interface ProviderSuccess {
	ok: true;
	data: UsageData;
	/** ISO time this data was fetched. */
	fetchedAt: string;
}

export type ProviderState = ProviderSuccess | ProviderFailure;

export interface Snapshot {
	/** ISO time of the last refresh round. */
	updatedAt: string;
	providers: Record<string, ProviderState>;
}

export const EMPTY_SNAPSHOT: Snapshot = { updatedAt: new Date(0).toISOString(), providers: {} };
