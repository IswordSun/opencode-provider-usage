/**
 * Provider definitions and their official usage/balance endpoints.
 *
 * Ported from the pi `provider-usage` extension so both agents report the same
 * numbers. Every `fetch` throws an `HttpError` for non-2xx responses so the
 * caller can classify auth (401/403) vs rate-limit (429) vs other failures.
 */

import {
	formatDuration,
	formatMoney,
} from "./format.js";
import type { Tone, UsageData, UsageSegment } from "./types.js";

const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const STEPFUN_ACCOUNT_URL = "https://api.stepfun.com/v1/accounts";
const OPENAI_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ZAI_QUOTA_URL = {
	cn: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
	intl: "https://api.z.ai/api/monitor/usage/quota/limit",
} as const;

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`HTTP ${status}`);
		this.status = status;
	}
}

export interface ProviderContext {
	/** The active model's provider id, when known. */
	providerID?: string;
	/** The active model's base URL, when known. */
	baseUrl?: string;
}

export interface ProviderDef {
	/** Stable id used as the snapshot key and in logs. */
	name: string;
	/** Human readable title for detail views. */
	title: string;
	/**
	 * Integration / provider ids this adapter covers. Doubles as the ordered
	 * candidate list when resolving a credential.
	 */
	ids: readonly string[];
	/** Provider base-URL hosts this adapter covers. */
	hosts: readonly string[];
	/** Environment variables holding the key, tried after integrations. */
	envKeys: readonly string[];
	/** Legacy `auth.json` provider ids, tried last. */
	authIDs: readonly string[];
	fetch(key: string, signal: AbortSignal, context: ProviderContext): Promise<UsageData | undefined>;
}

/** Hostname of a base URL, or undefined when it cannot be parsed. */
export function hostOf(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}
}

/** Declarative match: provider id or base-URL host belongs to this adapter. */
export function matchesDef(def: ProviderDef, context: ProviderContext): boolean {
	if (context.providerID !== undefined && def.ids.includes(context.providerID)) return true;
	const host = hostOf(context.baseUrl);
	return host !== undefined && def.hosts.includes(host);
}

/** Response bodies above this are refused before parsing. */
const MAX_BODY_BYTES = 2_000_000;

/** Parses a response body as JSON, throwing a descriptive error on garbage. */
async function getJson<T>(res: Response): Promise<T> {
	const declared = Number(res.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		throw new Error(`响应体过大（${(declared / 1_000_000).toFixed(1)}MB）`);
	}
	let text: string;
	try {
		text = await res.text();
	} catch {
		throw new Error("读取响应体失败");
	}
	if (text.length > MAX_BODY_BYTES) throw new Error("响应体过大");
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`响应不是有效 JSON（${text.slice(0, 80)}）`);
	}
}

