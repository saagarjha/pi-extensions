import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Container, Input, Loader, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { newestFirst, shortText, transitionTaskStatus, visibleWindowAroundSelected } from "../shared/task-lifecycle.ts";

type SubagentStatus = "starting" | "running" | "idle" | "failed" | "cancelled";
type Delivery = "auto" | "prompt" | "steer" | "followUp";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";


type TranscriptLine = {
	time: number;
	kind: "assistant" | "tool" | "user" | "system" | "error";
	text: string;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	result?: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError: boolean };
	resultPartial?: boolean;
};


type Subagent = {
	id: string;
	name: string;
	instructions: string;
	dormant?: boolean;
	permissions?: PermissionSubset;
	model?: any;
	thinkingLevel?: ThinkingLevel;
	status: SubagentStatus;
	createdAt: number;
	updatedAt: number;
	session?: AgentSession;
	modelRuntime?: ModelRuntime;
	unsubscribe?: () => void;
	/** Simplified event log used for tools/status. */
	transcript: TranscriptLine[];
	/** Raw pi messages from the child AgentSession, used for normal transcript rendering. */
	messages: unknown[];
	streamText: string;
	finalText: string;
	error?: string;
	closedAt?: number;
	cancelRequested?: boolean;
	interruptRequested?: boolean;
};

type ScopeMode = "deny" | "ask-ro" | "ask-rw" | "ro" | "ro-ask-rw" | "rw";
type PermissionScope = { path: string; mode: ScopeMode };
type PermissionVm = { vmId: string; mode: ScopeMode; network?: boolean };
type PermissionExec = { target: string; command: string; mode: "ask" | "allow" };
type PermissionSsh = { id: string; destination: string; port?: number };

type PermissionsSnapshot = {
	scopes: PermissionScope[];
	vms: PermissionVm[];
	execGrants: PermissionExec[];
	sshTargets: PermissionSsh[];
	network?: "deny" | "ask" | "allow";
	targets: unknown[];
};

type PermissionSubset = {
	files?: Array<{ path: string; mode?: ScopeMode }>;
	vms?: Array<{ vmId: string; mode?: ScopeMode; network?: boolean }>;
	exec?: Array<{ target: string; command: string; mode?: "ask" | "allow" }>;
	network?: "inherit" | "deny" | "ask" | "allow";
};

type PermissionsBridge = {
	instances: Map<string, {
		getSnapshot(): PermissionsSnapshot;
		applySnapshot(snapshot: PermissionsSnapshot): void;
		reduceSnapshot?(subset?: PermissionSubset): PermissionsSnapshot;
	}>;
};

type SubagentChildBridge = {
	instances: Map<string, { notify(message: string): void }>;
};

type IdleStatusBridge = {
	subagentsActiveCount?: () => number;
};

function permissionsBridge(): PermissionsBridge | undefined {
	return (globalThis as typeof globalThis & { __piPermissionsBridge?: PermissionsBridge }).__piPermissionsBridge;
}

function childBridge(): SubagentChildBridge {
	const global = globalThis as typeof globalThis & { __piSubagentChildBridge?: SubagentChildBridge };
	global.__piSubagentChildBridge ??= { instances: new Map() };
	return global.__piSubagentChildBridge;
}

function idleStatusBridge(): IdleStatusBridge {
	return ((globalThis as typeof globalThis & { __piIdleStatus?: IdleStatusBridge }).__piIdleStatus ??= {});
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const childExtensionPath = join(extensionDir, "child.ts");
function siblingExtensionEntryPaths(): string[] {
	const root = dirname(extensionDir);
	const paths: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name === "subagents") continue;
		const path = join(root, entry.name);
		if (entry.isFile() || entry.isSymbolicLink()) {
			if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) paths.push(path);
			continue;
		}
		if (!entry.isDirectory()) continue;
		const indexTs = join(path, "index.ts");
		const indexJs = join(path, "index.js");
		if (existsSync(indexTs)) paths.push(indexTs);
		else if (existsSync(indexJs)) paths.push(indexJs);
		else {
			const packageJson = join(path, "package.json");
			if (!existsSync(packageJson)) continue;
			try {
				const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
				for (const rel of manifest?.pi?.extensions ?? []) {
					const candidate = join(path, rel);
					if (existsSync(candidate) && statSync(candidate).isFile()) paths.push(candidate);
				}
			} catch {}
		}
	}
	return paths;
}

const now = () => Date.now();
const makeId = () => `sub_${Math.random().toString(36).slice(2, 8)}`;
const short = shortText;
function modelLabel(model: any): string { return `${model?.provider ?? "unknown"}/${model?.id ?? "unknown"}`; }

function resolveSubagentModel(params: { model?: string; thinkingLevel?: ThinkingLevel }, ctx: ExtensionContext): { model: any; thinkingLevel?: ThinkingLevel } {
	if (!ctx.model) throw new Error("No active model; cannot spawn subagent.");
	const explicitThinking = params.thinkingLevel;
	const requested = params.model?.trim();
	if (!requested) return { model: ctx.model, thinkingLevel: explicitThinking ?? ctx.thinkingLevel as ThinkingLevel | undefined };

	const [providerPart, ...idParts] = requested.includes("/") ? requested.split("/") : [ctx.model.provider, requested];
	const provider = providerPart || ctx.model.provider;
	const id = idParts.length ? idParts.join("/") : requested;
	if (provider !== ctx.model.provider) throw new Error(`Subagents can only use the current provider (${ctx.model.provider}); requested ${provider}.`);

	const scopedModels = ((ctx as any).scopedModels ?? []) as Array<{ model: any; thinkingLevel?: ThinkingLevel }>;
	const scopedEntry = scopedModels.find((entry) => entry.model?.provider === provider && entry.model?.id === id);
	if (scopedModels.length > 0 && !scopedEntry) throw new Error(`Model ${provider}/${id} is not enabled for this session.`);

	const model = scopedEntry?.model ?? ctx.modelRegistry.find(provider, id);
	if (!model) throw new Error(`Model ${provider}/${id} is not available.`);
	return { model, thinkingLevel: explicitThinking ?? scopedEntry?.thinkingLevel ?? ctx.thinkingLevel as ThinkingLevel | undefined };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (part && typeof part === "object" && "type" in part && (part as { type?: unknown }).type === "text") {
					return String((part as { text?: unknown }).text ?? "");
				}
				return "";
			})
			.join("");
	}
	return "";
}

function appendTranscript(agent: Subagent, kind: TranscriptLine["kind"], text: string) {
	if (!text.trim()) return;
	agent.transcript.push({ time: now(), kind, text });
	if (agent.transcript.length > 500) agent.transcript.splice(0, agent.transcript.length - 500);
	agent.updatedAt = now();
}

function padToWidth(text: string, width: number) {
	const visible = visibleWidth(text);
	return visible >= width ? truncateToWidth(text, width) : text + " ".repeat(width - visible);
}

function stripTranscriptControlCodes(line: string) {
	// Main transcript components add OSC 133 shell-integration zones. Those are
	// useful in the real scrollback but confuse overlay redraw/clipping, so strip
	// them when embedding the components inside our panel.
	return line.replace(/\x1b\]133;[ABC]\x07/g, "");
}

function bordered(lines: string[], width: number, title = "", style: (text: string) => string = (text) => text) {
	if (width < 8) return lines.map((line) => truncateToWidth(stripTranscriptControlCodes(line), width));
	const bodyInner = Math.max(1, width - 4);
	const borderInner = Math.max(1, width - 2);
	const rawTitle = title ? ` ${title.toUpperCase()} ` : "";
	const titleText = truncateToWidth(rawTitle, borderInner, "");
	const topRest = Math.max(0, borderInner - visibleWidth(titleText));
	const top = style(`╔${titleText}${"═".repeat(topRest)}╗`);
	const body = lines.flatMap((line) =>
		wrapTextWithAnsi(stripTranscriptControlCodes(line), bodyInner).map((wrapped) => `${style("║")} ${padToWidth(wrapped, bodyInner)} ${style("║")}`),
	);
	return [top, ...body, style(`╚${"═".repeat(borderInner)}╝`)];
}

