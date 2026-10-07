import { describe, expect, test } from "bun:test";
import { Backoff } from "../src/backoff.ts";

function makeClock() {
	let now = 1_000_000;
	return {
		advance: (ms: number) => (now += ms),
		now: () => now,
	};
}

describe("Backoff", () => {
	test("doubles the delay per strike up to the maximum", () => {
		const clock = makeClock();
		const backoff = new Backoff({ baseMs: 60_000, maxMs: 300_000, now: clock.now });
		expect(backoff.strike("a")).toBe(60_000);
		expect(backoff.strike("a")).toBe(120_000);
		expect(backoff.strike("a")).toBe(240_000);
		expect(backoff.strike("a")).toBe(300_000); // capped
		expect(backoff.strike("a")).toBe(300_000);
	});

	test("blocks until the delay elapses, then allows again", () => {
		const clock = makeClock();
		const backoff = new Backoff({ baseMs: 100, now: clock.now });
		backoff.strike("a");
		expect(backoff.remaining("a")).toBe(100);
		clock.advance(60);
		expect(backoff.remaining("a")).toBe(40);
		clock.advance(60);
		expect(backoff.remaining("a")).toBe(0);
		expect(backoff.retryAt("a")).toBeUndefined();
	});

	test("keys are independent and clear resets the counter", () => {
		const clock = makeClock();
		const backoff = new Backoff({ baseMs: 100, now: clock.now });
		backoff.strike("a");
		backoff.strike("a");
		backoff.strike("b");
		expect(backoff.remaining("b")).toBe(100);
		expect(backoff.remaining("a")).toBe(200);

		backoff.clear("a");
		expect(backoff.remaining("a")).toBe(0);
		expect(backoff.strike("a")).toBe(100); // counter restarted
		expect(backoff.remaining("b")).toBe(100); // untouched
	});

	test("retryAt is an ISO timestamp inside the future", () => {
		const clock = makeClock();
		const backoff = new Backoff({ baseMs: 50, now: clock.now });
		backoff.strike("a");
		const retryAt = backoff.retryAt("a");
		expect(retryAt).toBeDefined();
		const diff = Date.parse(retryAt!) - clock.now();
		expect(diff).toBeGreaterThan(0);
		expect(diff).toBeLessThanOrEqual(50);
	});
});
