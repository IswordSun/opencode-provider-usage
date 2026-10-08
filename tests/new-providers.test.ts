import { afterEach, expect, test } from "bun:test";
import { HttpError, matchProvider, providerDefs } from "../src/providers.ts";

const originalFetch = globalThis.fetch;

function mockJson(payload: unknown, status = 200): void {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function defByName(name: string) {
	const def = providerDefs().find((d) => d.name === name);
	if (!def) throw new Error(`missing provider ${name}`);
	return def;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("moonshot parses the balance and colors low balances", async () => {
	mockJson({ code: 0, status: true, data: { available_balance: 3.5, voucher_balance: 0.5, cash_balance: 3 } });
	const data = await defByName("moonshot").fetch("key", new AbortController().signal, { providerID: "moonshotai-cn" });
	expect(data?.kind).toBe("balance");
	if (data?.kind !== "balance") return;
	expect(data.text).toBe("💰 ¥3.50");
	expect(data.tone).toBe("error");
	expect(data.detailLines[0]).toContain("cash ¥3.00");
});

test("moonshot treats a non-zero code as an auth failure", async () => {
	mockJson({ code: 1001, status: false });
	await expect(
		defByName("moonshot").fetch("bad", new AbortController().signal, {}),
	).rejects.toBeInstanceOf(HttpError);
});

test("siliconflow parses balance/charge/total", async () => {
	mockJson({
		code: 20000,
		status: true,
		message: "OK",
		data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88", status: "normal" },
	});
	const data = await defByName("siliconflow").fetch("key", new AbortController().signal, { providerID: "siliconflow-cn" });
	expect(data?.kind).toBe("balance");
	if (data?.kind !== "balance") return;
	expect(data.text).toBe("💰 ¥0.88");
	expect(data.tone).toBe("error");
	expect(data.detailLines[0]).toContain("topped up ¥88.00");
	expect(data.detailLines[0]).toContain("account normal");
});

test("openrouter computes remaining credits", async () => {
	mockJson({ data: { total_credits: 100.5, total_usage: 25.25 } });
	const data = await defByName("openrouter").fetch("key", new AbortController().signal, {});
	expect(data?.kind).toBe("balance");
	if (data?.kind !== "balance") return;
	expect(data.text).toBe("💰 $75.25");
	expect(data.tone).toBe("success");
	expect(data.detailLines[0]).toContain("topped up $100.50");
});

test("openrouter explains that management keys are required on 403", async () => {
	mockJson({}, 403);
	await expect(
		defByName("openrouter").fetch("key", new AbortController().signal, {}),
	).rejects.toThrow(/Management Key/);
});

test("skywork parses resp_data with its own currency", async () => {
	mockJson({
		code: 200,
		resp_data: { available_amount: 158.82, total_amount: 203.5, consumed_amount: 44.67, currency: "USD" },
	});
	const data = await defByName("skywork").fetch("key", new AbortController().signal, {});
	expect(data?.kind).toBe("balance");
	if (data?.kind !== "balance") return;
	expect(data.text).toBe("💰 $158.82");
	expect(data.detailLines[0]).toContain("used $44.67");
});

test("novita converts its 1/10000 USD units", async () => {
	mockJson({ availableBalance: "1000000", cashBalance: "800000", creditLimit: "200000" });
	const data = await defByName("novita").fetch("key", new AbortController().signal, {});
	expect(data?.kind).toBe("balance");
	if (data?.kind !== "balance") return;
	expect(data.text).toBe("💰 $100.00");
	expect(data.detailLines[0]).toContain("cash $80.00");
});

test("new providers match by integration id and host", () => {
	const defs = providerDefs();
	expect(matchProvider(defs, { providerID: "moonshotai" })?.name).toBe("moonshot");
	expect(matchProvider(defs, { providerID: "siliconflow-cn" })?.name).toBe("siliconflow");
	expect(matchProvider(defs, { providerID: "openrouter" })?.name).toBe("openrouter");
	expect(matchProvider(defs, { providerID: "sf", baseUrl: "https://api.siliconflow.cn/v1" })?.name).toBe("siliconflow");
	expect(matchProvider(defs, { providerID: "novita" })?.name).toBe("novita");
});