class SubagentManager {
	private agents = new Map<string, Subagent>();
	private activeId: string | undefined;
	private uiCtx?: ExtensionContext;
	private api?: ExtensionAPI;
	private listeners = new Set<() => void>();
	private eventListeners = new Set<(agent: Subagent, event: AgentSessionEvent) => void>();

	setApi(api: ExtensionAPI) {
		this.api = api;
	}

	setContext(ctx: ExtensionContext) {
		this.uiCtx = ctx;
		this.refreshUi();
	}

	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	subscribeEvents(listener: (agent: Subagent, event: AgentSessionEvent) => void) {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	private emitAgentEvent(agent: Subagent, event: AgentSessionEvent) {
		for (const listener of this.eventListeners) listener(agent, event);
	}

	activeCount(): number {
		return [...this.agents.values()].filter((agent) => agent.status === "starting" || agent.status === "running").length;
	}

	private changed() {
		for (const listener of this.listeners) listener();
		this.refreshUi();
	}

	private notifyParent(agent: Subagent, message: string) {
		// If the user interrupted this run, match the main UI: abort the operation
		// without surfacing any late completion/notification produced by that run.
		if (agent.interruptRequested) return;
		agent.dormant = false;
		appendTranscript(agent, "system", `notify_parent: ${message}`);
		try {
			this.api?.sendMessage({
				customType: "subagent.notify",
				display: true,
				content: `Subagent ${agent.name} (${agent.id}) [${agent.status}]:\n\n${message}`,
				details: { taskId: agent.id, taskName: agent.name, status: agent.status, message },
			}, { triggerTurn: true, deliverAs: "followUp" });
		} catch {}
		this.changed();
	}

	private isTerminal(agent: Subagent) {
		return agent.status === "failed" || agent.status === "cancelled";
	}

	private unloadRuntime(agent: Subagent, note?: string) {
		agent.unsubscribe?.();
		agent.unsubscribe = undefined;
		if (agent.session) childBridge().instances.delete(agent.session.sessionId);
		agent.session?.dispose();
		(agent.modelRuntime as { dispose?: () => void } | undefined)?.dispose?.();
		agent.session = undefined;
		agent.modelRuntime = undefined;
		if (note) appendTranscript(agent, "system", note);
	}

	dismiss(idOrName: string) {
		const agent = this.getOpen(idOrName);
		if (!agent) throw new Error(`Unknown subagent: ${idOrName}`);
		if (agent.status === "starting") throw new Error(`Subagent ${agent.name} is still starting; wait until it is initialized before dismissing.`);
		agent.dormant = true;
		appendTranscript(agent, "system", "dismissed by parent; full session retained");
		if (this.activeId === agent.id) this.activeId = undefined;
		this.changed();
		return agent;
	}

	private refreshUi() {
		const ctx = this.uiCtx;
		try {
			if (!ctx?.hasUI) return;
		} catch {
			// The previous extension instance can still receive async subagent updates
			// after /reload or session replacement. Its captured ctx is stale; drop it
			// instead of crashing pi from a background refresh.
			this.uiCtx = undefined;
			return;
		}
		const agents = this.list().filter((agent) => !agent.dormant);
		const running = agents.filter((a) => a.status === "starting" || a.status === "running");
		ctx.ui.setStatus(
			"subagents",
			agents.length === 0 ? undefined : ctx.ui.theme.fg("accent", `subagents ${running.length}/${agents.length}`),
		);
		ctx.ui.setTitle("pi");
		ctx.ui.setWidget("subagent-active", undefined);
		if (agents.length === 0) {
			ctx.ui.setWidget("subagents", undefined);
			return;
		}

		// Keep the main view tiny. /subagents is the real console; this is just a
		// one-line status strip below the editor.
		ctx.ui.setWidget("subagents", (_tui, theme) => ({
			render: (width) => {
				const counts = {
					running: agents.filter((agent) => agent.status === "running" || agent.status === "starting").length,
					idle: agents.filter((agent) => agent.status === "idle").length,
					failed: agents.filter((agent) => agent.status === "failed" || agent.status === "cancelled").length,
				};
				const parts = [
					theme.fg("accent", `[${agents.length} subagents]`),
					counts.running ? theme.fg("accent", `[● ${counts.running}]`) : undefined,
					counts.idle ? theme.fg("dim", `[○ ${counts.idle}]`) : undefined,
					counts.failed ? theme.fg("error", `[✗ ${counts.failed}]`) : undefined,
					theme.fg("dim", "[/subagents]"),
				].filter((part): part is string => part !== undefined);
				return [truncateToWidth(parts.join(" "), width)];
			},
			invalidate: () => {},
		}), { placement: "belowEditor" });
	}

	listAll() {
		return newestFirst(this.agents.values(), (agent) => agent.createdAt);
	}

	list() {
		return this.listAll().filter((agent) => !agent.closedAt);
	}

	get(idOrName: string) {
		const byId = this.agents.get(idOrName);
		if (byId && !byId.closedAt) return byId;
		return this.list().find((a) => a.name === idOrName) ?? byId ?? this.listAll().find((a) => a.name === idOrName);
	}

	getOpen(idOrName: string) {
		const byId = this.agents.get(idOrName);
		if (byId && !byId.closedAt) return byId;
		return this.list().find((a) => a.name === idOrName);
	}

	getAny(idOrName: string) {
		return this.agents.get(idOrName) ?? this.list().find((a) => a.name === idOrName) ?? this.listAll().find((a) => a.name === idOrName);
	}


	getActive() {
		return this.activeId ? this.get(this.activeId) : undefined;
	}

	focus(idOrName: string) {
		const agent = this.get(idOrName);
		if (!agent) throw new Error(`Unknown subagent: ${idOrName}`);
		this.activeId = agent.id;
		this.changed();
		return agent;
	}

	clearFocus() {
		this.activeId = undefined;
		this.uiCtx?.ui.setTitle("pi");
		this.changed();
	}

	async spawn(params: { instructions: string; name?: string; permissions?: PermissionSubset; model?: string; thinkingLevel?: ThinkingLevel }, ctx: ExtensionContext) {
		this.setContext(ctx);
		const selectedModel = resolveSubagentModel(params, ctx);

		const id = makeId();
		const agent: Subagent = {
			id,
			name: params.name?.trim() || id,
			instructions: params.instructions,
			permissions: params.permissions,
			model: selectedModel.model,
			thinkingLevel: selectedModel.thinkingLevel,
			status: "starting",
			createdAt: now(),
			updatedAt: now(),
			transcript: [],
			messages: [],
			streamText: "",
			finalText: "",
		};
		this.agents.set(id, agent);
		appendTranscript(agent, "user", params.instructions);
		this.changed();

		void this.run(agent, ctx).catch((error) => {
			if (agent.interruptRequested) {
				agent.interruptRequested = false;
				transitionTaskStatus(agent, "idle");
			} else if (agent.cancelRequested) {
				transitionTaskStatus(agent, "cancelled");
			} else {
				transitionTaskStatus(agent, "failed");
				agent.error = error instanceof Error ? error.message : String(error);
				appendTranscript(agent, "error", agent.error);
				this.notifyParent(agent, `Subagent failed: ${agent.error}`);
			}
			this.unloadRuntime(agent);
			this.changed();
		});

		return agent;
	}

	private async run(agent: Subagent, ctx: ExtensionContext) {
		const modelRuntime = await ModelRuntime.create();
		agent.modelRuntime = modelRuntime;
		const loader = new DefaultResourceLoader({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			// Child sessions get the same sibling extension set as the parent, except
			// this subagents extension itself to avoid recursive subagent control tools.
			noExtensions: true,
			additionalExtensionPaths: [...siblingExtensionEntryPaths(), childExtensionPath],
			systemPromptOverride: () => `You are a focused Pi subagent.\n\nRules:\n- Follow the delegated instructions.\n- Be concise and evidence-driven.\n- Prefer file paths, line references, commands run, and concrete findings.\n- Do not ask the user questions unless explicitly messaged by the user.\n- Use notify_parent only when you cannot continue autonomously, are blocked, need parent attention, or have the result the parent asked for.\n- Do not use notify_parent for routine progress; keep ordinary progress in your own transcript.`,
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			model: agent.model ?? ctx.model,
			thinkingLevel: agent.thinkingLevel ?? ctx.thinkingLevel,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(ctx.cwd),
		});
		agent.session = session;
		childBridge().instances.set(session.sessionId, { notify: (message) => this.notifyParent(agent, message) });
		// SDK-created sessions do not emit extension session_start until bound.
		// Binding the child permissions extension registers its permission bridge
		// before any model prompt/tool call can run.
		await session.bindExtensions({ mode: "print" });

		const bridge = permissionsBridge();
		const parentPermissions = bridge?.instances.get(ctx.sessionManager.getSessionId());
		const childPermissions = bridge?.instances.get(session.sessionId);
		if (!parentPermissions || !childPermissions) {
			session.dispose();
			throw new Error("Permission inheritance failed closed: permissions bridge unavailable for parent or child session.");
		}
		if (!parentPermissions.reduceSnapshot) {
			session.dispose();
			throw new Error("Permission inheritance failed closed: permissions bridge does not expose canonical snapshot reduction.");
		}
		const delegatedPermissions = parentPermissions.reduceSnapshot(agent.permissions);
		childPermissions.applySnapshot(delegatedPermissions);
		appendTranscript(agent, "system", agent.permissions ? "inherited reduced parent permission state" : "inherited parent permission state");

		transitionTaskStatus(agent, "running");
		this.changed();

		const syncMessages = () => {
			agent.messages = [...session.messages];
			agent.updatedAt = now();
		};
		agent.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			syncMessages();
			this.emitAgentEvent(agent, event);
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				agent.streamText += event.assistantMessageEvent.delta;
				agent.finalText += event.assistantMessageEvent.delta;
				agent.updatedAt = now();
				this.changed();
			} else if (event.type === "tool_execution_start") {
				agent.transcript.push({
					time: now(),
					kind: "tool",
					text: `→ ${event.toolName} ${short(JSON.stringify(event.args ?? {}), 160)}`,
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					args: event.args ?? {},
				});
				this.changed();
			} else if (event.type === "tool_execution_update") {
				const existing = agent.transcript.findLast((entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId);
				const result = {
					content: (Array.isArray(event.partialResult?.content) ? event.partialResult.content : [{ type: "text", text: String(event.partialResult ?? "") }]) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
					details: event.partialResult?.details,
					isError: false,
				};
				if (existing) {
					existing.result = result;
					existing.resultPartial = true;
				} else {
					agent.transcript.push({ time: now(), kind: "tool", text: "→ tool", toolName: "tool", toolCallId: event.toolCallId, args: {}, result, resultPartial: true });
				}
				agent.updatedAt = now();
				this.changed();
			} else if (event.type === "tool_execution_end") {
				const existing = agent.transcript.findLast((entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId);
				const result = {
					content: (Array.isArray(event.result?.content) ? event.result.content : [{ type: "text", text: String(event.result ?? "") }]) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
					details: event.result?.details,
					isError: event.isError,
				};
				if (existing) {
					existing.text = `${event.isError ? "✗" : "✓"} ${event.toolName}`;
					existing.result = result;
					existing.resultPartial = false;
				} else {
					agent.transcript.push({ time: now(), kind: "tool", text: `${event.isError ? "✗" : "✓"} ${event.toolName}`, toolName: event.toolName, toolCallId: event.toolCallId, args: {}, result });
				}
				this.changed();
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				const text = contentText(event.message.content);
				if (text.trim()) appendTranscript(agent, "assistant", text);
				agent.streamText = "";
				this.changed();
			}
		});

		try {
			await session.prompt(agent.instructions, { source: "extension" });
			if (agent.interruptRequested) {
				agent.interruptRequested = false;
				transitionTaskStatus(agent, "idle");
			} else if (!agent.closedAt && !agent.cancelRequested && agent.status === "running") transitionTaskStatus(agent, "idle");
		} catch (error) {
			if (!agent.closedAt) {
				if (agent.interruptRequested) {
					agent.interruptRequested = false;
					transitionTaskStatus(agent, "idle");
				} else if (agent.cancelRequested) {
					transitionTaskStatus(agent, "cancelled");
				} else {
					transitionTaskStatus(agent, "failed");
					agent.error = error instanceof Error ? error.message : String(error);
					appendTranscript(agent, "error", agent.error);
					this.notifyParent(agent, `Subagent failed: ${agent.error}`);
				}
			}
		} finally {
			this.changed();
		}
	}

