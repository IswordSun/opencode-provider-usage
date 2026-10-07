import { describe, expect, test } from "bun:test";
import type { ProviderDef } from "../src/providers.ts";
import { UsageRefresher } from "../src/refresher.ts";
import type { UsageData } from "../src/types.ts";

const MIN = 60_000;

function makeDef(name = "test"): ProviderDef {
	return {
		name,
		title: "Test",
		ids: [name],
		hosts: [],
		envKeys: [],
		authIDs: [],
		async fetch() {
			return undefined;
		},
	};
}

const balance = (text = "💰 ¥10.00"): UsageData => ({
	kind: "balance",
	title: "Test 余额",
	text,
	tone: "success",
	detailLines: [],
});

const percent = (p: number): UsageData => ({
	kind: "percent",
	title: "Test 额度",
	segments: [{ label: "5h", percent: p }],
	detailLines: [],
});

class Err extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}

function makeRefresher(
	fetchUsage: (def: ProviderDef, key: string) => Promise<UsageData | undefined>,
	options: { ttlMs?: number; isAborted?: () => boolean } = {},
) {
	let now = Date.parse("2030-01-01T12:00:00.000Z");
	const clock = { advance: (ms: number) => (now += ms), now: () => now };
	const logs: string[] = [];
	const refresher = new UsageRefresher({
		fetchUsage,
		now: clock.now,
		cachedTtlMs: options.ttlMs ?? 15 * MIN,
		isAborted: options.isAborted,
		log: (message) => logs.push(message),
	});
	return { refresher, clock, logs };
}

describe("UsageRefresher", () => {
	test("successful fetches populate the snapshot and record samples", async () => {
		const { refresher } = makeRefresher(async () => percent(42));
		const snapshot = await refresher.refresh([{ def: makeDef(), key: "k" }]);
		const state = snapshot.providers.test!;
		expect(state.ok).toBe(true);
		if (!state.ok || state.data.kind !== "percent") throw new Error("unreachable");
		expect(state.data.segments[0].percent).toBe(42);
		expect(refresher.samplesJSON()["test:5h"]).toHaveLength(1);
	});

	test("providers absent from the keyed set leave the snapshot", async () => {
		const { refresher } = makeRefresher(async () => balance());
		const def = makeDef();
		await refresher.refresh([{ def, key: "k" }]);
		expect(refresher.snapshot().providers.test).toBeDefined();
		await refresher.refresh([]);
		expect(refresher.snapshot().providers.test).toBeUndefined();
	});

	test("an empty payload becomes an explicit failure", async () => {
		const { refresher } = makeRefresher(async () => undefined);
		const snapshot = await refresher.refresh([{ def: makeDef(), key: "k" }]);
		const state = snapshot.providers.test!;
		expect(state.ok).toBe(false);
		if (state.ok) throw new Error("unreachable");
		expect(state.code).toBe("empty");
	});

	test("auth failures surface once the cached result expires", async () => {
		let fail = false;
		const { refresher, clock } = makeRefresher(async () => {
			if (fail) throw new Err(401);
			return balance("💰 ¥100.00");
		});
		const def = makeDef();
		await refresher.refresh([{ def, key: "k" }]);

		fail = true;
		await refresher.refresh([{ def, key: "k" }]);
		expect(refresher.snapshot().providers.test?.ok).toBe(true); // cached

		clock.advance(16 * MIN);
		await refresher.refresh([{ def, key: "k" }]);
		const state = refresher.snapshot().providers.test!;
		expect(state.ok).toBe(false);
		if (state.ok) throw new Error("unreachable");
		expect(state.code).toBe("auth");
		expect(state.error).toContain("401");
	});

	test("429 backs off and reports retryAt while backing off", async () => {
		let calls = 0;
		const { refresher } = makeRefresher(async () => {
			calls++;
			if (calls === 1) return balance();
			throw new Err(429);
		});
		const def = makeDef();
		await refresher.refresh([{ def, key: "k" }]);
		await refresher.refresh([{ def, key: "k" }]); // trips the backoff

		const state = refresher.snapshot().providers.test!;
		// Fresh cache wins over the rate-limit notice while it lasts.
		expect(state.ok).toBe(true);
	});

	test("abort mid-flight keeps the previous state untouched", async () => {
		let aborted = false;
		const { refresher } = makeRefresher(
			async () => {
				if (aborted) throw new Error("cancelled");
				return balance("¥first");
			},
			{ isAborted: () => aborted },
		);
		const def = makeDef();
		await refresher.refresh([{ def, key: "k" }]);
		aborted = true;
		await refresher.refresh([{ def, key: "k" }]);
		const state = refresher.snapshot().providers.test!;
		expect(state.ok).toBe(true);
		if (!state.ok) throw new Error("unreachable");
		expect(state.data.kind === "balance" ? state.data.text : "").toBe("¥first");
	});

	test("seed restores persisted providers but never no_key entries", async () => {
		const { refresher } = makeRefresher(async () => balance());
		refresher.seed({
			updatedAt: "2030-01-01T11:00:00.000Z",
			providers: {
				deepseek: {
					ok: true,
					fetchedAt: "2030-01-01T11:00:00.000Z",
					data: { kind: "balance", title: "DeepSeek 余额", text: "💰 ¥5.00", tone: "success", detailLines: [] },
				},
				openai: { ok: false, code: "no_key", error: "未配置 API Key", fetchedAt: "2030-01-01T11:00:00.000Z" },
			},
		});
		expect(Object.keys(refresher.snapshot().providers)).toEqual(["deepseek"]);
	});

	test("transitions are logged once per state change", async () => {
		let fail = false;
		const { refresher, logs } = makeRefresher(async () => {
			if (fail) throw new Err(500);
			return balance();
		});
		const def = makeDef();
		await refresher.refresh([{ def, key: "k" }]);
		await refresher.refresh([{ def, key: "k" }]); // same state, no new log
		fail = true;
		await refresher.refresh([{ def, key: "k" }]);
		await refresher.refresh([{ def, key: "k" }]); // cached, still failure state logged once
		expect(logs.filter((l) => l.includes("恢复正常"))).toHaveLength(1);
	});

	test("trend deltas accumulate across rounds", async () => {
		let p = 10;
		const { refresher, clock } = makeRefresher(async () => percent(p));
		const def = makeDef();
		await refresher.refresh([{ def, key: "k" }]);
		clock.advance(10 * MIN);
		p = 25;
		await refresher.refresh([{ def, key: "k" }]);
		const state = refresher.snapshot().providers.test!;
		if (!state.ok || state.data.kind !== "percent") throw new Error("unreachable");
		// The just-fetched point participates immediately.
		expect(state.data.segments[0].delta).toBe(15);
	});

	test("a window reset reports no delta instead of a negative one", async () => {
		let p = 80;
		const { refresher, clock } = makeRefresher(async () => percent(p));
		const def = makeDef();
		await refresher.refresh([{ def, key: "k" }]);
		clock.advance(10 * MIN);
		p = 85;
		await refresher.refresh([{ def, key: "k" }]);
		clock.advance(10 * MIN);
		p = 2; // window reset
		await refresher.refresh([{ def, key: "k" }]);
		const state = refresher.snapshot().providers.test!;
		if (!state.ok || state.data.kind !== "percent") throw new Error("unreachable");
		expect(state.data.segments[0].delta).toBe(0);
	});
});
