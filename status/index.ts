import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

let focused = true;
let focusReportingEnabled = false;
let focusListenerInstalled = false;
let cleanupInstalled = false;
let unsubscribeFocusListener: (() => void) | undefined;

type IdleStatusBridge = {
	backgroundActiveCount?: () => number;
	subagentsActiveCount?: () => number;
};

function idleStatusBridge(): IdleStatusBridge {
	return ((globalThis as typeof globalThis & { __piIdleStatus?: IdleStatusBridge }).__piIdleStatus ??= {});
}

function hasActiveAsyncWork(): boolean {
	const bridge = idleStatusBridge();
	return (bridge.backgroundActiveCount?.() ?? 0) > 0 || (bridge.subagentsActiveCount?.() ?? 0) > 0;
}

function writeTerminalSequence(sequence: string): void {
	if (!sequence) return;
	if (process.env.TMUX) {
		process.stdout.write(`\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`);
		return;
	}
	process.stdout.write(sequence);
}

function cleanOscText(text: string): string {
	return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").replace(/[\x1b\x07]/g, "").replace(/\s+/g, " ").trim();
}

function setupPromptNotifications(ctx: ExtensionContext): void {
	if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui.onTerminalInput) return;
	if (!focusReportingEnabled && process.env.PI_NATIVE_NOTIFY_FOCUS !== "0") {
		writeTerminalSequence(ENABLE_FOCUS_REPORTING);
		focusReportingEnabled = true;
		if (!cleanupInstalled) {
			cleanupInstalled = true;
			process.once("exit", () => {
				if (focusReportingEnabled) writeTerminalSequence(DISABLE_FOCUS_REPORTING);
			});
		}
	}
	if (focusListenerInstalled) return;
	focusListenerInstalled = true;
	unsubscribeFocusListener = ctx.ui.onTerminalInput((data) => {
		if (data === FOCUS_IN) {
			focused = true;
			return { consume: true };
		}
		if (data === FOCUS_OUT) {
			focused = false;
			return { consume: true };
		}
		return undefined;
	});
}

function teardownPromptNotifications(): void {
	unsubscribeFocusListener?.();
	unsubscribeFocusListener = undefined;
	focusListenerInstalled = false;
	if (focusReportingEnabled) {
		writeTerminalSequence(DISABLE_FOCUS_REPORTING);
		focusReportingEnabled = false;
	}
}

function notifyPromptIfUnfocused(title: string, body?: string): void {
	if (focused || process.env.PI_NATIVE_NOTIFY === "0") return;
	const message = cleanOscText(body ? `${title}: ${body}` : title);
	if (message) writeTerminalSequence(`\x1b]9;${message}\x07`);
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => String(part.text ?? ""))
		.join("\n");
}

function lastAssistantResponse(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries() as Array<any>;
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = entries[i]?.message;
		if (message?.role !== "assistant") continue;
		const text = cleanOscText(textContent(message.content));
		if (!text) continue;
		return text.length > 180 ? `${text.slice(0, 177)}...` : text;
	}
	return undefined;
}

interface AccountStore {
	activeAccount?: string;
	providers?: Record<string, Array<{ providerId?: string }>>;
}

const accountStorePath = join(getAgentDir(), "auth-accounts.json");

function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function accountForProvider(providerId?: string): string | undefined {
	if (!providerId) return undefined;
	const store = readJson<Partial<AccountStore>>(accountStorePath, {});
	for (const [account, providers] of Object.entries(store.providers ?? {})) {
		if (providers.some((provider) => provider.providerId === providerId)) return account;
	}
	return typeof store.activeAccount === "string" ? store.activeAccount : undefined;
}

function toNumber(value: unknown): number {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
	return Number.isFinite(number) ? number : 0;
}