	update(idOrName: string, params: { permissions?: PermissionSubset }, ctx: ExtensionContext) {
		const agent = this.getOpen(idOrName);
		if (!agent) throw new Error(`Unknown subagent: ${idOrName}`);
		if (!agent.session) throw new Error(`Subagent runtime is not loaded: ${idOrName}`);
		const bridge = permissionsBridge();
		const parentPermissions = bridge?.instances.get(ctx.sessionManager.getSessionId());
		const childPermissions = bridge?.instances.get(agent.session.sessionId);
		if (!parentPermissions || !childPermissions) throw new Error("Permission update failed: permissions bridge unavailable for parent or child session.");
		if (!parentPermissions.reduceSnapshot) throw new Error("Permission update failed: permissions bridge does not expose canonical snapshot reduction.");
		const delegatedPermissions = parentPermissions.reduceSnapshot(params.permissions);
		childPermissions.applySnapshot(delegatedPermissions);
		agent.permissions = params.permissions;
		appendTranscript(agent, "system", `updated by parent; permissions ${params.permissions ? "reduced" : "inherited from current parent"}`);
		this.changed();
		return agent;
	}

	async send(idOrName: string, text: string, delivery: Delivery = "auto") {
		const agent = this.getOpen(idOrName);
		if (!agent) throw new Error(`Unknown or closed subagent: ${idOrName}`);
		if (!agent.session) throw new Error(`Subagent runtime is not loaded: ${idOrName}`);
		const wasDormant = Boolean(agent.dormant);
		const active = agent.status === "running" || agent.status === "starting";
		const deliveryUsed: Exclude<Delivery, "auto"> = delivery === "auto" ? (active ? "steer" : "prompt") : delivery;
		agent.dormant = false;
		appendTranscript(agent, "user", text);
		this.changed();
		if (delivery === "prompt" && active) throw new Error(`Subagent ${agent.name} is already running; use delivery=steer or delivery=followUp.`);
		if (delivery === "steer" || (delivery === "auto" && active)) await agent.session.steer(text);
		else if (delivery === "followUp" && active) await agent.session.followUp(text);
		else {
			if (this.isTerminal(agent)) throw new Error(`Subagent ${agent.name} is ${agent.status}; spawn a new subagent if needed.`);
			transitionTaskStatus(agent, "running");
			this.changed();
			try {
				await agent.session.prompt(text, { source: "extension" });
				if (agent.interruptRequested) {
					agent.interruptRequested = false;
					transitionTaskStatus(agent, "idle");
				} else if (!agent.closedAt && !agent.cancelRequested && agent.status === "running") {
					transitionTaskStatus(agent, "idle");
				}
			} catch (error) {
				let wasInterrupted = false;
				if (!agent.closedAt) {
					if (agent.interruptRequested) {
						agent.interruptRequested = false;
						wasInterrupted = true;
						transitionTaskStatus(agent, "idle");
					} else if (agent.cancelRequested) {
						transitionTaskStatus(agent, "cancelled");
					} else {
						transitionTaskStatus(agent, "failed");
						agent.error = error instanceof Error ? error.message : String(error);
						appendTranscript(agent, "error", agent.error);
						this.notifyParent(agent, `Subagent failed: ${agent.error}`);
					}
				}
				if (!wasInterrupted) throw error;
			} finally {
				this.changed();
			}
		}
		return { agent, delivery: deliveryUsed, reactivated: wasDormant };
	}

