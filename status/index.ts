import { remoteUI } from "../shared/owned-ui.ts";
import { createStatusFooter, emptyOutputRenderer } from "./footer.ts";
import { bindIdleStatus } from "../shared/idle-status.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createWorkingIndicator } from "../shared/loading.ts";

function toNumber(value: unknown): number {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
	return Number.isFinite(number) ? number : 0;
}

function accountForProvider(providerId?: string): string | undefined {
	if (!providerId) return undefined;
	try {
		const store = JSON.parse(readFileSync(join(getAgentDir(), "auth-accounts.json"), "utf8"));
		for (const [account, providers] of Object.entries(store?.providers ?? {})) {
			if (
				Array.isArray(providers) &&
				providers.some((provider) => provider?.providerId === providerId)
			)
				return account;
		}
		return typeof store?.activeAccount === "string" ? store.activeAccount : undefined;
	} catch {
		return undefined;
	}
}

function cleanOscText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function setupPromptNotifications(ctx: ExtensionContext) {
	const env = process.env;
	const output = (sequence: string) => {
		process.stdout.write(sequence);
	};
	const onExit = (callback: () => void) => {
		process.once("exit", callback);
		return () => {
			process.off("exit", callback);
		};
	};
	const write = (sequence: string) =>
		output(env.TMUX ? `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : sequence);
	let focused = true,
		closed = false,
		enabled = false;
	let unsubscribe = () => {},
		removeExit = () => {};
	const disable = () => {
		if (enabled) {
			enabled = false;
			write("\x1b[?1004l");
		}
	};
	try {
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (closed) return;
			if (data === "\x1b[I") {
				focused = true;
				return { consume: true };
			}
			if (data === "\x1b[O") {
				focused = false;
				return { consume: true };
			}
			return undefined;
		});
		if (env.PI_NATIVE_NOTIFY_FOCUS !== "0") {
			write("\x1b[?1004h");
			enabled = true;
			removeExit = onExit(disable);
		}
	} catch (error) {
		unsubscribe();
		disable();
		removeExit();
		throw error;
	}
	return {
		notify(title: string, body?: string) {
			if (closed || focused || env.PI_NATIVE_NOTIFY === "0") return;
			const text = cleanOscText(body ? `${title}: ${body}` : title);
			if (text) write(`\x1b]9;${text}\x07`);
		},
		dispose() {
			if (closed) return;
			closed = true;
			try {
				unsubscribe();
			} finally {
				try {
					disable();
				} finally {
					removeExit();
				}
			}
		},
	};
}

type IdleStatusBridge = {
	backgroundActiveCount?: () => number;
	subagentsActiveCount?: () => number;
	goalActiveCount?: () => number;
	subagentsUsage?: () => {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
};

function hasActiveAsyncWork(bridge: IdleStatusBridge): boolean {
	return (
		(bridge.backgroundActiveCount?.() ?? 0) > 0 ||
		(bridge.subagentsActiveCount?.() ?? 0) > 0 ||
		(bridge.goalActiveCount?.() ?? 0) > 0
	);
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

function usageCost(usage: any): number {
	const cost = usage?.cost;
	if (typeof cost === "number" || typeof cost === "string") return toNumber(cost);
	return toNumber(cost?.total ?? cost?.amount);
}

function collectUsage(ctx: ExtensionContext, bridge: IdleStatusBridge) {
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
			const promptTokens =
				toNumber(usage.input) + toNumber(usage.cacheRead) + toNumber(usage.cacheWrite);
			latestCacheHitRate =
				promptTokens > 0 ? (toNumber(usage.cacheRead) / promptTokens) * 100 : undefined;
		}
	}

	// Child sessions are separate from the main transcript, but their usage is
	// still work performed for this chat. The subagent extension exposes a live
	// aggregate; it deliberately disappears on restart rather than persisting a
	// second, independent accounting record.
	const childTotals = bridge.subagentsUsage?.();
	if (childTotals) {
		totals.input += toNumber(childTotals.input);
		totals.output += toNumber(childTotals.output);
		totals.cacheRead += toNumber(childTotals.cacheRead);
		totals.cacheWrite += toNumber(childTotals.cacheWrite);
		totals.cost += toNumber(childTotals.cost);
	}

	return { totals, latestCacheHitRate };
}

function installFooter(ctx: ExtensionContext, bridge: IdleStatusBridge): void {
	// Canonical own usage changes at the native leaf, not on every streamed token.
	let key = "",
		own: ReturnType<typeof collectUsage>;
	const read = () => {
		const next = ctx.sessionManager.getSessionId() + ":" + ctx.sessionManager.getLeafId();
		if (next !== key || !own) {
			key = next;
			own = collectUsage(ctx, {});
		}
		const totals = { ...own.totals },
			child = bridge.subagentsUsage?.();
		if (child)
			for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const)
				totals[field] += toNumber(child[field]);
		const model = ctx.model,
			usage = ctx.getContextUsage();
		return {
			totals,
			latestCacheHitRate: own.latestCacheHitRate,
			thinking: ctx.thinkingLevel ?? "off",
			account: accountForProvider(model?.provider),
			contextUsage: usage
				? { percent: usage.percent, contextWindow: usage.contextWindow }
				: undefined,
			model: model
				? {
						id: model.id,
						provider: model.provider,
						api: model.api,
						contextWindow: model.contextWindow,
					}
				: undefined,
		};
	};
	const remote = remoteUI(ctx.ui);
	if (remote) remote.footer(read);
	else ctx.ui.setFooter((_tui, theme, data) => createStatusFooter(read, theme, data));
}

export default function extension(pi: ExtensionAPI) {
	const bridge = bindIdleStatus(pi.events);
	pi.registerMessageRenderer("model.empty-output", emptyOutputRenderer);
	let working: ReturnType<typeof createWorkingIndicator> | undefined;
	let notifications: ReturnType<typeof setupPromptNotifications> | undefined;
	const setActivity = (event: any, _ctx: ExtensionContext) => working?.handleEvent(event);
	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		working?.dispose();
		working = ctx.mode === "tui" ? createWorkingIndicator(ctx.ui) : undefined;
		notifications?.dispose();
		notifications =
			ctx.hasUI && ctx.mode === "tui" && typeof ctx.ui.onTerminalInput === "function"
				? setupPromptNotifications(ctx)
				: undefined;
		if (ctx.mode === "tui") installFooter(ctx, bridge);
	});

	pi.on("model_select", (_event: any, ctx: ExtensionContext) => {
		if (ctx.mode === "tui") installFooter(ctx, bridge);
	});

	pi.on("thinking_level_select", (_event: any, ctx: ExtensionContext) => {
		if (ctx.mode === "tui") installFooter(ctx, bridge);
	});

	pi.on("turn_start", (event: any, ctx: ExtensionContext) => setActivity(event, ctx));
	pi.on("before_provider_request", (event: any, ctx: ExtensionContext) =>
		setActivity({ ...event, type: "before_provider_request" }, ctx),
	);
	pi.on("after_provider_response", (event: any, ctx: ExtensionContext) =>
		setActivity({ ...event, type: "after_provider_response" }, ctx),
	);
	pi.on("message_start", (event: any, ctx: ExtensionContext) => setActivity(event, ctx));
	pi.on("message_update", (event: any, ctx: ExtensionContext) => setActivity(event, ctx));
	pi.on("message_end", (event: any, ctx: ExtensionContext) => {
		setActivity(event, ctx);
		const message = event.message;
		if (message?.role !== "assistant" || message.stopReason !== "stop") return;
		const visible = (message.content ?? []).some(
			(part: any) =>
				(part?.type === "text" && String(part.text ?? "").trim()) || part?.type === "toolCall",
		);
		if (!visible) {
			void pi.sendMessage(
				{ customType: "model.empty-output", display: true, content: "Model returned no output" },
				{ triggerTurn: false },
			);
		}
	});
	pi.on("tool_execution_start", (event: any, ctx: ExtensionContext) => setActivity(event, ctx));
	pi.on("tool_execution_update", (event: any, ctx: ExtensionContext) => setActivity(event, ctx));
	pi.on("tool_execution_end", (event: any, ctx: ExtensionContext) => setActivity(event, ctx));
	pi.on("agent_end", (event: any, ctx: ExtensionContext) => setActivity(event, ctx));
	pi.on("agent_settled", async (event: any, ctx: ExtensionContext) => {
		setActivity(event, ctx);
		if (!hasActiveAsyncWork(bridge))
			notifications?.notify("Pi", lastAssistantResponse(ctx) ?? "Idle");
	});

	pi.on("session_shutdown", () => {
		working?.dispose();
		working = undefined;
		notifications?.dispose();
		notifications = undefined;
	});
}
