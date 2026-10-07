import { expect, test } from "bun:test";
import {
	bar,
	currencySymbol,
	fmtDelta,
	formatDuration,
	formatMoney,
	formatReset,
	formatTokens,
} from "../src/format.ts";

test("formatReset shows time today and date otherwise", () => {
	const now = new Date(2026, 0, 15, 12, 0, 0);
	expect(formatReset(new Date(2026, 0, 15, 21, 40).toISOString(), now)).toBe("21:40");
	expect(formatReset(new Date(2026, 1, 2, 21, 44).toISOString(), now)).toBe("02-02 21:44");
	expect(formatReset(undefined)).toBe("?");
	expect(formatReset("not-a-date")).toBe("?");
});

test("formatDuration picks sensible units", () => {
	expect(formatDuration(3 * 86_400)).toBe("3d");
	expect(formatDuration(2 * 3_600)).toBe("2h");
	expect(formatDuration(90)).toBe("2m");
	expect(formatDuration(0)).toBe("?");
});

test("fmtDelta renders direction", () => {
	expect(fmtDelta(3)).toBe("↑3");
	expect(fmtDelta(-2)).toBe("↓2");
	expect(fmtDelta(0)).toBe("±0");
});

test("formatTokens and formatMoney", () => {
	expect(formatTokens(1500)).toBe("1.5k");
	expect(formatTokens(2_500_000)).toBe("2.5M");
	expect(formatTokens(0)).toBe("0");
	expect(formatMoney("300.694", "CNY")).toBe("¥300.69");
	expect(formatMoney(10, "USD")).toBe("$10.00");
	expect(currencySymbol("EUR")).toBe("€");
});

test("bar fills proportionally", () => {
	expect(bar(100, 10)).toBe("██████████");
	expect(bar(0, 10)).toBe("░░░░░░░░░░");
	expect(bar(50, 10)).toBe("█████░░░░░");
});