	async stop(idOrName: string) {
		const agent = this.get(idOrName);
		if (!agent?.session) throw new Error(`Unknown or not-yet-started subagent: ${idOrName}`);
		agent.interruptRequested = true;
		await agent.session.abort();
		transitionTaskStatus(agent, "idle");
		// Keep interruptRequested set until the aborted prompt unwinds, so late
		// notify_parent calls from the interrupted run are suppressed.
		// Match the main chat interrupt UI: the aborted assistant/tool message is
		// rendered from the session itself; don't add an extra subagent-specific
		// system transcript line.
		this.changed();
	}

	dispose() {
		this.uiCtx = undefined;
		this.activeId = undefined;
		for (const agent of this.agents.values()) {
			agent.cancelRequested = true;
			if (!this.isTerminal(agent)) {
				void agent.session?.abort().catch(() => {});
				transitionTaskStatus(agent, "cancelled");
			}
			this.unloadRuntime(agent);
		}
		this.agents.clear();
		for (const listener of this.listeners) listener();
		this.listeners.clear();
	}
}

const manager = new SubagentManager();

function toolResult(text: string, details?: unknown, isError?: boolean) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

function renderDisplayResult(result: any) {
	const text = result.details?.display ?? result.content?.map((part: any) => part.text ?? "").join("\n") ?? "";
	return { invalidate() {}, render: (width: number) => text.split("\n").map((line: string) => truncateToWidth(line, width)) };
}

function renderLinear(agent: Subagent, maxChars: number) {
	const dormant = agent.dormant ? " dormant" : " active";
	const closed = agent.closedAt ? " closed" : "";
	const lines = [`Subagent ${agent.name} (${agent.id}) [${agent.status}${dormant}${closed}]`, `Instructions: ${agent.instructions}`, ""];
	for (const line of agent.transcript.slice(-80)) lines.push(`${line.kind}: ${line.text}`);
	if (agent.streamText.trim()) lines.push(`assistant: ${agent.streamText}`);
	if (agent.error) lines.push(`error: ${agent.error}`);
	const text = lines.join("\n");
	return text.length > maxChars ? `[truncated to last ${maxChars} chars]\n${text.slice(-maxChars)}` : text;
}

function renderPlainBlock(text: string, width: number, color: (s: string) => string = (s) => s): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (line === "") {
			out.push("");
			continue;
		}
		for (const wrapped of wrapTextWithAnsi(color(line), width)) out.push(truncateToWidth(wrapped, width));
	}
	return out;
}

function activeSubagentWorkLabel(agent: Subagent): string | undefined {
	return agent.status === "starting" || agent.status === "running" ? "Working" : undefined;
}

function isVisibleSupplementalSystemEntry(entry: TranscriptLine): boolean {
	if (entry.kind !== "system") return true;
	return !/^(inherited (reduced )?parent permission state|updated by parent; permissions )/.test(entry.text.trim());
}

class LinesComponent implements Component {
	constructor(private readonly lines: string[]) {}
	render(width: number): string[] { return this.lines.map((line) => truncateToWidth(line, width)); }
	invalidate(): void {}
}

function renderMessageFallback(message: any, width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
	const text = contentText(message?.content) || String(message?.content ?? "");
	return renderPlainBlock(text || JSON.stringify(message), width, (line) => theme.fg("dim", line));
}

function appendSeparated(lines: string[], rendered: string[]): void {
	if (rendered.length === 0) return;
	lines.push(...rendered);
}

type ToolComponentProvider = (agent: Subagent, toolName: string, toolCallId: string, args: unknown) => ToolExecutionComponent | undefined;

type SubagentChatView = {
	container: Container;
	streamingComponent?: AssistantMessageComponent;
	streamingMessage?: any;
	pendingTools: Map<string, ToolExecutionComponent>;
	needsSeparator: boolean;
	key: string;
};

function renderTranscriptFallback(agent: Subagent, width: number, theme: ExtensionContext["ui"]["theme"], toolsExpanded: boolean, toolComponent: ToolComponentProvider): string[] {
	const lines: string[] = [];
	const transcript = [...agent.transcript.slice(-160)];
	if (agent.streamText.trim()) transcript.push({ time: now(), kind: "assistant", text: agent.streamText });
	for (const entry of transcript.slice(-100)) {
		if (lines.length > 0) lines.push("");
		const text = entry.text || " ";
		if (entry.kind === "user") {
			lines.push(...new UserMessageComponent(text).render(width).map(stripTranscriptControlCodes));
		} else if (entry.kind === "assistant") {
			lines.push(...new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text }], timestamp: entry.time } as never).render(width).map(stripTranscriptControlCodes));
		} else if (entry.kind === "tool" && entry.toolName && entry.toolCallId) {
			const component = toolComponent(agent, entry.toolName, entry.toolCallId, entry.args ?? {});
			if (!component) {
				lines.push(theme.fg("dim", truncateToWidth(entry.text, width)));
				const resultText = entry.result?.content.map((part) => part.text ?? part.data ?? "").filter(Boolean).join("\n");
				if (resultText) lines.push(...renderPlainBlock(short(resultText, 800), width, (s) => theme.fg(entry.result?.isError ? "error" : "dim", s)));
				continue;
			}
			component.setExpanded(toolsExpanded);
			component.markExecutionStarted();
			component.setArgsComplete();
			if (entry.result) component.updateResult(entry.result, entry.resultPartial);
			lines.push(...component.render(width).map(stripTranscriptControlCodes));
		} else if (entry.kind === "error") {
			lines.push(theme.fg("error", truncateToWidth(`Error: ${text}`, width)));
		} else {
			lines.push(...renderPlainBlock(text, width, (s) => theme.fg("dim", s)));
		}
	}
	return lines;
}