/** Rounds and clamps a percent into 0-100. */
function pct(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

// --- opencode / opencode-go (Zen subscription quota) -----------------------

interface QuotaWindow {
	status?: string;
	percent?: number;
	resetsAt?: string;
}

interface OpencodeUsagePayload {
	usage?: {
		rolling?: QuotaWindow;
		weekly?: QuotaWindow;
		monthly?: QuotaWindow;
	};
}

function opencodeDef(): ProviderDef {
	return {
		name: "opencode",
		title: "OpenCode 额度",
		ids: ["opencode-go", "opencode"],
		envKeys: ["OPENCODE_API_KEY"],
		authIDs: ["opencode-go", "opencode"],
		hosts: ["opencode.ai"],
		async fetch(key, signal) {
			const res = await fetch(OPENCODE_USAGE_URL, {
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				signal,
			});
			if (!res.ok) throw new HttpError(res.status);
			const payload = await getJson<OpencodeUsagePayload>(res);
			const usage = payload.usage;
			if (!usage) return undefined;

			const windows: Array<[string, QuotaWindow | undefined]> = [
				["5h", usage.rolling],
				["7d", usage.weekly],
				["30d", usage.monthly],
			];
			const segments: UsageSegment[] = [];
			for (const [label, win] of windows) {
				if (typeof win?.percent !== "number") continue;
				const segment: UsageSegment = { label, percent: pct(win.percent), reset: win.resetsAt };
				if (win.status && win.status !== "ok") segment.status = win.status;
				segments.push(segment);
			}
			if (!segments.length) return undefined;
			// Windows are rendered as progress bars by the TUI; detailLines
			// carries only supplementary text.
			return { kind: "percent", title: "OpenCode 额度", segments, detailLines: [] };
		},
	};
}

// --- deepseek (prepaid balance) --------------------------------------------

interface DeepseekBalancePayload {
	is_available?: boolean;
	balance_infos?: Array<{
		currency: string;
		total_balance?: string;
		granted_balance?: string;
		topped_up_balance?: string;
	}>;
}

function deepseekDef(): ProviderDef {
	return {
		name: "deepseek",
		title: "DeepSeek 余额",
		ids: ["deepseek"],
		envKeys: ["DEEPSEEK_API_KEY"],
		authIDs: ["deepseek"],
		hosts: ["api.deepseek.com"],
		async fetch(key, signal) {
			const res = await fetch(DEEPSEEK_BALANCE_URL, {
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				signal,
			});
			if (!res.ok) throw new HttpError(res.status);
			const payload = await getJson<DeepseekBalancePayload>(res);

			if (!payload.is_available) {
				return {
					kind: "balance",
					title: "DeepSeek 余额",
					text: "💰 余额不可用",
					tone: "error",
					detailLines: ["• 账户当前不可用（is_available=false）"],
				};
			}
			if (!payload.balance_infos?.length) return undefined;

			const detailLines = payload.balance_infos.map((info) => {
				const currency = info.currency || "CNY";
				return (
					`${currency}: 总额 ${formatMoney(info.total_balance, currency)}` +
					`（充值 ${formatMoney(info.topped_up_balance, currency)}` +
					` / 赠送 ${formatMoney(info.granted_balance, currency)}）`
				);
			});

			const totals = payload.balance_infos
				.map((info) => Number(info.total_balance))
				.filter((n) => !Number.isNaN(n));
			const minTotal = totals.length ? Math.min(...totals) : -1;
			return {
				kind: "balance",
				title: "DeepSeek 余额",
				text: `💰 ${payload.balance_infos
					.map((info) => formatMoney(info.total_balance, info.currency || "CNY"))
					.join(" ")}`,
				tone: minTotal < 5 ? "error" : minTotal < 20 ? "warning" : "success",
				detailLines,
			};
		},
	};
}

// --- stepfun (prepaid balance, CNY) ----------------------------------------

interface StepfunAccountPayload {
	object?: string;
	type?: string;
	balance?: number;
	total_cash_balance?: number;
	total_voucher_balance?: number;
}

const STEPFUN_ACCOUNT_TYPE_LABELS: Record<string, string> = {
	prepaid: "预付费",
	postpaid: "后付费",
};

function stepfunDef(): ProviderDef {
	return {
		name: "stepfun",
		title: "StepFun 余额",
		ids: ["stepfun", "stepfun-ai"],
		envKeys: ["STEPFUN_API_KEY"],
		authIDs: ["stepfun"],
		hosts: ["api.stepfun.com"],
		async fetch(key, signal) {
			const res = await fetch(STEPFUN_ACCOUNT_URL, {
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				signal,
			});
			if (!res.ok) throw new HttpError(res.status);
			const payload = await getJson<StepfunAccountPayload>(res);
			const balance = typeof payload.balance === "number" ? payload.balance : undefined;
			if (balance === undefined) return undefined;

			const fmt = (n: number | undefined): string => (n === undefined ? "?" : n.toFixed(2));
			const typeLabel = STEPFUN_ACCOUNT_TYPE_LABELS[payload.type ?? ""] ?? payload.type ?? "?";
			return {
				kind: "balance",
				title: "StepFun 余额",
				text: `💰 ¥${fmt(balance)}`,
				tone: balance < 5 ? "error" : balance < 20 ? "warning" : "success",
				detailLines: [
					`可用余额: ¥${fmt(balance)}`,
					`充值总额: ¥${fmt(payload.total_cash_balance)}`,
					`赠送总额: ¥${fmt(payload.total_voucher_balance)}`,
					`账户类型: ${typeLabel}`,
				],
			};
		},
	};
}

// --- zai / zhipu (GLM Coding Plan credits) ---------------------------------

interface ZaiQuotaLimit {
	type?: string;
	usage?: number;
	currentValue?: number;
	remaining?: number;
	percentage?: number;
	nextResetTime?: number;
}

interface ZaiQuotaPayload {
	success?: boolean;
	data?: { level?: string; limits?: ZaiQuotaLimit[] };
}

const ZAI_LEVEL_LABELS: Record<string, string> = { lite: "Lite", pro: "Pro", max: "Max" };

function zaiSite(context: ProviderContext): keyof typeof ZAI_QUOTA_URL {
	if (context.providerID === "zai" || context.providerID === "zai-coding-plan") return "intl";
	return "cn";
}

/**
 * Tries each `[url, tag]` site in order. A 401/403 means "this key belongs
 * to the other site" for providers running CN + international platforms
 * under one adapter, so the next site is attempted; other failures
 * propagate. `tag` carries per-site metadata (e.g. currency).
 */
async function fetchSites<T, Tag>(
	sites: ReadonlyArray<readonly [url: string, tag: Tag]>,
	signal: AbortSignal,
	request: (url: string, tag: Tag) => Promise<T>,
): Promise<T> {
	let lastError: unknown;
	for (const [url, tag] of sites) {
		try {
			return await request(url, tag);
		} catch (err) {
			lastError = err;
			const status = (err as { status?: number }).status;
			if (status === 401 || status === 403) continue;
			throw err;
		}
	}
	throw lastError;
}

function zaiDef(): ProviderDef {
	const ids = ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai", "zhipuglm"];
	return {
		name: "zai",
		title: "GLM Coding Plan 额度",
		ids: [...ids],
		envKeys: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
		authIDs: ids,
		hosts: ["open.bigmodel.cn", "api.z.ai", "bigmodel.cn"],
		async fetch(key, signal, context) {
			const request = async (url: string): Promise<UsageData | undefined> => {
				// GLM quota endpoint expects the raw key in Authorization (no "Bearer").
				const res = await fetch(url, {
					headers: { Authorization: key, Accept: "application/json" },
					signal,
				});
				if (!res.ok) throw new HttpError(res.status);
				const payload = await getJson<ZaiQuotaPayload & { code?: number; msg?: string }>(res);
				// The GLM monitor API reports auth failures as HTTP 200 + success:false.
				if (payload.success === false) throw new HttpError(401);
				if (!payload.data?.limits?.length) return undefined;

				const levelLabel = ZAI_LEVEL_LABELS[payload.data.level ?? ""] ?? payload.data.level;
				// CREDIT_LIMIT windows sorted by total credits ascending = 5h / weekly / ...
				const windows = payload.data.limits
					.filter((l) => typeof l.percentage === "number")
					.sort((a, b) => (a.usage ?? 0) - (b.usage ?? 0));
				const labels = ["5h", "7d", "30d"];

				const segments: UsageSegment[] = [];
				const detailLines: string[] = [];
				if (levelLabel) detailLines.push(`套餐 ${levelLabel}`);
				for (const [index, win] of windows.entries()) {
					const label = labels[index] ?? `W${index + 1}`;
					const segment: UsageSegment = {
						label,
						percent: pct(win.percentage ?? 0),
					};
					if (typeof win.nextResetTime === "number") {
						segment.reset = new Date(win.nextResetTime).toISOString();
					}
					if (typeof win.currentValue === "number" && typeof win.usage === "number") {
						segment.note = `已用 ${win.currentValue}/${win.usage} 积分`;
					}
					segments.push(segment);
				}
				if (!segments.length) return undefined;
				return { kind: "percent", title: "GLM Coding Plan 额度", segments, detailLines };
			};

			// A known provider id picks the site; otherwise try both (CN then intl).
			const sites: ReadonlyArray<readonly [string, keyof typeof ZAI_QUOTA_URL]> = context.providerID
				? [[ZAI_QUOTA_URL[zaiSite(context)], zaiSite(context)]]
				: [
						[ZAI_QUOTA_URL.cn, "cn"],
						[ZAI_QUOTA_URL.intl, "intl"],
					];
			return fetchSites(sites, signal, (url) => request(url));
		},
	};
}

/** Shared low-balance colouring for prepaid accounts. */
function balanceTone(amount: number): Tone {
	return amount < 5 ? "error" : amount < 20 ? "warning" : "success";
}

/** Accepts numbers or numeric strings, as several APIs are inconsistent. */
function num(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
	return n !== undefined && Number.isFinite(n) ? n : undefined;
}

// --- moonshot / kimi (pay-as-you-go balance) --------------------------------

interface MoonshotBalancePayload {
	code?: number;
	status?: boolean;
	data?: {
		available_balance?: number | string;
		voucher_balance?: number | string;
		cash_balance?: number | string;
	};
}

const MOONSHOT_BALANCE_URL = {
	cn: "https://api.moonshot.cn/v1/users/me/balance", // CNY
	intl: "https://api.moonshot.ai/v1/users/me/balance", // USD
} as const;

function moonshotDef(): ProviderDef {
	return {
		name: "moonshot",
		title: "Kimi / Moonshot 余额",
		ids: ["moonshotai", "moonshotai-cn", "moonshot"],
		envKeys: ["MOONSHOT_API_KEY"],
		authIDs: ["moonshotai", "moonshotai-cn", "moonshot"],
		hosts: ["api.moonshot.cn", "api.moonshot.ai"],
		async fetch(key, signal, context) {
			const request = async (url: string, currency: string): Promise<UsageData | undefined> => {
				const res = await fetch(url, {
					headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
					signal,
				});
				if (!res.ok) throw new HttpError(res.status);
				const payload = await getJson<MoonshotBalancePayload>(res);
				if (payload.code !== undefined && payload.code !== 0) throw new HttpError(401);
				const available = num(payload.data?.available_balance);
				if (available === undefined) return undefined;
				const voucher = num(payload.data?.voucher_balance);
				const cash = num(payload.data?.cash_balance);
				return {
					kind: "balance",
					title: "Kimi / Moonshot 余额",
					text: `💰 ${formatMoney(available, currency)}`,
					tone: balanceTone(available),
					detailLines: [
						`可用余额: ${formatMoney(available, currency)}（现金 ${formatMoney(cash, currency)} / 赠送 ${formatMoney(voucher, currency)}）`,
					],
				};
			};

			const intl = context.providerID === "moonshotai" || hostOf(context.baseUrl) === "api.moonshot.ai";
			const sites: ReadonlyArray<readonly [string, string]> = intl
				? [[MOONSHOT_BALANCE_URL.intl, "USD"]]
				: [
						[MOONSHOT_BALANCE_URL.cn, "CNY"],
						[MOONSHOT_BALANCE_URL.intl, "USD"],
					];
			return fetchSites(sites, signal, (url, currency) => request(url, currency));
		},
	};
}

// --- siliconflow (pay-as-you-go balance) ------------------------------------

interface SiliconflowInfoPayload {
	code?: number;
	status?: boolean;
	message?: string;
	data?: {
		balance?: string | number;
		chargeBalance?: string | number;
		totalBalance?: string | number;
		status?: string;
	};
}

const SILICONFLOW_INFO_URL = {
	cn: "https://api.siliconflow.cn/v1/user/info", // CNY
	intl: "https://api.siliconflow.com/v1/user/info", // USD
} as const;

function siliconflowDef(): ProviderDef {
	return {
		name: "siliconflow",
		title: "SiliconFlow 余额",
		ids: ["siliconflow", "siliconflow-cn"],
		envKeys: ["SILICONFLOW_API_KEY", "SILICONFLOW_CN_API_KEY"],
		authIDs: ["siliconflow", "siliconflow-cn"],
		hosts: ["api.siliconflow.cn", "api.siliconflow.com"],
		async fetch(key, signal, context) {
			const request = async (url: string, currency: string): Promise<UsageData | undefined> => {
				const res = await fetch(url, {
					headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
					signal,
				});
				if (!res.ok) throw new HttpError(res.status);
				const payload = await getJson<SiliconflowInfoPayload>(res);
				if (payload.status === false) throw new HttpError(401);
				const balance = num(payload.data?.balance);
				if (balance === undefined) return undefined;
				const charge = num(payload.data?.chargeBalance);
				const total = num(payload.data?.totalBalance);
				const status = payload.data?.status ? `（账户 ${payload.data.status}）` : "";
				return {
					kind: "balance",
					title: "SiliconFlow 余额",
					text: `💰 ${formatMoney(balance, currency)}`,
					tone: balanceTone(balance),
					detailLines: [
						`可用余额: ${formatMoney(balance, currency)}（充值 ${formatMoney(charge, currency)} / 累计 ${formatMoney(total, currency)}）${status}`,
					],
				};
			};

			const cn = context.providerID === "siliconflow-cn" || hostOf(context.baseUrl) === "api.siliconflow.cn";
			const sites: ReadonlyArray<readonly [string, string]> = cn
				? [[SILICONFLOW_INFO_URL.cn, "CNY"]]
				: [
						[SILICONFLOW_INFO_URL.intl, "USD"],
						[SILICONFLOW_INFO_URL.cn, "CNY"],
					];
			return fetchSites(sites, signal, (url, currency) => request(url, currency));
		},
	};
}

// --- openrouter (prepaid credits) -------------------------------------------

interface OpenrouterCreditsPayload {
	data?: { total_credits?: number; total_usage?: number };
}

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

function openrouterDef(): ProviderDef {
	return {
		name: "openrouter",
		title: "OpenRouter 额度",
		ids: ["openrouter"],
		envKeys: ["OPENROUTER_API_KEY"],
		authIDs: ["openrouter"],
		hosts: ["openrouter.ai"],
		async fetch(key, signal) {
			const res = await fetch(OPENROUTER_CREDITS_URL, {
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				signal,
			});
			if (res.status === 403) {
				// The credits endpoint only accepts management keys.
				throw new Error("该 Key 无权限：OpenRouter 额度查询需要 Management Key");
			}
			if (!res.ok) throw new HttpError(res.status);
			const payload = await getJson<OpenrouterCreditsPayload>(res);
			const total = num(payload.data?.total_credits);
			const used = num(payload.data?.total_usage);
			if (total === undefined || used === undefined) return undefined;
			const remaining = total - used;
			return {
				kind: "balance",
				title: "OpenRouter 额度",
				text: `💰 ${formatMoney(remaining, "USD")}`,
				tone: balanceTone(remaining),
				detailLines: [
					`剩余额度: ${formatMoney(remaining, "USD")}（已用 ${formatMoney(used, "USD")} / 总充值 ${formatMoney(total, "USD")}）`,
				],
			};
		},
	};
}

// --- skywork (pay-as-you-go balance) ----------------------------------------

interface SkyworkBalancePayload {
	code?: number;
	resp_data?: {
		available_amount?: number;
		total_amount?: number;
		consumed_amount?: number;
		currency?: string;
	};
}

const SKYWORK_BALANCE_URL = "https://api.skyworkmodel.ai/api/v1/balance";

function skyworkDef(): ProviderDef {
	return {
		name: "skywork",
		title: "Skywork 余额",
		ids: ["skywork", "skyworkmodel"],
		envKeys: ["SKYWORK_API_KEY"],
		authIDs: ["skywork"],
		hosts: ["api.skyworkmodel.ai"],
		async fetch(key, signal) {
			const res = await fetch(SKYWORK_BALANCE_URL, {
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				signal,
			});
			if (!res.ok) throw new HttpError(res.status);
			const payload = await getJson<SkyworkBalancePayload>(res);
			const available = num(payload.resp_data?.available_amount);
			if (available === undefined) return undefined;
			const currency = payload.resp_data?.currency ?? "USD";
			const total = num(payload.resp_data?.total_amount);
			const consumed = num(payload.resp_data?.consumed_amount);
			return {
				kind: "balance",
				title: "Skywork 余额",
				text: `💰 ${formatMoney(available, currency)}`,
				tone: balanceTone(available),
				detailLines: [
					`可用余额: ${formatMoney(available, currency)}（已用 ${formatMoney(consumed, currency)} / 累计 ${formatMoney(total, currency)}）`,
				],
			};
		},
	};
}

// --- novita (pay-as-you-go balance) -----------------------------------------

interface NovitaBalancePayload {
	availableBalance?: string;
	cashBalance?: string;
	creditLimit?: string;
	pendingCharges?: string;
}

const NOVITA_BALANCE_URL = "https://api.novita.ai/openapi/v1/billing/balance/detail";
/** Novita reports money in 1/10000 USD. */
const NOVITA_UNIT = 10_000;

function novitaDef(): ProviderDef {
	return {
		name: "novita",
		title: "Novita 余额",
		ids: ["novita", "novita-ai"],
		envKeys: ["NOVITA_API_KEY"],
		authIDs: ["novita"],
		hosts: ["api.novita.ai"],
		async fetch(key, signal) {
			const res = await fetch(NOVITA_BALANCE_URL, {
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				signal,
			});
			if (!res.ok) throw new HttpError(res.status);
			const payload = await getJson<NovitaBalancePayload>(res);
			const availableUnits = num(payload.availableBalance);
			if (availableUnits === undefined) return undefined;
			const usd = (units: number | undefined): string =>
				units === undefined ? "?" : (units / NOVITA_UNIT).toFixed(2);
			const available = availableUnits / NOVITA_UNIT;
			return {
				kind: "balance",
				title: "Novita 余额",
				text: `💰 $${usd(availableUnits)}`,
				tone: balanceTone(available),
				detailLines: [
					`可用余额: $${usd(availableUnits)}（现金 $${usd(num(payload.cashBalance))} / 信用额度 $${usd(num(payload.creditLimit))}）`,
				],
			};
		},
	};
}

// --- openai-codex (ChatGPT subscription windows) ---------------------------

interface OpenAICodexUsageWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

interface OpenAICodexUsagePayload {
	plan_type?: string;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: OpenAICodexUsageWindow | null;
		secondary_window?: OpenAICodexUsageWindow | null;
	};
	credits?: {
		has_credits?: boolean;
		unlimited?: boolean;
		overage_limit_reached?: boolean;
		balance?: number | null;
	};
	spend_control?: { reached?: boolean };
	rate_limit_reset_credits?: { applicable_available_count?: number };
}

