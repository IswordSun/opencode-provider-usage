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
	const parts = barParts(percent, width);
	return parts.filled + parts.empty;
}

/**
 * Splits a usage bar into coloured runs. Uses half-block cells so small
 * percentages stay visible: 30% of 5 cells renders as "█▌░░░".
 */
export function barParts(percent: number, width = 20): { filled: string; empty: string } {
	const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
	const units = Math.max(0, Math.min(width * 2, Math.round((clamped / 100) * width * 2)));
	const full = Math.floor(units / 2);
	const half = units % 2;
	return {
		filled: "█".repeat(full) + (half ? "▌" : ""),
		empty: "░".repeat(Math.max(0, width - full - half)),
	};
}


/** Terminal cell width of a string (CJK/fullwidth = 2 cells). */
export function cells(s: string): number {
	let n = 0
	for (const ch of s) n += ch.codePointAt(0)! > 0x2e7f ? 2 : 1
	return n
}


/** Trim a string to at most `width` terminal cells, appending "…" when cut. */
export function trimToCells(s: string, width: number): string {
	if (width < 1) return ""
	if (cells(s) <= width) return s
	let n = 0
	let out = ""
	for (const ch of s) {
		const w = ch.codePointAt(0)! > 0x2e7f ? 2 : 1
		if (n + w > width - 1) break
		out += ch
		n += w
	}
	return `${out}…`
}


/** Pad a string with spaces to exactly `width` terminal cells. */
export function padCells(s: string, width: number): string {
	const n = cells(s)
	return n >= width ? s : s + " ".repeat(width - n)
}

export function stamp(date: Date): string {
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}