function renderChatLog(agent: Subagent, width: number, theme: ExtensionContext["ui"]["theme"], toolsExpanded: boolean, toolComponent: ToolComponentProvider): string[] {
	const lines: string[] = [];
	const messages = (agent.messages as any[]).slice(-100);

	if (messages.length === 0) {
		lines.push(...renderTranscriptFallback(agent, width, theme, toolsExpanded, toolComponent));
	} else {
		const toolResults = new Map<string, { result: any; partial?: boolean }>();
		const renderedUserTexts = new Set<string>();
		for (const message of messages) {
			if (message && typeof message === "object" && message.role === "toolResult") toolResults.set(message.toolCallId, { result: message });
			if (message && typeof message === "object" && message.role === "user") renderedUserTexts.add(contentText(message.content).trim());
		}
		for (const entry of agent.transcript) {
			if (entry.kind === "tool" && entry.toolCallId && entry.result && !toolResults.has(entry.toolCallId)) {
				toolResults.set(entry.toolCallId, { result: entry.result, partial: entry.resultPartial });
			}
		}
		for (const message of messages) {
			if (!message || typeof message !== "object") continue;
			if (message.role === "assistant") {
				const assistant = new AssistantMessageComponent(message as never);
				const rendered = assistant.render(width).map(stripTranscriptControlCodes);
				if (rendered.length) lines.push(...rendered);
				for (const content of message.content ?? []) {
					if (content?.type !== "toolCall") continue;
					const component = toolComponent(agent, content.name, content.id, content.arguments);
					if (!component) continue;
					component.setExpanded(toolsExpanded);
					component.markExecutionStarted();
					component.setArgsComplete();
					const result = toolResults.get(content.id);
					if (result) {
						component.updateResult(result.result, result.partial);
					} else if (message.stopReason === "aborted" || message.stopReason === "error") {
						component.updateResult({ content: [{ type: "text", text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error") }], isError: true });
					}
					lines.push(...component.render(width).map(stripTranscriptControlCodes));
				}
			} else if (message.role === "toolResult") {
				// Tool results are rendered with their corresponding assistant tool call, matching the main UI.
			} else if (message.role === "user") {
				appendSeparated(lines, new UserMessageComponent(contentText(message.content)).render(width).map(stripTranscriptControlCodes));
			} else {
				appendSeparated(lines, renderMessageFallback(message, width, theme));
			}
		}

		for (const entry of agent.transcript.slice(-100)) {
			if (!isVisibleSupplementalSystemEntry(entry)) continue;
			const text = entry.text.trim();
			if (!text) continue;
			if (entry.kind === "user") {
				if (renderedUserTexts.has(text)) continue;
				appendSeparated(lines, new UserMessageComponent(text).render(width).map(stripTranscriptControlCodes));
				renderedUserTexts.add(text);
			} else if (entry.kind === "system" || entry.kind === "error") {
				const color = entry.kind === "error" ? "error" : "dim";
				appendSeparated(lines, renderPlainBlock(text, width, (line) => theme.fg(color, line)));
			}
		}
	}

	if (lines.length === 0) lines.push(theme.fg("dim", "No transcript yet."));
	return lines;
}

const permissionParams = Type.Optional(Type.Object({
	files: Type.Optional(Type.Array(Type.Object({
		path: Type.String({ description: "Exact readable/writable path from the parent's files/system capabilities to delegate." }),
		mode: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("ask-ro"), Type.Literal("ask-rw"), Type.Literal("ro"), Type.Literal("ro-ask-rw"), Type.Literal("rw")])),
	}))),
	vms: Type.Optional(Type.Array(Type.Object({
		vmId: Type.String({ description: "Parent-granted VM id to delegate." }),
		mode: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("ask-ro"), Type.Literal("ask-rw"), Type.Literal("ro"), Type.Literal("ro-ask-rw"), Type.Literal("rw")])),
		network: Type.Optional(Type.Boolean({ description: "Delegate VM-specific network only if parent has it." })),
	}))),
	exec: Type.Optional(Type.Array(Type.Object({
		target: Type.String({ description: "Exact parent-granted exec target to delegate." }),
		command: Type.String({ description: "Exact parent-granted command string to delegate, or *." }),
		mode: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("allow")], { description: "May only reduce allow to ask, not ask to allow." })),
	}))),
	network: Type.Optional(Type.Union([Type.Literal("inherit"), Type.Literal("deny"), Type.Literal("ask"), Type.Literal("allow")])),
}, { description: "Optional reduced permission state. Omit to inherit parent permissions. Provided files may be exact parent file grants or built-in system paths; vms/exec grants must be exact parent grants; modes may only be reduced." }));

function installTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "spawn_subagent",
		label: "Spawn Subagent",
		description: "Start a persistent subagent actor with delegated instructions. The subagent can notify the parent only when it is blocked, needs parent attention, or has the requested result. It remains alive and can later be dismissed or messaged again.",
		promptSnippet: "spawn_subagent: start a persistent subagent actor",
		promptGuidelines: [
			"Put all specialization, role, reporting format, and task details in the instructions field.",
			"Subagents inherit the current model and thinking level by default. Only set model or thinkingLevel when the user explicitly asks for a different model or thinking level.",
			"Subagents are actors, not promises. They notify the parent when they need attention; dismiss them when you are satisfied. Do not poll them with inspect_subagent.",
		],
		parameters: Type.Object({
			instructions: Type.String({ description: "Complete instructions for the subagent, including specialization/role, task, and desired reporting format." }),
			name: Type.Optional(Type.String({ description: "Short human-readable name." })),
			model: Type.Optional(Type.String({ description: "Only when explicitly requested by the user: model id for this subagent. Must be from the current provider; omit to inherit the current model." })),
			thinkingLevel: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")], { description: "Only when explicitly requested by the user: thinking level for this subagent. Omit to inherit the current thinking level." })),
			permissions: permissionParams,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const agent = await manager.spawn(params, ctx);
			return toolResult(
				`Spawned subagent ${agent.name} (${agent.id}) with ${modelLabel(agent.model)}${agent.thinkingLevel && agent.thinkingLevel !== "off" ? ` (${agent.thinkingLevel})` : ""}. It will notify you when it needs attention or has a result.`,
				{ id: agent.id, name: agent.name, status: agent.status, dormant: Boolean(agent.dormant), model: modelLabel(agent.model), thinkingLevel: agent.thinkingLevel, display: `Spawned ${agent.name} (${agent.id}) [${agent.status}]\nmodel: ${modelLabel(agent.model)}${agent.thinkingLevel && agent.thinkingLevel !== "off" ? ` (${agent.thinkingLevel})` : ""}\n${short(agent.instructions, 160)}` },
			);
		},
		renderResult: renderDisplayResult,
	}) satisfies ToolDefinition);

	pi.registerTool(defineTool({
		name: "list_subagents",
		label: "List Subagents",
		description: "List active and dormant subagents. Dormant subagents are hidden from the status bar but keep their full session state and can be messaged again.",
		promptSnippet: "list_subagents: list active and dormant subagents",
		promptGuidelines: ["Use list_subagents for occasional inspection only. Do not poll; subagents notify the parent when they need attention."],
		parameters: Type.Object({
			includeDormant: Type.Optional(Type.Boolean({ description: "Include dormant subagents. Defaults to true." })),
		}),
		async execute(_id, params) {
			const agents = manager.list().filter((agent) => (params.includeDormant ?? true) || !agent.dormant);
			const active = agents.filter((agent) => !agent.dormant);
			const dormant = agents.filter((agent) => agent.dormant);
			const running = agents.filter((agent) => agent.status === "starting" || agent.status === "running");
			const failed = agents.filter((agent) => agent.status === "failed" || agent.status === "cancelled");
			const lines = [`Subagents: ${active.length} active${params.includeDormant ?? true ? `, ${dormant.length} dormant` : ""}${running.length ? `, ${running.length} running` : ""}${failed.length ? `, ${failed.length} failed/cancelled` : ""}`, "", "Active subagents:"];
			if (active.length === 0) lines.push("  (none)");
			for (const agent of active) lines.push(`  - ${agent.name} (${agent.id}) [${agent.status}] ${modelLabel(agent.model)} ${short(agent.instructions, 120)}`);
			if (params.includeDormant ?? true) {
				lines.push("", "Dormant subagents:");
				if (dormant.length === 0) lines.push("  (none)");
				for (const agent of dormant) lines.push(`  - ${agent.name} (${agent.id}) [${agent.status}] ${modelLabel(agent.model)} ${short(agent.instructions, 120)}`);
			}
			return toolResult(lines.join("\n"), { agents: agents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status, dormant: Boolean(agent.dormant), model: modelLabel(agent.model), thinkingLevel: agent.thinkingLevel, instructions: agent.instructions })), display: lines.join("\n") });
		},
		renderResult: renderDisplayResult,
	}) satisfies ToolDefinition);

	pi.registerTool(defineTool({
		name: "inspect_subagent",
		label: "Inspect Subagent",
		description: "Debug snapshot of a subagent's current transcript/state. Use only for debugging or when the user explicitly asks; subagents notify the parent when attention is needed. Do not use this to poll for progress.",
		promptSnippet: "inspect_subagent: debug/audit snapshot of a subagent transcript/state",
		promptGuidelines: [
			"Do not poll inspect_subagent. Use it only for debugging or when the user explicitly asks to inspect a subagent.",
			"For normal workflow, rely on notify_parent notifications or message the subagent; do not inspect for progress.",
		],
		parameters: Type.Object({ id: Type.String({ description: "Subagent id or name." }) }),
		async execute(_id, params) {
			const agent = manager.getAny(params.id);
			if (!agent) return toolResult(`Unknown subagent: ${params.id}`, undefined, true);
			return toolResult(renderLinear(agent, 20_000), { id: agent.id, name: agent.name, status: agent.status, dormant: Boolean(agent.dormant), error: agent.error });
		},
	}) satisfies ToolDefinition);

	pi.registerTool(defineTool({
		name: "update_subagent",
		label: "Update Subagent",
		description: "Update an existing subagent's delegated permission snapshot. Tools are ambient in the child session based on its current permissions; this does not wake or message the subagent by itself.",
		promptSnippet: "update_subagent: update a subagent's delegated permissions",
		promptGuidelines: [
			"Use update_subagent when the parent has gained permissions that an existing subagent needs. It only delegates current parent permissions and cannot escalate beyond them.",
			"After updating, message_subagent if the subagent should continue with the newly available permissions.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Subagent id or name." }),
			permissions: permissionParams,
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const agent = manager.update(params.id, { permissions: params.permissions }, ctx);
				return toolResult(`Updated permissions for subagent ${agent.name} (${agent.id}). Status: ${agent.status}${agent.dormant ? ", dormant" : ""}. Model: ${modelLabel(agent.model)}.`, { id: agent.id, name: agent.name, status: agent.status, dormant: Boolean(agent.dormant), model: modelLabel(agent.model), thinkingLevel: agent.thinkingLevel });
			} catch (error) {
				return toolResult(error instanceof Error ? error.message : String(error), undefined, true);
			}
		},
	}) satisfies ToolDefinition);

	pi.registerTool(defineTool({
		name: "dismiss_subagent",
		label: "Dismiss Subagent",
		description: "Hide a subagent from the status bar while retaining its full session state. Message it later to make it active again.",
		parameters: Type.Object({ id: Type.String({ description: "Subagent id or name." }) }),
		async execute(_id, params) {
			try {
				const agent = manager.dismiss(params.id);
				return toolResult(`Dismissed subagent ${agent.name} (${agent.id}). It is hidden from the status area but can be messaged again later.`);
			} catch (error) { return toolResult(error instanceof Error ? error.message : String(error), undefined, true); }
		},
	}) satisfies ToolDefinition);

	pi.registerTool(defineTool({
		name: "message_subagent",
		label: "Message Subagent",
		description: "Send a message to a subagent. Messaging a dormant subagent makes it active again. Use delivery=steer to interrupt, followUp to queue, or auto for sensible default.",
		parameters: Type.Object({
			id: Type.String({ description: "Subagent id or name." }),
			message: Type.String(),
			delivery: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")])),
		}),
		async execute(_id, params) {
			try {
				const sent = await manager.send(params.id, params.message, params.delivery ?? "auto");
				return toolResult(`Sent message to subagent ${sent.agent.name} (${sent.agent.id}) using ${sent.delivery}${sent.reactivated ? "; reactivated from dormant" : ""}. Status: ${sent.agent.status}. Model: ${modelLabel(sent.agent.model)}.\n\nMessage: ${short(params.message, 500)}`);
			} catch (error) { return toolResult(error instanceof Error ? error.message : String(error), undefined, true); }
		},
	}) satisfies ToolDefinition);
}