function usageCost(usage: any): number {
	const cost = usage?.cost;
	if (typeof cost === "number" || typeof cost === "string") return toNumber(cost);
	return toNumber(cost?.total ?? cost?.amount);
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function widthOf(text: string): number {
	return stripAnsi(text).length;
}

function truncatePlain(text: string, maxWidth: number, ellipsis = "..."): string {
	const plain = stripAnsi(text);
	if (plain.length <= maxWidth) return text;
	if (maxWidth <= 0) return "";
	if (maxWidth <= ellipsis.length) return ellipsis.slice(0, maxWidth);
	return `${plain.slice(0, maxWidth - ellipsis.length)}${ellipsis}`;
}

function formatTokens(value: unknown): string {
	const count = Math.max(0, toNumber(value));
	if (count < 1000) return `${Math.round(count)}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function collectUsage(ctx: ExtensionContext) {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries() as Array<any>) {
		const message = entry?.message;
		const usage = message?.usage ?? entry?.usage;
		if (!usage || typeof usage !== "object") continue;
		if (message && message.role !== "assistant" && message.role !== "toolResult") continue;

		totals.input += toNumber(usage.input);
		totals.output += toNumber(usage.output);
		totals.cacheRead += toNumber(usage.cacheRead);
		totals.cacheWrite += toNumber(usage.cacheWrite);
		totals.cost += usageCost(usage);

		if (message?.role === "assistant") {
			const promptTokens = toNumber(usage.input) + toNumber(usage.cacheRead) + toNumber(usage.cacheWrite);
			latestCacheHitRate = promptTokens > 0 ? (toNumber(usage.cacheRead) / promptTokens) * 100 : undefined;
		}
	}

	return { totals, latestCacheHitRate };
}

function installFooter(ctx: ExtensionContext): void {
	ctx.ui.setFooter((_tui: any, theme: any, footerData: any) => ({
		invalidate(): void {},
		render(width: number): string[] {
			try {
				const { totals, latestCacheHitRate } = collectUsage(ctx);
				const context = ctx.getContextUsage();
				const model = ctx.model;
				const contextWindow = context?.contextWindow ?? model?.contextWindow ?? 0;
				const contextPercent = context?.percent == null ? undefined : toNumber(context.percent);
				const contextDisplay = contextPercent === undefined ? `?/${formatTokens(contextWindow)}` : `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
				const coloredContext = contextPercent !== undefined && contextPercent > 90
					? theme.fg("error", contextDisplay)
					: contextPercent !== undefined && contextPercent > 70
						? theme.fg("warning", contextDisplay)
						: contextDisplay;

				const stats: string[] = [];
				if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
				if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
				if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
				if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
				if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				if (totals.cost) stats.push(`$${totals.cost.toFixed(3)}`);
				stats.push(coloredContext);
				const left = theme.fg("dim", stats.join(" "));

				const account = accountForProvider(model?.provider);
				const modelName = model?.id ?? "no-model";
				const thinkingSuffix = ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ` • ${ctx.thinkingLevel}` : "";
				const modelSuffix = `${modelName}${thinkingSuffix}`;
				let right = account
					? `${theme.fg("accent", account)} ${theme.fg("dim", modelSuffix)}`
					: theme.fg("dim", modelSuffix);
				if (!account && model && footerData.getAvailableProviderCount() > 1) {
					const withProvider = theme.fg("dim", `(${model.provider}) ${modelSuffix}`);
					if (widthOf(left) + 2 + widthOf(withProvider) <= width) right = withProvider;
				}

				const leftWidth = widthOf(left);
				const rightWidth = widthOf(right);
				let statsLine: string;
				if (leftWidth + 2 + rightWidth <= width) {
					statsLine = `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
				} else {
					const availableForRight = Math.max(0, width - leftWidth - 2);
					statsLine = `${left}  ${truncatePlain(right, availableForRight, "")}`;
				}

				return [statsLine];
			} catch {
				const model = ctx.model;
				const right = [accountForProvider(model?.provider), model?.provider ? `(${model.provider})` : undefined, model?.id ?? "no-model"].filter(Boolean).join(" ");
				return [theme.fg("dim", truncatePlain(right, width, "..."))];
			}
		},
	}));
}

export default function extension(pi: ExtensionAPI) {
	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		setupPromptNotifications(ctx);
		if (ctx.mode === "tui") installFooter(ctx);
	});

	pi.on("model_select", (_event: any, ctx: ExtensionContext) => {
		if (ctx.mode === "tui") installFooter(ctx);
	});

	pi.on("thinking_level_select", (_event: any, ctx: ExtensionContext) => {
		if (ctx.mode === "tui") installFooter(ctx);
	});

	pi.on("agent_settled", async (_event: any, ctx: ExtensionContext) => {
		if (!hasActiveAsyncWork()) notifyPromptIfUnfocused("Pi", lastAssistantResponse(ctx) ?? "Idle");
	});

	pi.on("session_shutdown", () => {
		teardownPromptNotifications();
	});
}
