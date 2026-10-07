import { describe, expect, test } from "bun:test";
import { EMPTY_SNAPSHOT } from "../src/types.ts";
import { clampPercent, parseSnapshot } from "../src/validate.ts";

describe("clampPercent", () => {
	test("rounds and clamps into 0-100", () => {
		expect(clampPercent(12.4)).toBe(12);
		expect(clampPercent(-5)).toBe(0);
		expect(clampPercent(250)).toBe(100);
		expect(clampPercent(Number.NaN)).toBeUndefined();
		expect(clampPercent("20" as unknown)).toBeUndefined();
	});
});

describe("parseSnapshot", () => {
	test("returns the empty snapshot for garbage input", () => {
		expect(parseSnapshot(undefined)).toEqual({ ...EMPTY_SNAPSHOT, providers: {} });
		expect(parseSnapshot("nope")).toEqual({ ...EMPTY_SNAPSHOT, providers: {} });
		expect(parseSnapshot([])).toEqual({ ...EMPTY_SNAPSHOT, providers: {} });
	});

	test("keeps valid entries and drops broken ones", () => {
		const snapshot = parseSnapshot({
			updatedAt: "2030-01-01T00:00:00.000Z",
			providers: {
				deepseek: {
					ok: true,
					fetchedAt: "2030-01-01T00:00:01.000Z",
					data: { kind: "balance", title: "DeepSeek 余额", text: "💰 ¥3.00", tone: "warning", detailLines: ["• x"] },
				},
				opencode: {
					ok: true,
					fetchedAt: "2030-01-01T00:00:01.000Z",
					data: {
						kind: "percent",
						title: "OpenCode 额度",
						segments: [
							{ label: "5h", percent: 12.4, reset: "2030-01-01T05:00:00.000Z", delta: 3, etaMs: 9_000_000 },
							{ label: "7d", percent: 999, delta: -900 }, // clamped
							{ label: "bad", percent: "x" }, // dropped
						],
						detailLines: ["• a", 42],
					},
				},
				broken: { ok: true, data: { kind: "percent", segments: [] } }, // no segments → dropped
				stale: { ok: false, code: "weird-code", error: "x", fetchedAt: "nope" }, // coerced to network
			},
		});

		expect(Object.keys(snapshot.providers).sort()).toEqual(["deepseek", "opencode", "stale"]);
		expect(snapshot.updatedAt).toBe("2030-01-01T00:00:00.000Z");

		const deepseek = snapshot.providers.deepseek!;
		expect(deepseek.ok).toBe(true);
		if (deepseek.ok && deepseek.data.kind === "balance") expect(deepseek.data.text).toBe("💰 ¥3.00");

		const opencode = snapshot.providers.opencode!;
		expect(opencode.ok).toBe(true);
		if (!opencode.ok || opencode.data.kind !== "percent") throw new Error("unreachable");
		expect(opencode.data.segments.map((s) => [s.label, s.percent])).toEqual([
			["5h", 12],
			["7d", 100],
		]);
		expect(opencode.data.segments[0].reset).toBe("2030-01-01T05:00:00.000Z");
		expect(opencode.data.segments[1].delta).toBe(-100); // clamped
		expect(opencode.data.detailLines).toEqual(["• a"]);

		const stale = snapshot.providers.stale!;
		expect(stale.ok).toBe(false);
		if (stale.ok) throw new Error("unreachable");
		expect(stale.code).toBe("network");
		expect(stale.fetchedAt).toBeDefined();
	});

	test("segment status and note are kept but length-capped", () => {
	const snapshot = parseSnapshot({
		updatedAt: "2030-01-01T00:00:00.000Z",
		providers: {
			opencode: {
				ok: true,
				fetchedAt: "2030-01-01T00:00:01.000Z",
				data: {
					kind: "percent",
					title: "t",
					segments: [
						{ label: "5h", percent: 10, status: "limited", note: "已用 12/240 积分" },
						{ label: "7d", percent: 20, status: "x".repeat(40), note: "y".repeat(200) },
						{ label: "30d", percent: 30, status: 42, note: null },
					],
				},
			},
		},
	});
	const opencode = snapshot.providers.opencode!;
	if (!opencode.ok || opencode.data.kind !== "percent") throw new Error("unreachable");
	expect(opencode.data.segments[0]).toMatchObject({ status: "limited", note: "已用 12/240 积分" });
	expect(opencode.data.segments[1].status).toHaveLength(16);
	expect(opencode.data.segments[1].note).toHaveLength(48);
	expect(opencode.data.segments[2].status).toBeUndefined();
	expect(opencode.data.segments[2].note).toBeUndefined();
});

test("strips undefined fields so the result survives JSON round-trips", () => {		const snapshot = parseSnapshot({
			updatedAt: "2030-01-01T00:00:00.000Z",
			providers: {
				opencode: {
					ok: true,
					fetchedAt: "2030-01-01T00:00:01.000Z",
					data: { kind: "percent", title: "t", segments: [{ label: "5h", percent: 1 }] },
				},
			},
		});
		expect(() => JSON.parse(JSON.stringify(snapshot))).not.toThrow();
		const again = JSON.parse(JSON.stringify(snapshot)) as unknown;
		expect(parseSnapshot(again)).toEqual(snapshot);
	});

	test("rate-limit failures keep a normalized retryAt", () => {
		const snapshot = parseSnapshot({
			providers: {
				zai: { ok: false, code: "rate_limit", error: "限流退避中", fetchedAt: "2030-01-01T00:00:00.000Z", retryAt: "soon" },
			},
		});
		const zai = snapshot.providers.zai!;
		if (zai.ok) throw new Error("unreachable");
		expect(zai.retryAt).toBeUndefined(); // invalid ISO dropped
		expect(parseSnapshot({ providers: { zai: { ...zai, retryAt: Date.now() + 60_000 } } }).providers.zai!.ok).toBe(false);
	});
});