function formatKeyHint(key: string): string {
	return key
		.split("/")
		.map((item) => item
			.split("+")
			.map((part) => {
				const display = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
				return display.charAt(0).toUpperCase() + display.slice(1);
			})
			.join("+"))
		.join("/");
}

class SubagentsPanel implements Component, Focusable {
	private selected = 0;
	private readonly input = new Input();
	/** 0 means follow the bottom; positive values scroll upward in rendered log lines. */
	private scrollOffset = 0;
	private status = "";
	private unsubscribe: () => void;
	private unsubscribeEvents: () => void;
	private readonly workingIndicator: Loader;
	private workingIndicatorMessage: string | undefined;
	private workingIndicatorActive = false;
	private logCacheKey = "";
	private logCacheLines: string[] = [];
	private chatContainerKey = "";
	private chatContainer = new Container();
	private readonly chatViews = new Map<string, SubagentChatView>();
	private readonly toolComponents = new Map<string, ToolExecutionComponent>();
	private _focused = false;

	get focused() {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private tui: TUI,
		private ctx: ExtensionContext,
		private keybindings: { matches(data: string, action: string): boolean; getKeys?(action: string): string[] },
		private done: () => void,
	) {
		this.unsubscribe = manager.subscribe(() => this.tui.requestRender());
		this.unsubscribeEvents = manager.subscribeEvents((agent, event) => this.handleAgentEvent(agent, event));
		this.workingIndicator = new Loader(
			this.tui,
			(spinner) => this.ctx.ui.theme.fg("accent", spinner),
			(text) => this.ctx.ui.theme.fg("muted", text),
			"Working...",
		);
		this.workingIndicator.stop();
	}

	dispose() { this.workingIndicator.stop(); this.toolComponents.clear(); this.chatViews.clear(); this.unsubscribeEvents(); this.unsubscribe(); }
	invalidate() { this.input.invalidate(); this.workingIndicator.invalidate(); this.chatContainer.invalidate(); for (const view of this.chatViews.values()) view.container.invalidate(); for (const component of this.toolComponents.values()) component.invalidate(); }

