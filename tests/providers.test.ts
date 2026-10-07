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

test("opencode parses rolling/weekly/monthly windows", async () => {
	mockJson({
		usage: {
			rolling: { status: "ok", percent: 12.4, resetsAt: "2030-01-01T00:00:00.000Z" },
			weekly: { status: "ok", percent: 0 },
			monthly: { status: "limited", percent: 88 },
		},
	});
	const data = await defByName("opencode").fetch("key", new AbortController().signal, {});
	expect(data?.kind).toBe("percent");
	if (data?.kind !== "percent") return;
	expect(data.segments.map((s) => [s.label, s.percent])).toEqual([
		["5h", 12],
		["7d", 0],
		["30d", 88],
	]);
	// Window states ride on the segment; windows are no longer text lines.
	expect(data.segments[2].status).toBe("limited");
	expect(data.segments[0].status).toBeUndefined();
	expect(data.detailLines).toEqual([]);
});

test("opencode returns undefined for an empty payload", async () => {
	mockJson({});
	const data = await defByName("opencode").fetch("key", new AbortController().signal, {});
	expect(data).toBeUndefined();
});

test("deepseek colors the balance by the smallest total", async () => {
	mockJson({
		is_available: true,
		balance_infos: [{ currency: "CNY", total_balance: "3.50", granted_balance: "0", topped_up_balance: "3.50" }],
	});
	const data = await defByName("deepseek").fetch("key", new AbortController().signal, {});
	expect(data?.kind).toBe("balance");
	if (data?.kind !== "balance") return;
	expect(data.text).toBe("💰 ¥3.50");
	expect(data.tone).toBe("error");
});

test("stepfun reports the prepaid balance", async () => {
	mockJson({ type: "prepaid", balance: 42.5, total_cash_balance: 10, total_voucher_balance: 32.5 });
	const data = await defByName("stepfun").fetch("key", new AbortController().signal, {});
	expect(data?.kind).toBe("balance");
	if (data?.kind !== "balance") return;
	expect(data.text).toBe("💰 ¥42.50");
	expect(data.tone).toBe("success");
});

test("zai treats success:false as an auth failure", async () => {
	mockJson({ code: 1000, msg: "Authentication Failed", success: false });
	await expect(
		defByName("zai").fetch("stale-key", new AbortController().signal, { providerID: "zhipuglm" }),
	).rejects.toBeInstanceOf(HttpError);
});

test("non-2xx responses throw an HttpError carrying the status", async () => {
	mockJson({}, 429);
	await expect(
		defByName("opencode").fetch("key", new AbortController().signal, {}),
	).rejects.toMatchObject({ status: 429 });
});

test("a non-JSON body fails with a descriptive error", async () => {
	globalThis.fetch = (async () =>
		new Response("<html>bad gateway</html>", {
			status: 200,
			headers: { "content-type": "text/html" },
		})) as unknown as typeof fetch;
	await expect(defByName("opencode").fetch("key", new AbortController().signal, {})).rejects.toThrow(
		/JSON/,
	);
});

test("oversized response bodies are refused before parsing", async () => {
	globalThis.fetch = (async () =>
		new Response("x".repeat(100), {
			status: 200,
			headers: { "content-type": "application/json", "content-length": String(50_000_000) },
		})) as unknown as typeof fetch;
	await expect(defByName("opencode").fetch("key", new AbortController().signal, {})).rejects.toThrow(
		/过大/,
	);
});

test("percents above 100 are clamped", async () => {
	mockJson({ usage: { rolling: { percent: 250 }, weekly: { percent: -3 } } });
	const data = await defByName("opencode").fetch("key", new AbortController().signal, {});
	if (data?.kind !== "percent") throw new Error("expected percent");
	expect(data.segments.map((s) => [s.label, s.percent])).toEqual([
		["5h", 100],
		["7d", 0],
	]);
});

test("matchProvider selects by provider id and base url", () => {
	const defs = providerDefs();
	expect(matchProvider(defs, { providerID: "opencode-go" })?.name).toBe("opencode");
	expect(matchProvider(defs, { providerID: "deepseek" })?.name).toBe("deepseek");
	expect(matchProvider(defs, { providerID: "zhipuglm" })?.name).toBe("zai");
	expect(matchProvider(defs, { providerID: "openai-codex" })?.name).toBe("openai-codex");
	expect(matchProvider(defs, { baseUrl: "https://api.stepfun.com/v1" })?.name).toBe("stepfun");
	expect(matchProvider(defs, { providerID: "unknown" })).toBeUndefined();
});

test("custom providers pointing at a known host match its adapter", () => {
	const defs = providerDefs();
	// A hand-written opencode.jsonc provider with a bigmodel base URL maps to zai.
	expect(matchProvider(defs, { providerID: "myglm", baseUrl: "https://open.bigmodel.cn/api/paas/v4" })?.name).toBe("zai");
	expect(matchProvider(defs, { providerID: "myzai", baseUrl: "https://api.z.ai/api/paas/v4" })?.name).toBe("zai");
	// A regular OpenAI API key is not a ChatGPT subscription token.
	expect(matchProvider(defs, { providerID: "openai", baseUrl: "https://api.openai.com/v1" })).toBeUndefined();
	// Malformed base URLs never match.
	expect(matchProvider(defs, { providerID: "weird", baseUrl: "not a url" })).toBeUndefined();
});
