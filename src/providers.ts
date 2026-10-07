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
	formatReset,
} from "./format.js";
import type { UsageData, UsageSegment } from "./types.js";

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
	/** Integration ids tried in order when resolving a credential. */
	integrationIDs: string[];
	/** Environment variables holding the key, tried after integrations. */
	envKeys: string[];
	/** Legacy `auth.json` provider ids, tried last. */
	authIDs: string[];
	/** Whether this provider serves the given model. */
	matches(context: ProviderContext): boolean;
	fetch(key: string, signal: AbortSignal, context: ProviderContext): Promise<UsageData | undefined>;
}

function hostIs(context: ProviderContext, host: string): boolean {
	if (!context.baseUrl) return false;
	try {
		return new URL(context.baseUrl).hostname === host;
	} catch {
		return false;
	}
}

/** Parses a response body as JSON, throwing a descriptive error on garbage. */
async function getJson<T>(res: Response): Promise<T> {
	let text: string;
	try {
		text = await res.text();
	} catch {
		throw new Error("读取响应体失败");
	}
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
		integrationIDs: ["opencode-go", "opencode"],
		envKeys: ["OPENCODE_API_KEY"],
		authIDs: ["opencode-go", "opencode"],
		matches: (c) =>
			c.providerID === "opencode" || c.providerID === "opencode-go" || hostIs(c, "opencode.ai"),
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
			const detailLines: string[] = [];
			for (const [label, win] of windows) {
				if (typeof win?.percent !== "number") continue;
				const percent = pct(win.percent);
				segments.push({ label, percent, reset: win.resetsAt });
				const flag = win.status && win.status !== "ok" ? ` [${win.status}]` : "";
				detailLines.push(`• ${label}: ${percent}% — 重置 ${formatReset(win.resetsAt)}${flag}`);
			}
			if (!segments.length) return undefined;
			return { kind: "percent", title: "OpenCode 额度", segments, detailLines };
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
		integrationIDs: ["deepseek"],
		envKeys: ["DEEPSEEK_API_KEY"],
		authIDs: ["deepseek"],
		matches: (c) => c.providerID === "deepseek" || hostIs(c, "api.deepseek.com"),
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
					`• ${currency}: 总额 ${formatMoney(info.total_balance, currency)}` +
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
		integrationIDs: ["stepfun", "stepfun-ai"],
		envKeys: ["STEPFUN_API_KEY"],
		authIDs: ["stepfun"],
		matches: (c) =>
			c.providerID === "stepfun" || c.providerID === "stepfun-ai" || hostIs(c, "api.stepfun.com"),
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
					`• 可用余额: ¥${fmt(balance)}`,
					`• 充值总额: ¥${fmt(payload.total_cash_balance)}`,
					`• 赠送总额: ¥${fmt(payload.total_voucher_balance)}`,
					`• 账户类型: ${typeLabel}`,
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

function zaiDef(): ProviderDef {
	const ids = ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai", "zhipuglm"];
	return {
		name: "zai",
		title: "GLM Coding Plan 额度",
		integrationIDs: ids,
		envKeys: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
		authIDs: ids,
		matches: (c) =>
			(c.providerID !== undefined && ids.includes(c.providerID)) ||
			hostIs(c, "open.bigmodel.cn") ||
			hostIs(c, "api.z.ai"),
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
				if (levelLabel) detailLines.push(`• 套餐: ${levelLabel}`);
				for (const [index, win] of windows.entries()) {
					const label = labels[index] ?? `W${index + 1}`;
					const percent = pct(win.percentage ?? 0);
					const resetIso =
						typeof win.nextResetTime === "number"
							? new Date(win.nextResetTime).toISOString()
							: undefined;
					segments.push({ label, percent, reset: resetIso });
					const used =
						typeof win.currentValue === "number" && typeof win.usage === "number"
							? `${win.currentValue}/${win.usage}`
							: "?";
					detailLines.push(
						`• ${label}: ${percent}%（已用 ${used} 积分）— 重置 ${formatReset(resetIso)}`,
					);
				}
				if (!segments.length) return undefined;
				return { kind: "percent", title: "GLM Coding Plan 额度", segments, detailLines };
			};

			// A known provider id picks the site; otherwise try both (CN then intl).
			const sites: Array<keyof typeof ZAI_QUOTA_URL> = context.providerID
				? [zaiSite(context)]
				: ["cn", "intl"];
			let lastError: unknown;
			for (const site of sites) {
				try {
					return await request(ZAI_QUOTA_URL[site]);
				} catch (err) {
					lastError = err;
					const status = (err as { status?: number }).status;
					if (status === 401 || status === 403) continue;
					throw err;
				}
			}
			throw lastError;
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
		integrationIDs: ["openai-codex", "openai"],
		envKeys: [],
		authIDs: ["openai-codex"],
		matches: (c) => Boolean(c.providerID?.includes("codex")) || hostIs(c, "chatgpt.com"),
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
			if (payload.plan_type) detailLines.push(`• 套餐: ${payload.plan_type}`);
			for (const [fallbackLabel, win] of windows) {
				if (!win || typeof win.used_percent !== "number") continue;
				const label =
					typeof win.limit_window_seconds === "number"
						? formatDuration(win.limit_window_seconds)
						: fallbackLabel;
				const percent = pct(win.used_percent);
				const resetIso = codexResetIso(win);
				segments.push({ label, percent, reset: resetIso });
				detailLines.push(`• ${label}: ${percent}% — 重置 ${formatReset(resetIso)}`);
			}
			if (rateLimit.limit_reached || rateLimit.allowed === false) {
				detailLines.push("• ⚠ 当前额度已耗尽");
			} else {
				detailLines.push("• 当前额度: 可用");
			}
			const credits = payload.credits;
			if (typeof credits?.balance === "number") {
				detailLines.push(`• Credits 余额: ${credits.balance.toFixed(2)}`);
			} else if (credits?.unlimited) {
				detailLines.push("• Credits: 不限额");
			}
			if (credits?.overage_limit_reached) detailLines.push("• ⚠ 额外 Credits 已达上限");
			if (payload.spend_control?.reached) detailLines.push("• ⚠ 已触及账户支出上限");
			const resets = payload.rate_limit_reset_credits;
			if (typeof resets?.applicable_available_count === "number") {
				detailLines.push(`• 可用额度重置: ${resets.applicable_available_count} 次`);
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
	return [opencodeDef(), deepseekDef(), stepfunDef(), openaiCodexDef(), zaiDef()];
}

/** The provider serving the given model, if any. */
export function matchProvider(
	defs: readonly ProviderDef[],
	context: ProviderContext,
): ProviderDef | undefined {
	return defs.find((def) => def.matches(context));
}