function codexAccountId(accessToken: string): string | undefined {
	try {
		const part = accessToken.split(".")[1];
		if (!part) return undefined;
		const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = payload["https://api.openai.com/auth"];
		const accountId =
			auth && typeof auth === "object"
				? (auth as Record<string, unknown>).chatgpt_account_id
				: undefined;
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function codexResetIso(win: OpenAICodexUsageWindow): string | undefined {
	if (typeof win.reset_after_seconds === "number") {
		return new Date(Date.now() + win.reset_after_seconds * 1_000).toISOString();
	}
	if (typeof win.reset_at === "number") {
		const ms = win.reset_at < 1_000_000_000_000 ? win.reset_at * 1_000 : win.reset_at;
		return new Date(ms).toISOString();
	}
	return undefined;
}

function openaiCodexDef(): ProviderDef {
	return {
		name: "openai-codex",
		title: "OpenAI Codex 额度",
		ids: ["openai-codex", "codex"],
		envKeys: [],
		authIDs: ["openai-codex"],
		hosts: ["chatgpt.com"],
		async fetch(accessToken, signal) {
			const accountId = codexAccountId(accessToken);
			if (!accountId) return undefined;
			const res = await fetch(OPENAI_CODEX_USAGE_URL, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"ChatGPT-Account-Id": accountId,
					Accept: "application/json",
					"User-Agent": "opencode-provider-usage/1.0",
				},
				signal,
			});
			if (!res.ok) throw new HttpError(res.status);
			const payload = await getJson<OpenAICodexUsagePayload>(res);
			const rateLimit = payload.rate_limit;
			if (!rateLimit) return undefined;

			const windows: Array<[string, OpenAICodexUsageWindow | null | undefined]> = [
				["主额度", rateLimit.primary_window],
				["次额度", rateLimit.secondary_window],
			];
			const segments: UsageSegment[] = [];
			const detailLines: string[] = [];
			if (payload.plan_type) detailLines.push(`套餐 ${payload.plan_type}`);
			for (const [fallbackLabel, win] of windows) {
				if (!win || typeof win.used_percent !== "number") continue;
				const label =
					typeof win.limit_window_seconds === "number"
						? formatDuration(win.limit_window_seconds)
						: fallbackLabel;
				segments.push({ label, percent: pct(win.used_percent), reset: codexResetIso(win) });
			}
			if (rateLimit.limit_reached || rateLimit.allowed === false) {
				detailLines.push("⚠ 当前额度已耗尽");
			} else {
				detailLines.push("当前额度可用");
			}
			const credits = payload.credits;
			if (typeof credits?.balance === "number") {
				detailLines.push(`Credits 余额 ${credits.balance.toFixed(2)}`);
			} else if (credits?.unlimited) {
				detailLines.push("Credits 不限额");
			}
			if (credits?.overage_limit_reached) detailLines.push("⚠ 额外 Credits 已达上限");
			if (payload.spend_control?.reached) detailLines.push("⚠ 已触及账户支出上限");
			const resets = payload.rate_limit_reset_credits;
			if (typeof resets?.applicable_available_count === "number") {
				detailLines.push(`可用额度重置 ${resets.applicable_available_count} 次`);
			}

			if (segments.length) {
				return { kind: "percent", title: "OpenAI Codex 额度", segments, detailLines };
			}
			return {
				kind: "balance",
				title: "OpenAI Codex 额度",
				text:
					rateLimit.limit_reached || rateLimit.allowed === false ? "⚡ 额度已耗尽" : "⚡ 额度可用",
				tone: rateLimit.limit_reached || rateLimit.allowed === false ? "error" : "success",
				detailLines,
			};
		},
	};
}

export function providerDefs(): ProviderDef[] {
	return [
		opencodeDef(),
		deepseekDef(),
		stepfunDef(),
		openaiCodexDef(),
		zaiDef(),
		moonshotDef(),
		siliconflowDef(),
		openrouterDef(),
		skyworkDef(),
		novitaDef(),
	];
}

/** The provider serving the given model, if any. */
export function matchProvider(
	defs: readonly ProviderDef[],
	context: ProviderContext,
): ProviderDef | undefined {
	return defs.find((def) => matchesDef(def, context));
}
