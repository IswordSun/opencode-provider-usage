import { describe, expect, test } from "bun:test";
import { SAMPLE_MIN_INTERVAL_MS, SAMPLES_TTL_MS, SampleStore } from "../src/samples.ts";

const MIN = 60_000;
const HOUR = 3_600_000;

function makeStore(start = 1_000_000) {
	let now = start;
	return { store: new SampleStore(undefined, () => now), advance: (ms: number) => (now += ms) };
}

describe("SampleStore", () => {
	test("records samples and respects the minimum interval", () => {
		const { store, advance } = makeStore();
		store.record("p", [{ label: "5h", percent: 10 }]);
		advance(1_000);
		store.record("p", [{ label: "5h", percent: 12 }]); // too soon, ignored
		expect(store.toJSON()["p:5h"]).toEqual([{ p: 10, t: 1_000_000 }]);

		advance(SAMPLE_MIN_INTERVAL_MS);
		store.record("p", [{ label: "5h", percent: 14 }]);
		expect(store.toJSON()["p:5h"]).toHaveLength(2);
	});

	test("a sudden drop resets the window history", () => {
		const { store, advance } = makeStore();
		store.record("p", [{ label: "5h", percent: 80 }]);
		advance(10 * MIN);
		store.record("p", [{ label: "5h", percent: 85 }]);
		advance(10 * MIN);
		store.record("p", [{ label: "5h", percent: 2 }]); // window reset
		advance(10 * MIN);
		store.record("p", [{ label: "5h", percent: 3 }]);

		const list = store.toJSON()["p:5h"];
		expect(list).toHaveLength(2);
		expect(list[0].p).toBe(2);
		// Trend restarted from the post-reset samples.
		expect(store.trend("p", "5h").delta).toBe(1);
	});

	test("trend needs a span of at least five minutes", () => {
		const { store, advance } = makeStore();
		store.record("p", [{ label: "5h", percent: 10 }]);
		advance(2 * MIN);
		store.record("p", [{ label: "5h", percent: 30 }]);
		expect(store.trend("p", "5h")).toEqual({ delta: 0 });
	});

	test("trend reports delta and a finite ETA", () => {
		const { store, advance } = makeStore();
		store.record("p", [{ label: "5h", percent: 10 }]);
		advance(30 * MIN); // +20 points in 0.5h → 40 points/hour → 70% left = 1.75h
		store.record("p", [{ label: "5h", percent: 30 }]);
		const trend = store.trend("p", "5h");
		expect(trend.delta).toBe(20);
		expect(trend.etaMs).toBeGreaterThan(1.75 * HOUR * 0.95);
		expect(trend.etaMs).toBeLessThan(1.75 * HOUR * 1.05);
	});

	test("a flat or falling rate yields no ETA", () => {
		const { store, advance } = makeStore();
		store.record("p", [{ label: "5h", percent: 50 }]);
		advance(30 * MIN);
		store.record("p", [{ label: "5h", percent: 50 }]);
		expect(store.trend("p", "5h").etaMs).toBeUndefined();
	});

	test("prune drops expired samples", () => {
		const { store, advance } = makeStore();
		store.record("p", [{ label: "5h", percent: 10 }]);
		advance(SAMPLES_TTL_MS + MIN);
		expect(store.prune()).toBe(true);
		expect(store.toJSON()["p:5h"]).toBeUndefined();
	});

	test("construction from persisted data ignores junk", () => {
		let now = 5_000_000;
		const store = new SampleStore(
			{
				"p:5h": [{ p: 10, t: now - MIN }, { p: 20, t: now }, "junk", { p: NaN, t: now }],
				bad: "not-a-list",
				"p:old": [{ p: 5, t: now - 2 * SAMPLES_TTL_MS }],
			},
			() => now,
		);
		expect(store.toJSON()).toEqual({ "p:5h": [{ p: 10, t: now - MIN }, { p: 20, t: now }] });
	});

	test("non-monotonic persisted samples are dropped", () => {
		let now = 5_000_000;
		const store = new SampleStore({ "p:5h": [{ p: 10, t: now }, { p: 20, t: now - MIN }] }, () => now);
		expect(store.toJSON()["p:5h"]).toEqual([{ p: 10, t: now }]);
	});

	test("non-finite percents are skipped on record", () => {
		const { store } = makeStore();
		store.record("p", [{ label: "5h", percent: Number.NaN }]);
		expect(store.toJSON()).toEqual({});
	});
});
