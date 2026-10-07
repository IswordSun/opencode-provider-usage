/**
 * Small shared formatting helpers for provider usage values. Kept dependency
 * free so both the server plugin and the TUI plugin can import them.
 */

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** "21:40" when the reset is today, otherwise "11-02 21:44". */
export function formatReset(iso: string | undefined, now: Date = new Date()): string {
	if (!iso) return "?";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "?";
	const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
	if (date.toDateString() === now.toDateString()) return time;
	return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

/** Human duration: "3d" / "5h" / "42m". */
export function formatDuration(seconds: number | undefined): string {
	if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return "?";
	if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
	if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
	return `${Math.max(1, Math.round(seconds / 60))}m`;
}

/** Percentage-point delta as "↑3" / "↓2" / "±0". */
export function fmtDelta(delta: number): string {
	if (delta > 0) return `↑${delta}`;
	if (delta < 0) return `↓${-delta}`;
	return "±0";
}

export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(Math.round(n));
}

const CURRENCY_SYMBOLS: Record<string, string> = {
	CNY: "¥",
	USD: "$",
	EUR: "€",
	JPY: "¥",
};

export function currencySymbol(currency: string): string {
	return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
}

export function formatMoney(amount: string | number | undefined, currency: string): string {
	const symbol = currencySymbol(currency);
	if (amount === undefined) return `${symbol}?`;
	const n = typeof amount === "number" ? amount : Number(amount);
	if (Number.isNaN(n)) return `${symbol}${amount}`;
	return `${symbol}${n.toFixed(2)}`;
}

/** A 20-column usage bar, e.g. "████░░░░░░░░░░░░░░░░". */
export function bar(percent: number, width = 20): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

export function stamp(date: Date): string {
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}