	handleInput(data: string) {
		const agents = manager.list();
		if (data === "\x04" && !this.input.getValue()) { this.dismissSelected(); this.tui.requestRender(); return; }
		// Ctrl-C should interrupt the selected subagent; Escape should close the panel.
		// Some keybinding sets classify Ctrl-C as both app.interrupt and select.cancel,
		// so handle the raw Ctrl-C key before the generic cancel action.
		if (matchesKey(data, "ctrl+c")) { void this.interruptSelected(); this.tui.requestRender(); return; }
		if (this.keybindings.matches(data, "tui.select.cancel")) return this.done();
		if (this.keybindings.matches(data, "app.interrupt")) { void this.interruptSelected(); this.tui.requestRender(); return; }
		if (this.keybindings.matches(data, "tui.select.up")) { this.selected = Math.max(0, this.selected - 1); this.scrollOffset = 0; }
		else if (this.keybindings.matches(data, "tui.select.down")) { this.selected = Math.min(Math.max(0, agents.length - 1), this.selected + 1); this.scrollOffset = 0; }
		else if (this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.altScreen.pageUp")) this.scrollOffset += 10;
		else if (this.keybindings.matches(data, "tui.select.pageDown") || this.keybindings.matches(data, "tui.altScreen.pageDown")) this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		else if (this.keybindings.matches(data, "tui.altScreen.bottom")) this.scrollOffset = 0;
		else if (matchesKey(data, "shift+tab")) { this.selected = agents.length === 0 ? 0 : (this.selected + agents.length - 1) % agents.length; this.scrollOffset = 0; }
		else if (this.keybindings.matches(data, "tui.input.tab")) { this.selected = agents.length === 0 ? 0 : (this.selected + 1) % agents.length; this.scrollOffset = 0; }
		else if (this.keybindings.matches(data, "app.message.followUp")) void this.sendSelected("followUp");
		else if (this.keybindings.matches(data, "tui.input.submit")) void this.sendSelected("auto");
		else this.input.handleInput(data);
		this.tui.requestRender();
	}

	private selectedAgent() { return manager.list()[this.selected]; }

	private async interruptSelected() {
		const agent = this.selectedAgent();
		if (!agent) return;
		if (agent.status !== "starting" && agent.status !== "running") {
			this.status = `${agent.name} is not running`;
			return;
		}
		this.status = `interrupting ${agent.name}…`;
		try { await manager.stop(agent.id); this.status = `interrupted ${agent.name}`; }
		catch (error) { this.status = error instanceof Error ? error.message : String(error); }
		this.tui.requestRender();
	}

	private async sendSelected(delivery: Delivery) {
		const agent = this.selectedAgent();
		const value = this.input.getValue();
		if (!agent || !value.trim()) return;
		const text = value.trim();
		this.input.setValue("");
		this.scrollOffset = 0;
		this.status = `sending to ${agent.name}…`;
		try { await manager.send(agent.id, text, delivery); this.status = `sent to ${agent.name}`; }
		catch (error) { this.status = error instanceof Error ? error.message : String(error); }
		this.tui.requestRender();
	}

	private dismissSelected() {
		const agent = this.selectedAgent();
		if (!agent) return;
		try {
			manager.dismiss(agent.id);
			this.selected = Math.min(this.selected, Math.max(0, manager.list().length - 1));
			this.scrollOffset = 0;
			this.status = `dismissed ${agent.name}`;
		} catch (error) {
			this.status = error instanceof Error ? error.message : String(error);
		}
	}

	private keyHint(action: string, label: string): string | undefined {
		const key = this.keybindings.getKeys?.(action)?.[0];
		return key ? `${formatKeyHint(key)} ${label}` : undefined;
	}

	private syncWorkingIndicator(agent: Subagent | undefined): Component {
		const label = agent ? activeSubagentWorkLabel(agent) : undefined;
		if (!label) {
			if (this.workingIndicatorActive) this.workingIndicator.stop();
			this.workingIndicatorActive = false;
			this.workingIndicatorMessage = undefined;
			return this.workingIndicator;
		}
		const message = `${label}...`;
		if (message !== this.workingIndicatorMessage) {
			this.workingIndicatorMessage = message;
			this.workingIndicator.setMessage(message);
		}
		if (!this.workingIndicatorActive) {
			this.workingIndicator.start();
			this.workingIndicatorActive = true;
		}
		return this.workingIndicator;
	}

	private getToolComponent(agent: Subagent, toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent | undefined {
		const definition = agent.session?.getToolDefinition(toolName);
		if (!definition) return undefined;
		const key = `${agent.id}:${toolCallId}`;
		let component = this.toolComponents.get(key);
		if (!component) {
			component = new ToolExecutionComponent(toolName, toolCallId, args ?? {}, { showImages: false }, definition, this.tui, this.ctx.cwd);
			this.toolComponents.set(key, component);
		} else {
			component.updateArgs(args ?? {});
		}
		return component;
	}

	private appendViewChild(view: SubagentChatView, child: Component): void {
		view.container.addChild(child);
		view.needsSeparator = true;
	}

	private appendToolViewChild(view: SubagentChatView, child: ToolExecutionComponent): void {
		if (view.container.children.includes(child)) return;
		this.appendViewChild(view, child);
	}

	private handleAgentEvent(agent: Subagent, event: AgentSessionEvent): void {
		const view = this.chatViews.get(agent.id);
		if (!view) return;
		const ev = event as any;
		if (ev.type === "message_start") {
			if (ev.message?.role === "assistant") {
				const component = new AssistantMessageComponent(undefined);
				view.streamingComponent = component;
				view.streamingMessage = ev.message;
				this.appendViewChild(view, component);
				component.updateContent(ev.message, true);
			} else if (ev.message?.role === "user") {
				this.appendViewChild(view, new UserMessageComponent(contentText(ev.message.content)));
			}
		} else if (ev.type === "message_update" && ev.message?.role === "assistant") {
			if (!view.streamingComponent) {
				view.streamingComponent = new AssistantMessageComponent(undefined);
				this.appendViewChild(view, view.streamingComponent);
			}
			view.streamingMessage = ev.message;
			view.streamingComponent.updateContent(ev.message, true);
			for (const content of ev.message.content ?? []) {
				if (content?.type !== "toolCall") continue;
				let component = view.pendingTools.get(content.id);
				if (!component) {
					component = this.getToolComponent(agent, content.name, content.id, content.arguments);
					if (!component) continue;
					component.setExpanded(this.ctx.ui.getToolsExpanded());
					this.appendToolViewChild(view, component);
					view.pendingTools.set(content.id, component);
				} else {
					component.updateArgs(content.arguments);
				}
			}
		} else if (ev.type === "message_end" && ev.message?.role === "assistant") {
			view.streamingComponent?.updateContent(ev.message, false);
			view.streamingComponent = undefined;
			view.streamingMessage = undefined;
			for (const component of view.pendingTools.values()) component.setArgsComplete();
		} else if (ev.type === "tool_execution_start") {
			let component = view.pendingTools.get(ev.toolCallId);
			if (!component) {
				component = this.getToolComponent(agent, ev.toolName, ev.toolCallId, ev.args ?? {});
				if (!component) return;
				component.setExpanded(this.ctx.ui.getToolsExpanded());
				this.appendToolViewChild(view, component);
				view.pendingTools.set(ev.toolCallId, component);
			}
			component.markExecutionStarted();
		} else if (ev.type === "tool_execution_update") {
			const component = view.pendingTools.get(ev.toolCallId) ?? this.getToolComponent(agent, ev.toolName, ev.toolCallId, {});
			component?.updateResult({ ...ev.partialResult, isError: false }, true);
		} else if (ev.type === "tool_execution_end") {
			const component = view.pendingTools.get(ev.toolCallId) ?? this.getToolComponent(agent, ev.toolName, ev.toolCallId, {});
			component?.updateResult({ ...ev.result, isError: ev.isError });
			view.pendingTools.delete(ev.toolCallId);
		}
		this.tui.requestRender();
	}

	private pruneToolComponents(agents: Subagent[]): void {
		const liveAgentIds = new Set(agents.map((agent) => agent.id));
		for (const key of this.toolComponents.keys()) {
			const agentId = key.split(":", 1)[0];
			if (!agentId || !liveAgentIds.has(agentId)) this.toolComponents.delete(key);
		}
		for (const agentId of this.chatViews.keys()) {
			if (!liveAgentIds.has(agentId)) this.chatViews.delete(agentId);
		}
	}

	private appendChatChild(container: Container, child: Component, needsSeparator: { value: boolean }): void {
		container.addChild(child);
		needsSeparator.value = true;
	}

	private rebuildChatContainer(agent: Subagent, width: number, toolsExpanded: boolean): Container {
		const container = new Container();
		const messages = (agent.messages as any[]).slice(-100);
		const toolResults = new Map<string, { result: any; partial?: boolean }>();
		const renderedUserTexts = new Set<string>();
		const needsSeparator = { value: false };

		for (const message of messages) {
			if (message && typeof message === "object" && message.role === "toolResult") toolResults.set(message.toolCallId, { result: message });
			if (message && typeof message === "object" && message.role === "user") renderedUserTexts.add(contentText(message.content).trim());
		}
		for (const entry of agent.transcript) {
			if (entry.kind === "tool" && entry.toolCallId && entry.result && !toolResults.has(entry.toolCallId)) toolResults.set(entry.toolCallId, { result: entry.result, partial: entry.resultPartial });
		}

		if (messages.length === 0) {
			for (const line of renderTranscriptFallback(agent, width, this.ctx.ui.theme, toolsExpanded, (a, name, id, args) => this.getToolComponent(a, name, id, args))) {
				container.addChild(new LinesComponent([line]));
			}
		} else {
			for (const message of messages) {
				if (!message || typeof message !== "object") continue;
				if (message.role === "assistant") {
					this.appendChatChild(container, new AssistantMessageComponent(message as never), needsSeparator);
					for (const content of message.content ?? []) {
						if (content?.type !== "toolCall") continue;
						const component = this.getToolComponent(agent, content.name, content.id, content.arguments);
						if (!component) continue;
						component.setExpanded(toolsExpanded);
						component.markExecutionStarted();
						component.setArgsComplete();
						const result = toolResults.get(content.id);
						if (result) component.updateResult(result.result, result.partial);
						else if (message.stopReason === "aborted" || message.stopReason === "error") component.updateResult({ content: [{ type: "text", text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error") }], isError: true });
						this.appendChatChild(container, component, needsSeparator);
					}
				} else if (message.role === "toolResult") {
					// Rendered with its assistant tool call.
				} else if (message.role === "user") {
					this.appendChatChild(container, new UserMessageComponent(contentText(message.content)), needsSeparator);
				} else {
					this.appendChatChild(container, new LinesComponent(renderMessageFallback(message, width, this.ctx.ui.theme)), needsSeparator);
				}
			}

			for (const entry of agent.transcript.slice(-100)) {
				if (!isVisibleSupplementalSystemEntry(entry)) continue;
				const text = entry.text.trim();
				if (!text) continue;
				if (entry.kind === "user") {
					if (renderedUserTexts.has(text)) continue;
					this.appendChatChild(container, new UserMessageComponent(text), needsSeparator);
					renderedUserTexts.add(text);
				} else if (entry.kind === "system" || entry.kind === "error") {
					const color = entry.kind === "error" ? "error" : "dim";
					this.appendChatChild(container, new LinesComponent(renderPlainBlock(text, width, (line) => this.ctx.ui.theme.fg(color, line))), needsSeparator);
				}
			}
		}

		if (container.children.length === 0) container.addChild(new LinesComponent([this.ctx.ui.theme.fg("dim", "No transcript yet.")]));
		return container;
	}

	private renderCachedChatLog(agent: Subagent, width: number, toolsExpanded: boolean): string[] {
		const isActive = Boolean(activeSubagentWorkLabel(agent));
		const toolResultCount = agent.transcript.filter((entry) => entry.kind === "tool" && entry.result).length;
		const key = isActive
			? [agent.id, "live", width, toolsExpanded ? 1 : 0].join(":")
			: [agent.id, agent.updatedAt, agent.messages.length, agent.transcript.length, toolResultCount, width, toolsExpanded ? 1 : 0].join(":");
		let view = this.chatViews.get(agent.id);
		if (!view || view.key !== key) {
			const container = this.rebuildChatContainer(agent, width, toolsExpanded);
			view = { container, pendingTools: new Map(), needsSeparator: container.children.length > 0, key };
			this.chatViews.set(agent.id, view);
		}
		this.chatContainerKey = key;
		this.chatContainer = view.container;
		return view.container.render(width).map(stripTranscriptControlCodes);
	}

	private footerText(): string {
		if (this.status) return this.status;
		return [
			this.keyHint("tui.input.submit", "send/steer"),
			this.keyHint("app.message.followUp", "follow-up"),
		]
			.filter((part): part is string => Boolean(part))
			.join(" • ");
	}

	render(width: number): string[] {
		const agents = manager.list();
		this.pruneToolComponents(agents);
		const w = width;
		const innerWidth = Math.max(1, w - 4);
		const termHeight = process.stdout.rows || 24;
		const maxOverlayHeight = Math.floor(termHeight * 0.72);
		const bodyHeight = Math.max(8, maxOverlayHeight - 2); // Leave room for the border so small terminals don't clip the input/footer.
		const lines: string[] = [];
		if (agents.length === 0) {
			this.syncWorkingIndicator(undefined);
			lines.push("No subagents yet.");
		} else {
			const tabs = agents.map((agent, i) => {
				const marker = agent.status === "running" || agent.status === "starting" ? "●" : agent.status === "failed" || agent.status === "cancelled" ? "✗" : agent.dormant ? "◌" : "○";
				const label = `${marker} ${agent.name}`;
				return i === this.selected ? this.ctx.ui.theme.bg("selectedBg", this.ctx.ui.theme.fg("accent", ` ${label} `)) : this.ctx.ui.theme.fg("dim", ` ${label} `);
			});
			const { start, end } = visibleWindowAroundSelected({
				count: tabs.length,
				selected: this.selected,
				maxWidth: innerWidth,
				itemWidth: (i) => visibleWidth(tabs[i] ?? ""),
			});
			const tabsLine = `${start > 0 ? "‹ " : ""}${tabs.slice(start, end).join(" ")}${end < tabs.length ? " ›" : ""}`;
			lines.push(truncateToWidth(tabsLine, innerWidth));
			lines.push("═".repeat(innerWidth));
			const agent = agents[this.selected];
			if (agent) {
				const visibility = agent.dormant ? "dormant" : "active";
				lines.push(this.ctx.ui.theme.fg("accent", `${agent.name}`) + this.ctx.ui.theme.fg("dim", `  ${agent.status} · ${visibility} · ${agent.id}`));
				lines.push(this.ctx.ui.theme.fg("dim", `model: ${modelLabel(agent.model)}${agent.thinkingLevel && agent.thinkingLevel !== "off" ? ` (${agent.thinkingLevel})` : ""}`));
				const activeTools = agent.session?.getActiveToolNames().join(", ") || "(runtime unavailable)";
				lines.push(this.ctx.ui.theme.fg("dim", `tools: ${short(activeTools, Math.max(20, innerWidth - 7))}`));
				lines.push(this.ctx.ui.theme.fg("dim", `instructions: ${short(agent.instructions, Math.max(20, innerWidth - 14))}`));
				lines.push("");
				const workingIndicator = this.syncWorkingIndicator(agent);
				const logLines = [...this.renderCachedChatLog(agent, innerWidth, this.ctx.ui.getToolsExpanded())];
				if (activeSubagentWorkLabel(agent)) logLines.push(...workingIndicator.render(innerWidth).map(stripTranscriptControlCodes));
				const reservedForInput = 4;
				const maxLogLines = Math.max(4, bodyHeight - lines.length - reservedForInput);
				if (logLines.length > maxLogLines) {
					const viewportLines = Math.max(1, maxLogLines - 1);
					const maxOffset = Math.max(0, logLines.length - viewportLines);
					this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
					const end = logLines.length - this.scrollOffset;
					const start = Math.max(0, end - viewportLines);
					const hiddenBefore = start;
					const hiddenAfter = logLines.length - end;
					const indicator = hiddenAfter > 0
						? `↑ ${hiddenBefore} earlier • ↓ ${hiddenAfter} later`
						: `… ${hiddenBefore} earlier lines hidden`;
					lines.push(this.ctx.ui.theme.fg("dim", indicator));
					lines.push(...logLines.slice(start, end));
				} else {
					this.scrollOffset = 0;
					lines.push(...logLines);
				}
			}
		}

		const renderedInput = this.input.render(innerWidth);
		const footer = this.footerText();
		const inputHeight = renderedInput.length + 1 + (footer ? 1 : 0);
		while (lines.length < bodyHeight - inputHeight) lines.push("");
		if (lines.length > bodyHeight - inputHeight) lines.splice(0, lines.length - (bodyHeight - inputHeight), this.ctx.ui.theme.fg("dim", "… earlier panel content hidden"));
		lines.push(this.ctx.ui.theme.fg("dim", "─".repeat(innerWidth)));
		lines.push(...renderedInput.map((line) => truncateToWidth(line, innerWidth)));
		if (footer) lines.push(truncateToWidth(this.ctx.ui.theme.fg("dim", footer), innerWidth));
		return bordered(lines, w, "subagent console", (text) => this.ctx.ui.theme.fg("accent", text));
	}
}

export default function extension(pi: ExtensionAPI) {
	manager.setApi(pi);
	idleStatusBridge().subagentsActiveCount = () => manager.activeCount();
	installTools(pi);

	function ensureActiveTools() {
		const active = new Set(pi.getActiveTools());
		active.add("spawn_subagent");
		active.add("list_subagents");
		active.add("inspect_subagent");
		active.add("message_subagent");
		active.add("update_subagent");
		active.add("dismiss_subagent");
		pi.setActiveTools([...active]);
	}

	pi.on("session_start", (_event, ctx) => { manager.setContext(ctx); ensureActiveTools(); });
	pi.on("session_shutdown", () => { delete idleStatusBridge().subagentsActiveCount; manager.dispose(); });

	pi.registerCommand("subagents", {
		description: "Open a live subagent watcher. Select a subagent and send messages directly to it.",
		handler: async (_args, ctx) => {
			manager.setContext(ctx);
			ensureActiveTools();
			if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("/subagents requires the TUI", "warning"); return; }
			await ctx.ui.custom<void>((tui, _theme, keybindings, done) => new SubagentsPanel(tui, ctx, keybindings, done), {
				overlay: true,
				overlayOptions: { width: "86%", maxHeight: "72%", anchor: "center" },
			});
		},
	});

}
