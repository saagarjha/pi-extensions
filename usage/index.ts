import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type AnyRecord = Record<string, any>;

function toNumber(value: unknown): number {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
	return Number.isFinite(number) ? number : 0;
}

function formatPercent(value: unknown): string | undefined {
	const number = toNumber(value);
	return Number.isFinite(number) ? `${number.toFixed(number % 1 === 0 ? 0 : 1)}%` : undefined;
}

function formatDateFromSeconds(value: unknown): string | undefined {
	const seconds = toNumber(value);
	if (!seconds) return undefined;
	const date = new Date(seconds * 1000);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toLocaleString();
}

function formatWindow(window: any): string | undefined {
	if (!window) return undefined;
	const parts = [formatPercent(window.used_percent ?? window.usedPercent ?? window.used) ?? undefined];
	const minutes = toNumber(window.window_minutes ?? window.windowMinutes);
	if (minutes) parts.push(`${minutes}m window`);
	const reset = formatDateFromSeconds(window.resets_at ?? window.resetsAt ?? window.reset_at ?? window.resetAt);
	if (reset) parts.push(`resets ${reset}`);
	return parts.filter(Boolean).join(", ");
}

function pickAuthValue(auth: any, names: string[]): string | undefined {
	const seen = new Set<any>();
	function visit(value: any): string | undefined {
		if (!value || typeof value !== "object" || seen.has(value)) return undefined;
		seen.add(value);
		for (const name of names) {
			const direct = value[name];
			if (typeof direct === "string" && direct.trim()) return direct;
		}
		for (const nested of Object.values(value)) {
			const found = visit(nested);
			if (found) return found;
		}
		return undefined;
	}
	return visit(auth);
}

async function resolvedProviderAuth(ctx: any, providerId: string): Promise<any> {
	try {
		return await Promise.resolve(ctx.modelRegistry.getProviderAuth(providerId));
	} catch {
		return undefined;
	}
}

function addAuthHeaders(headers: Headers, auth: any) {
	const providerHeaders = auth?.headers ?? auth?.auth?.headers;
	if (providerHeaders && typeof providerHeaders === "object") {
		for (const [key, value] of Object.entries(providerHeaders)) {
			if (typeof value === "string") headers.set(key, value);
		}
	}
	const apiKey = auth?.auth?.apiKey ?? auth?.apiKey ?? pickAuthValue(auth, ["access", "access_token", "accessToken", "key", "apiKey"]);
	if (typeof apiKey === "string" && apiKey.trim() && !headers.has("authorization")) {
		headers.set("authorization", apiKey.toLowerCase().startsWith("bearer ") ? apiKey : `Bearer ${apiKey}`);
	}
	const accountId = pickAuthValue(auth, ["chatgpt_account_id", "chatgptAccountId", "account_id", "accountId"]);
	if (accountId && !headers.has("chatgpt-account-id")) headers.set("chatgpt-account-id", accountId);
}

function codexUsageUrl(baseUrl: string): string {
	let base = baseUrl.replace(/\/+$/, "");
	if ((base.startsWith("https://chatgpt.com") || base.startsWith("https://chat.openai.com")) && !base.includes("/backend-api")) {
		base += "/backend-api";
	}
	return base.includes("/backend-api") ? `${base}/wham/usage` : `${base}/api/codex/usage`;
}

function formatCodexRateLimit(label: string, details: any): string[] {
	const lines: string[] = [];
	const rateLimit = details?.rate_limit ?? details?.rateLimit;
	const primary = formatWindow(rateLimit?.primary_window ?? rateLimit?.primaryWindow ?? details?.primary);
	const secondary = formatWindow(rateLimit?.secondary_window ?? rateLimit?.secondaryWindow ?? details?.secondary);
	if (primary) lines.push(`${label} primary: ${primary}`);
	if (secondary) lines.push(`${label} secondary: ${secondary}`);
	return lines;
}

async function codexSubscriptionUsage(ctx: any, model: any): Promise<string[] | undefined> {
	const provider = String(model?.provider ?? "").toLowerCase();
	const id = String(model?.id ?? "").toLowerCase();
	const api = String(model?.api ?? "").toLowerCase();
	if (!provider.includes("codex") && !id.includes("codex") && !api.includes("codex")) return undefined;

	const auth = await resolvedProviderAuth(ctx, model.provider);
	const baseUrl = auth?.baseUrl ?? model?.baseUrl ?? "https://chatgpt.com/backend-api";
	const headers = new Headers({ accept: "application/json", "user-agent": "pi-usage-extension" });
	addAuthHeaders(headers, auth);
	if (!headers.has("authorization")) return ["Codex subscription: unavailable (no bearer auth for active model)"];

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const response = await fetch(codexUsageUrl(String(baseUrl)), { headers, signal: controller.signal });
		if (!response.ok) return [`Codex subscription: unavailable (${response.status} ${response.statusText})`];
		const payload = await response.json() as AnyRecord;
		const lines = [`Codex plan: ${payload.plan_type ?? "unknown"}`];
		lines.push(...formatCodexRateLimit("Codex", payload));
		const credits = payload.credits;
		if (credits) {
			if (credits.unlimited) lines.push("Credits: unlimited");
			else if (credits.balance != null) lines.push(`Credits: ${credits.balance}`);
			else if (credits.has_credits != null) lines.push(`Credits: ${credits.has_credits ? "available" : "none"}`);
		}
		for (const extra of payload.additional_rate_limits ?? []) {
			lines.push(...formatCodexRateLimit(extra.limit_name ?? extra.metered_feature ?? "Additional limit", extra));
		}
		return lines.length > 1 ? lines : ["Codex subscription: usage unavailable in response"];
	} catch (error) {
		return [`Codex subscription: unavailable (${error instanceof Error ? error.message : String(error)})`];
	} finally {
		clearTimeout(timeout);
	}
}

function claudeSubscriptionUsage(model: any): string[] | undefined {
	const provider = String(model?.provider ?? "").toLowerCase();
	const id = String(model?.id ?? "").toLowerCase();
	if (!provider.includes("anthropic") && !provider.includes("claude") && !id.includes("claude")) return undefined;
	return ["Claude subscription usage: unsupported by available auth; see https://claude.ai/settings/usage"];
}

export default function extension(pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show usage for the active model",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const model = ctx.model as any;
			const providerLines = model
				? (await codexSubscriptionUsage(ctx, model)) ?? claudeSubscriptionUsage(model) ?? ["Subscription: unavailable for active provider"]
				: ["Subscription: unavailable (no active model)"];
			ctx.ui.notify(["Usage", "", ...providerLines].join("\n"), "info");
		},
	});
}
