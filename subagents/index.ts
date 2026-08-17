import { sessionHome } from "../shared/session-home.ts";
import {
	ownedUI,
	remoteUI,
	nativeOwnedPrompt,
	setOwnedStatus,
	remoteLogin,
	REMOTE_LOGIN_UNSUPPORTED,
} from "../shared/owned-ui.ts";
import type { LocalPanelHost } from "./local-panel-host.ts";
import { installClientModeHooks } from "../remote/client-mode.ts";
import type { PanelChildView } from "./panel-host.ts";
import type { ToolExecution } from "../remote/protocol.ts";
import { bindIdleStatus } from "../shared/idle-status.ts";
import { randomUUID } from "node:crypto";
import {
	publishService,
	type SubagentPort,
	type ChildSummary,
	type ChildInspection,
} from "../shared/control-plane.ts";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionShutdownEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { newestFirst, shortText, transitionTaskStatus } from "../shared/task-lifecycle.ts";
import { activityLabel } from "../shared/activity.ts";
import { publishSubagentTranscript } from "../shared/session-system.ts";
import { permissionsBridge, stageSharedPermissions } from "../permissions/src/bridge.ts";
import { CHILD_SYSTEM_PROMPT, PARENT_PROVENANCE_GUIDELINE } from "./protocol.ts";
import {
	installSubagentMessaging,
	messageProvenance,
	type SubagentMessaging,
} from "./messaging.ts";
import { selectSubagentModel } from "./model-selection.ts";
import { registerSubagentQuiescer } from "./quiesce.ts";
import { createLinkedOwner } from "../remote/owner.ts";
import { createParentUIRoute } from "./ui-routing.ts";
import type { ChildView, ChildFrame, ChildImages } from "../shared/control-plane.ts";
import type { Snapshot } from "../remote/protocol.ts";

type SubagentStatus = "starting" | "running" | "idle" | "failed" | "cancelled";
type Delivery = "auto" | "prompt" | "steer" | "followUp";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type TranscriptLine = {
	time: number;
	kind: "assistant" | "tool" | "user" | "system" | "error";
	text: string;
	toolName?: string;
	toolCallId?: string;
	userMessage?: AgentSession["messages"][number];
	args?: unknown;
	result?: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError: boolean };
	resultPartial?: boolean;
};

type Subagent = {
	controlRevision: number;
	id: string;
	name: string;
	instructions: string;
	initialOrigin?: "parent" | "user";
	dormant?: boolean;
	model?: any;
	thinkingLevel?: ThinkingLevel;
	sessionFile?: string;
	sessionIdentity?: string;
	initialization?: Promise<void>;
	initializationAbort?: AbortController;
	/** Teardown owns the runtime until it settles; new deliveries wait outside it. */
	retirement?: Promise<void>;
	/** Shared owner relationship survives child reload, but not runtime retirement. */
	releasePermissions?: () => void;
	operations: Set<Promise<unknown>>;
	status: SubagentStatus;
	createdAt: number;
	updatedAt: number;
	/** UI recency: trusted human input/control only, never runtime activity. */
	lastHumanInteractionAt?: number;
	session?: AgentSession;
	nativeView?: ReturnType<typeof createLinkedOwner>;
	nativeViewIdentity?: string;
	nativeAPI?: ExtensionAPI;
	parentUIRoute?: ReturnType<typeof createParentUIRoute>;
	messaging?: SubagentMessaging;
	modelRuntime?: ModelRuntime;
	unsubscribe?: () => void;
	/** Simplified event log used for tools/status. */
	transcript: TranscriptLine[];
	/** Raw pi messages from the child AgentSession, used for normal transcript rendering. */
	messages: AgentSession["messages"];
	streamingMessage?: Extract<AgentSession["messages"][number], { role: "assistant" }>;
	streamText: string;
	finalText: string;
	activity?: string;
	activeToolNames: Set<string>;
	queuedSteering: string[];
	queuedFollowUp: string[];
	/** Recovered input, not native queued work. Delivery may have finished during shutdown. */
	parkedQueue?: { steering: string[]; followUp: string[] };
	error?: string;
	closedAt?: number;
	/** Usage is retained after a child runtime is disposed so the live footer stays accurate. */
	usage: UsageTotals;
	/** UI-only status, analogous to InteractiveMode.showStatus(). */
	uiStatus?: { text: string; kind: "system" | "error" };
	cancelRequested?: boolean;
	interruptRequested?: boolean;
};

const SUBAGENT_STATE = "subagent.state";
const SUBAGENT_DELEGATION = "subagent.delegation";
type SavedSubagent = Pick<Subagent, "id" | "name" | "instructions" | "initialOrigin" | "dormant" | "thinkingLevel" | "sessionFile" | "sessionIdentity" | "status" | "createdAt" | "updatedAt" | "lastHumanInteractionAt" | "error" | "usage" | "queuedSteering" | "queuedFollowUp" | "parkedQueue"> & {
	ownerSessionId: string;
	model?: { provider: string; id: string };
};

type SubagentChildBridge = {
	instances: Map<string, { notify(message: string): void; connect?(api: ExtensionAPI): void }>;
};


function childBridge(): SubagentChildBridge {
	const global = globalThis as typeof globalThis & { __piSubagentChildBridge?: SubagentChildBridge };
	global.__piSubagentChildBridge ??= { instances: new Map() };
	return global.__piSubagentChildBridge;
}


const extensionDir = dirname(fileURLToPath(import.meta.url));
const childExtensionPath = join(extensionDir, "child.ts");
function siblingExtensionEntryPaths(): string[] {
	const root = dirname(extensionDir);
	const paths: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (["subagents", "thinking", "session-defaults"].includes(entry.name)) continue;
		const path = join(root, entry.name);
		if (entry.isFile() || entry.isSymbolicLink()) {
			if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) paths.push(path);
			continue;
		}
		if (!entry.isDirectory()) continue;
		// Permissions intentionally keeps its real factory below src/; load that
		// file directly in child sessions so its command registrations survive the
		// isolated loader rather than relying on an index re-export.
		if (entry.name === "permissions") {
			const implementation = join(path, "src", "extension.ts");
			if (existsSync(implementation)) paths.push(implementation);
			continue;
		}
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

function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function usageNumber(value: unknown): number {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
	return Number.isFinite(number) ? number : 0;
}

function usageCost(usage: any): number {
	const cost = usage?.cost;
	return typeof cost === "object" && cost !== null ? usageNumber(cost.total ?? cost.amount) : usageNumber(cost);
}

/** Mirror the footer's accounting rules against this child's native session entries. */
function updateUsage(agent: Subagent): void {
	if (!agent.session) return;
	const totals = emptyUsage();
	for (const entry of agent.session.sessionManager.getEntries() as Array<any>) {
		const message = entry?.message;
		const usage = message?.usage ?? entry?.usage;
		if (!usage || typeof usage !== "object") continue;
		if (message && message.role !== "assistant" && message.role !== "toolResult") continue;
		totals.input += usageNumber(usage.input);
		totals.output += usageNumber(usage.output);
		totals.cacheRead += usageNumber(usage.cacheRead);
		totals.cacheWrite += usageNumber(usage.cacheWrite);
		totals.cost += usageCost(usage);
	}
	agent.usage = totals;
}

function appendTranscript(agent: Subagent, kind: TranscriptLine["kind"], text: string, userMessage?: AgentSession["messages"][number]) {
	if (!text.trim()) return;
	agent.transcript.push({ time: now(), kind, text, userMessage });
	if (agent.transcript.length > 500) agent.transcript.splice(0, agent.transcript.length - 500);
	agent.updatedAt = now();
}

class SubagentControlConflict extends Error {
	readonly code = "STALE_CONTROL";
	constructor() {
		super("Subagent control revision conflict. Refresh before retrying.");
	}
}

class SubagentManager {
	private agents = new Map<string, Subagent>();
	private controlCounter = 0;
	private activeId: string | undefined;
	private uiCtx?: ExtensionContext;
	private api?: ExtensionAPI;
	private listeners = new Set<() => void>();
	private eventListeners = new Set<(agent: Subagent, event: AgentSessionEvent) => void>();
	private stopping = false;
	private disposePromise?: Promise<void>;
	private unregisterQuiescence?: () => void;
	private sessionCtx?: ExtensionContext;

	isAccepting(): boolean {
		return !this.stopping;
	}

	private assertActive() {
		if (this.stopping) throw new Error("Subagents are shutting down.");
	}

	private checkControl(agent: Subagent, expected?: number) {
		this.assertActive();
		if (this.agents.get(agent.id) !== agent || (expected !== undefined && agent.controlRevision !== expected))
			throw new SubagentControlConflict();
	}
	private advanceControl(agent: Subagent): number {
		return (agent.controlRevision = ++this.controlCounter);
	}
	private admitControl(agent: Subagent, expected?: number): number {
		this.checkControl(agent, expected);
		return this.advanceControl(agent);
	}

	private track<T>(agent: Subagent, operation: Promise<T>): Promise<T> {
		agent.operations.add(operation);
		void operation.then(() => agent.operations.delete(operation), () => agent.operations.delete(operation));
		return operation;
	}

	private publishTranscript(agent: Subagent) {
		const file = agent.session?.sessionFile ?? agent.sessionFile;
		if (this.sessionCtx && file) publishSubagentTranscript(this.sessionCtx, agent.id, file);
	}

	private persist(agent: Subagent) {
		if (!this.sessionCtx || !this.api) return;
		// Pi reserves a session filename before it writes the first assistant
		// message. Do not turn an interrupted startup into a missing archive.
		const file = agent.session?.sessionFile;
		if (file && existsSync(file)) agent.sessionFile = file;
		this.publishTranscript(agent);
		const { id, name, instructions, initialOrigin, dormant, thinkingLevel, sessionFile, sessionIdentity, status, createdAt, updatedAt, lastHumanInteractionAt, error, usage, queuedSteering, queuedFollowUp, parkedQueue } = agent;
		this.api.appendEntry<SavedSubagent>(SUBAGENT_STATE, {
			ownerSessionId: this.sessionCtx.sessionManager.getSessionId(),
			id, name, instructions, initialOrigin, dormant, thinkingLevel, sessionFile, sessionIdentity, status, createdAt, updatedAt, lastHumanInteractionAt, error,
			model: agent.model ? { provider: agent.model.provider, id: agent.model.id } : undefined,
			usage: { ...usage }, queuedSteering: [...queuedSteering], queuedFollowUp: [...queuedFollowUp],
			parkedQueue: parkedQueue ? { steering: [...parkedQueue.steering], followUp: [...parkedQueue.followUp] } : undefined,
		});
	}

	restore(ctx: ExtensionContext) {
		this.stopping = false;
		this.disposePromise = undefined;
		this.sessionCtx = ctx;
		this.agents.clear();
		this.activeId = undefined;
		const recoverHumanInteraction = new Set<string>();
		// Resource records follow the owning session, not conversation-tree navigation.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== SUBAGENT_STATE) continue;
			const saved = entry.data as SavedSubagent | undefined;
			if (!saved || saved.ownerSessionId !== ctx.sessionManager.getSessionId()
				|| typeof saved.id !== "string" || typeof saved.name !== "string" || typeof saved.instructions !== "string") continue;
			const agent: Subagent = {
				controlRevision: ++this.controlCounter,
				// Restore actor state only, never obsolete permission configuration.
				id: saved.id, name: saved.name, instructions: saved.instructions, initialOrigin: saved.initialOrigin,
				dormant: saved.dormant, model: saved.model, thinkingLevel: saved.thinkingLevel,
				sessionFile: saved.sessionFile, sessionIdentity: saved.sessionIdentity,
				createdAt: saved.createdAt, updatedAt: saved.updatedAt, error: saved.error,
				lastHumanInteractionAt: Number.isFinite(saved.lastHumanInteractionAt) ? saved.lastHumanInteractionAt : undefined,
				status: saved.status === "starting" || saved.status === "running" ? "idle" : saved.status,
				operations: new Set(), transcript: [], messages: [], streamText: "", finalText: "", activeToolNames: new Set(),
				queuedSteering: [], queuedFollowUp: [],
				parkedQueue: {
					steering: [...(saved.parkedQueue?.steering ?? []), ...(saved.queuedSteering ?? [])],
					followUp: [...(saved.parkedQueue?.followUp ?? []), ...(saved.queuedFollowUp ?? [])],
				},
				usage: { ...(saved.usage ?? emptyUsage()) },
			};
			this.agents.set(agent.id, agent);
			if (saved.lastHumanInteractionAt === undefined) recoverHumanInteraction.add(agent.id);
			else recoverHumanInteraction.delete(agent.id);
		}
		for (const agent of this.agents.values()) {
			if (!agent.sessionFile) continue;
			this.publishTranscript(agent);
			try {
				const archive = this.openArchive(agent, ctx);
				if (recoverHumanInteraction.has(agent.id)) {
					// Legacy UI recency follows actual interaction across the native archive,
					// including compacted/abandoned branches, not model-visible text labels.
					for (const entry of archive.getEntries()) {
						if (entry.type !== "message" || messageProvenance(entry.message)?.origin !== "user"
							|| !Number.isFinite(entry.message.timestamp)) continue;
						agent.lastHumanInteractionAt = Math.max(agent.lastHumanInteractionAt ?? -Infinity, entry.message.timestamp);
					}
					if (agent.lastHumanInteractionAt !== undefined) this.persist(agent);
				}
				agent.sessionIdentity = archive.getSessionId();
				const context = archive.buildSessionContext();
				agent.messages = context.messages;
				if (context.model) agent.model = { provider: context.model.provider, id: context.model.modelId };
				agent.thinkingLevel = context.thinkingLevel as ThinkingLevel;
				// Inspection uses the native branch, not compacted inference context:
				// older human amendments and tool results must remain inspectable.
				for (const entry of archive.getBranch()) {
					if (entry.type === "message") {
						const message = entry.message;
						if (message.role === "user" || message.role === "assistant") {
							agent.transcript.push({ time: message.timestamp, kind: message.role, text: contentText(message.content), userMessage: message.role === "user" ? message : undefined });
						} else if (message.role === "toolResult") {
							agent.transcript.push({ time: message.timestamp, kind: "tool", text: `${message.isError ? "✗" : "✓"} ${message.toolName}\n${contentText(message.content)}` });
						}
					} else if (entry.type === "custom_message") {
						agent.transcript.push({ time: Date.parse(entry.timestamp), kind: "system", text: contentText(entry.content) });
					} else if (entry.type === "compaction" || entry.type === "branch_summary") {
						agent.transcript.push({ time: Date.parse(entry.timestamp), kind: "system", text: entry.summary });
					}
				}
			} catch (error) {
				agent.error = `Cannot read child transcript: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		this.setContext(ctx);
	}

	private openArchive(agent: Subagent, ctx: ExtensionContext) {
		const directory = join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId());
		if (!agent.sessionFile || dirname(agent.sessionFile) !== directory || !existsSync(agent.sessionFile)) {
			throw new Error(`Child transcript is unavailable: ${agent.sessionFile ?? agent.id}`);
		}
		return SessionManager.open(agent.sessionFile, directory, sessionHome());
	}

	inspectNative(id: string, { offset = 0, limit = 32 }: { offset?: number; limit?: number } = {}): ChildInspection {
		this.assertActive();
		const agent = this.getAny(id);
		if (!agent) throw new Error(`Unknown subagent: ${id}`);
		const sourceFile = agent.session?.sessionFile ?? agent.sessionFile;
		try {
			const archive = agent.session?.sessionManager ?? this.openArchive(agent, this.sessionCtx!);
			const entries = archive.getEntries();
			return structuredClone({
				child: childSummary(agent),
				sourceFile,
				available: true,
				leafId: archive.getLeafId(),
				header: archive.getHeader() ?? undefined,
				entryCount: entries.length,
				entries: entries.slice(offset, offset + limit),
			});
		} catch (error) {
			return { child: childSummary(agent), sourceFile, available: false, error: String(error), entryCount: 0, entries: [] };
		}
	}

	private frameListeners = new Set<(event: ChildFrame) => void>();

	subscribeFrames(listener: (event: ChildFrame) => void) {
		this.frameListeners.add(listener);
		return () => {
			this.frameListeners.delete(listener);
			if (this.frameListeners.size) return;
			// Service withdrawal ends observation/presentation, never the actor.
			for (const agent of this.agents.values()) {
				agent.parentUIRoute?.close();
				// Future ordinary-TUI requests still use the parent; withdrawing
				// native observation must not switch an actor to print-mode denial.
				agent.parentUIRoute = this.sessionCtx ? this.parentUIRoute(agent, this.sessionCtx) : undefined;
				void agent.nativeView?.close().catch((error) => this.note(agent.id, String(error), "error"));
				agent.nativeView = undefined;
			}
		};
	}

	view(id: string): ChildView {
		this.assertActive();
		const agent = this.getAny(id);
		if (!agent) throw Error(`Unknown subagent: ${id}`);
		if (agent.session && !agent.nativeView && agent.nativeAPI) this.connectNativeView(agent, agent.nativeAPI, this.sessionCtx!);
		if (agent.nativeView) return {
			child: childSummary(agent), dormant: false,
			snapshot: structuredClone(agent.nativeView.snapshot()) as Snapshot,
		};
		const archive = agent.session?.sessionManager ?? this.openArchive(agent, this.sessionCtx!);
		return {
			child: childSummary(agent), dormant: !agent.session, snapshot: null,
			commandNames: this.autocompleteCommands(id).map(({ name, description }) => ({ name, description })),
			archive: structuredClone({ header: archive.getHeader() ?? null, entries: archive.getEntries(), leafId: archive.getLeafId(), sessionFile: archive.getSessionFile(), cwd: archive.getCwd() }),
		};
	}

	async viewControl(id: string, revision: number, nativeIdentity: string, method: string, params: Record<string, unknown>, assertParent?: () => void) {
		this.assertActive();
		const agent = this.getAny(id);
		if (!agent || !agent.nativeView || agent.nativeViewIdentity !== nativeIdentity) throw Error("STALE_CHILD_IDENTITY");
		this.checkControl(agent, revision);
		return agent.nativeView.embeddedRequest(method, { ...params, childRevision: revision, nativeIdentity, assertParent });
	}

	private connectNativeView(agent: Subagent, api: ExtensionAPI, parent: ExtensionContext) {
		agent.nativeAPI = api;
		// Ordinary TUI-only subagents use their parent UI without a wire projection.
		if (!this.frameListeners.size) { this.changed(); return; }
		const session = agent.session!;
		// Reload retains the native session UUID but replaces its service/UI lifetime.
		if (agent.nativeView) agent.parentUIRoute?.close();
		if (!agent.parentUIRoute || agent.parentUIRoute.closed)
			agent.parentUIRoute = this.parentUIRoute(agent, parent);
		void agent.nativeView?.close();
		const identity = `${session.sessionId}:${randomUUID()}`;
		agent.nativeViewIdentity = identity;
		const check = (params: Record<string, unknown>) => {
			if (typeof params.assertParent === "function") params.assertParent();
			this.assertActive();
			if (agent.session !== session || agent.nativeViewIdentity !== params.nativeIdentity || agent.retirement) throw Error("STALE_CHILD_IDENTITY");
			if (!Number.isSafeInteger(params.childRevision)) throw Error("INVALID_CHILD_REVISION");
			this.checkControl(agent, params.childRevision as number);
		};
		agent.nativeView = createLinkedOwner(api, session, join(sessionHome(), ".pi-child-view-unused"), parent.ui, {
			embedded: {
				check,
				track: (operation, command) => {
					// Manager ingress/stop already owns its joins; never let stop join itself.
					if (!["prompt", "steer", "followUp", "abort", "clearQueue"].includes(command)) this.track(agent, operation);
				},
				emit: (frame) => {
					if (agent.session !== session || agent.nativeViewIdentity !== identity || this.stopping) return;
					const event = { childId: agent.id, nativeIdentity: identity, frame };
					for (const listener of this.frameListeners) { try { listener(structuredClone(event)); } catch {} }
					if (frame.type === "operation") {
						agent.model = session.model;
						agent.thinkingLevel = session.thinkingLevel;
						agent.name = session.sessionManager.getSessionName() ?? agent.name;
						this.changed(agent);
					}
				},
				command: (command, args, params) => {
					const revision = params.childRevision as number;
					if (["prompt", "steer", "followUp"].includes(command)) {
						if (typeof args[0] !== "string") throw Error("CHILD_TEXT_REQUIRED");
						const promptOptions = args[1] as { images?: ChildImages; streamingBehavior?: "steer" | "followUp" } | undefined;
						const delivery = command === "prompt" ? promptOptions?.streamingBehavior ?? "auto" : command as Delivery;
						const images = command === "prompt" ? promptOptions?.images : args[1] as ChildImages;
						return { handled: true, value: this.submitHumanInput(agent.id, args[0], delivery, revision, () => {
							if (typeof params.assertParent === "function") params.assertParent();
							if (agent.nativeViewIdentity !== identity) throw Error("STALE_CHILD_IDENTITY");
						}, images).then(() => childSummary(agent)) };
					}
					if (command === "abort") return { handled: true, value: this.stop(agent.id, revision, "user") };
					if (command === "clearQueue") return { handled: true, value: this.dequeue(agent.id, revision, "user") };
					this.admitControl(agent, revision);
					this.recordHumanInteraction(agent);
					this.changed();
					return undefined;
				},
			},
		});
		queueMicrotask(() => {
			if (agent.session !== session || agent.nativeViewIdentity !== identity || !agent.nativeView) return;
			const event: ChildFrame = { childId: agent.id, nativeIdentity: identity, frame: agent.nativeView.snapshot() as Snapshot };
			for (const listener of this.frameListeners) { try { listener(structuredClone(event)); } catch {} }
			this.changed();
		});
	}

	setApi(api: ExtensionAPI) {
		this.api = api;
	}

	registerQuiescence(sessionId: string, retireService: () => void) {
		this.unregisterQuiescence?.();
		this.unregisterQuiescence = registerSubagentQuiescer(sessionId, (reason) => {
			// Permissions quiesces children before our own shutdown hook. Withdraw
			// the live port before fencing its manager so observers cannot call it.
			retireService();
			return this.dispose(reason);
		});
	}

	autocompleteCommands(id: string) {
		const agent = this.getAny(id);
		if (!agent) return [];
		if (!agent.session || agent.retirement) {
			// Preserve the pre-existing dormant editor vocabulary without waking a child.
			// These owner-advertised names are hints, not a child execution/callback catalog.
			return (this.api?.getCommands() ?? []).filter((command) => command.name !== "subagents")
				.map(({ name, description }) => ({ name, description, argumentCompletions: false }));
		}
		const completing = new Set(agent.session.extensionRunner.getRegisteredCommands()
			.filter((command) => command.getArgumentCompletions).map((command) => command.invocationName));
		return (agent.nativeAPI?.getCommands() ?? []).map(({ name, description }) => ({
			name, description, argumentCompletions: completing.has(name),
		}));
	}

	setContext(ctx: ExtensionContext) {
		this.uiCtx = ctx;
		this.refreshUi();
	}

	/** Parent-owned presentation never depends on which activity panel is open. */
	private parentUIRoute(agent: Subagent, parent: ExtensionContext) {
		return createParentUIRoute(parent.ui, () => agent.name, (message, kind) =>
			this.note(agent.id, message, kind === "error" ? "error" : "system"));
	}

	private childUiContext(agent: Subagent, parent: ExtensionContext): any {
		agent.parentUIRoute = this.parentUIRoute(agent, parent);
		const noop = () => {};
		const fallback = {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message: string, kind: "info" | "warning" | "error" = "info") =>
				this.note(agent.id, message, kind === "error" ? "error" : "system"),
			onTerminalInput: () => () => {},
			setStatus: noop, setWorkingMessage: noop, setWorkingVisible: noop,
			setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop,
			setFooter: noop, setHeader: noop, setTitle: noop,
			custom: async () => undefined,
			pasteToEditor: noop, setEditorText: noop, getEditorText: () => "", editor: async () => undefined,
			addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: () => undefined,
			theme: parent.ui.theme, getAllThemes: () => parent.ui.getAllThemes(),
			getTheme: (name: string) => parent.ui.getTheme(name), setTheme: noop,
			getToolsExpanded: () => false, setToolsExpanded: noop,
		};
		// The SDK copies UI contexts. Make this finite data channel enumerable rather
		// than relying on a Proxy get-only property that disappears during that copy.
		if (remoteUI(parent.ui))
			Object.defineProperty(fallback, ownedUI, {
				enumerable: true,
				value: {
					remote: true,
					footer: () => {},
					status: () => {},
					present: (
						request: Parameters<NonNullable<ReturnType<typeof remoteUI>>["present"]>[0],
					) => {
						const route = agent.parentUIRoute;
						if (!route || route.closed) return Promise.resolve();
						return nativeOwnedPrompt(agent.session!.extensionRunner, request.label, () =>
							remoteUI(route.ui as ExtensionContext["ui"])!.present(request),
						);
					},
				},
			});

		// Dialogs/notifications always use the parent native UI, visible to its
		// current controller (including the remote TUI) even with no child panel.
		// Other child presentation state stays on its canonical native projection.
		return new Proxy(fallback, {
			get(target, property) {
				if (property === ownedUI) return Reflect.get(target, property);
				const routed = agent.parentUIRoute?.ui;
				if (routed && property in routed) return Reflect.get(routed, property);
				const ui = agent.nativeView?.uiContext;
				return ui && property in ui ? Reflect.get(ui, property) : Reflect.get(target, property);
			},
		});
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

	private changed(agent?: Subagent) {
		if (agent) this.persist(agent);
		for (const listener of this.listeners) listener();
		this.refreshUi();
	}

	private notifyParent(agent: Subagent, message: string) {
		// Suppress late agent reports after the user interrupts a run.
		if (this.stopping || agent.retirement || agent.interruptRequested || agent.cancelRequested) return;
		agent.dormant = false;
		const reportFailure = (error: unknown) => {
			const detail = error instanceof Error ? error.message : String(error);
			agent.error = `Parent notification failed: ${detail}`;
			appendTranscript(agent, "error", agent.error);
			this.changed();
		};
		if (!this.api) {
			reportFailure("parent messaging API is unavailable");
			return;
		}
		try {
			void this.track(agent, Promise.resolve(this.api.sendMessage({
				customType: "subagent.notify",
				display: true,
				content: `Subagent ${agent.name} (${agent.id}) [${agent.status}]:\n\n${message}`,
				details: { taskId: agent.id, taskName: agent.name, status: agent.status, message, origin: "subagent" },
			}, { triggerTurn: true, deliverAs: "followUp" })).catch(reportFailure));
		} catch (error) {
			reportFailure(error);
			return;
		}
		this.changed();
	}

	private isTerminal(agent: Subagent) {
		return agent.status === "failed" || agent.status === "cancelled";
	}

	private async unloadRuntime(agent: Subagent, reason: SessionShutdownEvent["reason"] = "quit", extensionsStopped = false) {
		const session = agent.session;
		const errors: unknown[] = [];
		const release = async (action: () => unknown) => {
			try { await action(); } catch (error) { errors.push(error); }
		};
		await release(() => agent.parentUIRoute?.close());
		agent.parentUIRoute = undefined;
		await release(() => agent.nativeView?.close());
		agent.nativeView = undefined;
		agent.nativeAPI = undefined;
		if (session && !extensionsStopped) await release(() => session.extensionRunner.emit({ type: "session_shutdown", reason }));
		await release(() => agent.messaging?.dispose());
		await release(() => session?.settingsManager.flush());
		// A persistence failure must not skip releasing subscriptions/runtimes.
		await release(() => {
			if (session) {
				agent.model = session.model;
				agent.thinkingLevel = session.thinkingLevel;
				agent.messages = [...session.messages];
			}
			updateUsage(agent);
			this.persist(agent);
		});
		await release(() => agent.unsubscribe?.());
		agent.unsubscribe = undefined;
		if (session) {
			childBridge().instances.delete(session.sessionId);
			await release(() => agent.releasePermissions?.());
			await release(() => permissionsBridge().instances.get(session.sessionId)?.dispose?.());
		}
		agent.releasePermissions = undefined;
		agent.messaging = undefined;
		await release(() => session?.dispose());
		await release(() => (agent.modelRuntime as { dispose?: () => void } | undefined)?.dispose?.());
		agent.session = undefined;
		agent.modelRuntime = undefined;
		agent.streamingMessage = undefined;
		agent.activeToolNames.clear();
		agent.activity = undefined;
		if (errors.length) throw new AggregateError(errors, `Subagent ${agent.name} runtime cleanup failed`);
	}

	async dismiss(idOrName: string, expectedRevision?: number, origin: "parent" | "user" = "parent") {
		this.assertActive();
		const agent = this.getOpen(idOrName);
		if (!agent) throw new Error(`Unknown subagent: ${idOrName}`);
		this.admitControl(agent, expectedRevision);
		if (origin === "user") this.recordHumanInteraction(agent);
		agent.dormant = true;
		if (this.activeId === agent.id) this.activeId = undefined;
		const retirement = this.retireRuntime(agent, "quit");
		try { this.changed(agent); } finally { await retirement; }
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
		const counts = {
			running: agents.filter((agent) => agent.status === "running" || agent.status === "starting").length,
			idle: agents.filter((agent) => agent.status === "idle").length,
			failed: agents.filter((agent) => agent.status === "failed" || agent.status === "cancelled").length,
		};
		setOwnedStatus(ctx.ui, "subagents", { kind: "subagents", total: agents.length, ...counts });
		ctx.ui.setTitle("pi");
		ctx.ui.setWidget("subagent-active", undefined);
		ctx.ui.setWidget("subagents", undefined);
	}

	/** Presentation order is independent of activity-based tool/name lookup. */
	listForUi() {
		return [...this.agents.values()].filter((agent) => !agent.closedAt).sort((a, b) =>
			(b.lastHumanInteractionAt ?? b.createdAt) - (a.lastHumanInteractionAt ?? a.createdAt)
			|| b.createdAt - a.createdAt || a.id.localeCompare(b.id));
	}

	private recordHumanInteraction(agent: Subagent) {
		// A logical millisecond resolves same-tick inputs (and clock rollback).
		let timestamp = now();
		for (const item of this.agents.values())
			timestamp = Math.max(timestamp, (item.lastHumanInteractionAt ?? item.createdAt) + 1);
		agent.lastHumanInteractionAt = timestamp;
		this.changed(agent);
	}

	listAll() {
		return newestFirst(this.agents.values(), (agent) => agent.updatedAt);
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

	usageTotals(): UsageTotals {
		const totals = emptyUsage();
		for (const agent of this.agents.values()) {
			updateUsage(agent);
			totals.input += agent.usage.input;
			totals.output += agent.usage.output;
			totals.cacheRead += agent.usage.cacheRead;
			totals.cacheWrite += agent.usage.cacheWrite;
			totals.cost += agent.usage.cost;
		}
		return totals;
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

	note(idOrName: string, text: string, kind: "system" | "error" = "system") {
		const agent = this.get(idOrName);
		if (!agent) return;
		// Match InteractiveMode.showStatus(): this is panel UI, not a child
		// transcript/session message and therefore never enters model context.
		agent.uiStatus = { text, kind };
		agent.updatedAt = now();
		this.changed();
	}

	async spawn(
		params: { instructions: string; name?: string; model?: string; thinkingLevel?: ThinkingLevel },
		ctx: ExtensionContext,
		signal?: AbortSignal,
		initialOrigin: "parent" | "user" = "parent",
	) {
		this.assertActive();
		if (Object.hasOwn(params, "permissions")) throw new Error("Subagent-specific permissions are no longer supported. Subagents share the parent's live permissions and environment.");
		this.setContext(ctx);
		const selectedModel = await selectSubagentModel(params, ctx, signal);
		this.assertActive();
		(signal ?? ctx.signal)?.throwIfAborted();

		const id = makeId();
		const agent: Subagent = {
			controlRevision: ++this.controlCounter,
			id,
			name: params.name?.trim() || id,
			instructions: params.instructions,
			initialOrigin,
			model: selectedModel.model,
			thinkingLevel: selectedModel.thinkingLevel,
			status: "starting",
			operations: new Set(),
			createdAt: now(),
			updatedAt: now(),
			transcript: [],
			messages: [],
			streamText: "",
			finalText: "",
			activeToolNames: new Set(),
			queuedSteering: [],
			queuedFollowUp: [],
			usage: emptyUsage(),
		};
		this.agents.set(id, agent);
		if (initialOrigin === "user") this.recordHumanInteraction(agent);
		else this.changed(agent);

		void this.track(agent, this.ensureRuntime(agent, ctx).then(async () => {
			this.assertActive();
			await this.runPrompt(agent, () => agent.initialOrigin === "user" ? agent.messaging!.sendUser(agent.instructions) : agent.messaging!.sendParent(agent.instructions));
		}).catch(async (error) => {
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
		}).finally(() => {
			this.advanceControl(agent);
			agent.interruptRequested = false;
			this.changed(agent);
		}));

		return agent;
	}

	private ensureRuntime(agent: Subagent, ctx: ExtensionContext): Promise<void> {
		this.assertActive();
		if (agent.initialization) return agent.initialization;
		if (agent.session) return Promise.resolve();
		agent.initializationAbort = new AbortController();
		const operation = this.initialize(agent, ctx).catch(async (error) => {
			if (!this.stopping) await this.unloadRuntime(agent);
			throw error;
		}).finally(() => { agent.initialization = undefined; });
		agent.initialization = operation;
		return this.track(agent, operation);
	}

	private async initialize(agent: Subagent, ctx: ExtensionContext) {
		const modelRuntime = await ModelRuntime.create({ signal: agent.initializationAbort!.signal });
		agent.modelRuntime = modelRuntime;
		this.assertActive();
		const loader = new DefaultResourceLoader({
			cwd: sessionHome(),
			agentDir: getAgentDir(),
			// Child sessions get the same sibling extension set as the parent, except
			// this subagents extension itself to avoid recursive subagent control tools.
			noExtensions: true,
			additionalExtensionPaths: [...siblingExtensionEntryPaths(), childExtensionPath],
			systemPromptOverride: () => `${CHILD_SYSTEM_PROMPT}\n\nYour subagent ID is ${agent.id}. In the shared session-system directory, your transcript is published at subagents/${agent.id}.jsonl when available; transcripts/current.jsonl is the parent's transcript.`,
		});
		await loader.reload();
		agent.initializationAbort!.signal.throwIfAborted();
		this.assertActive();
		// Only explicit continuation opens a runtime; restoration itself reads the archive.
		const archive = agent.sessionFile ? this.openArchive(agent, ctx) : undefined;
		const model = agent.model ? ctx.modelRegistry.find(agent.model.provider, agent.model.id) : ctx.model;
		if (!model) throw new Error(`Subagent model is unavailable: ${modelLabel(agent.model)}`);
		const childSessionDir = join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId());
		const { session } = await createAgentSession({
			cwd: sessionHome(),
			agentDir: getAgentDir(),
			model,
			thinkingLevel: agent.thinkingLevel ?? ctx.thinkingLevel,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: archive ?? SessionManager.create(sessionHome(), childSessionDir),
		});
		agent.session = session;
		agent.sessionIdentity = session.sessionId;
		agent.model = session.model;
		agent.thinkingLevel = session.thinkingLevel;
		this.persist(agent);
		agent.initializationAbort!.signal.throwIfAborted();
		this.assertActive();
		agent.messaging = installSubagentMessaging(session, () => {
			this.assertActive();
			if (agent.retirement || agent.interruptRequested || agent.cancelRequested) throw new Error("Subagent was interrupted.");
		});
		childBridge().instances.set(session.sessionId, {
			notify: (message) => this.notifyParent(agent, message),
			connect: (api) => this.connectNativeView(agent, api, ctx),
		});
		// Bind to the parent's live environment before session_start. Keep this
		// relationship through child reload; retirement releases only the alias.
		const parentId = ctx.sessionManager.getSessionId();
		agent.releasePermissions = stageSharedPermissions(session.sessionId, parentId);
		await session.bindExtensions({ mode: ctx.hasUI ? "tui" : "print", uiContext: this.childUiContext(agent, ctx) });
		agent.initializationAbort!.signal.throwIfAborted();
		this.assertActive();

		const bridge = permissionsBridge();
		const parentPermissions = bridge.instances.get(parentId);
		const childPermissions = bridge.instances.get(session.sessionId);
		if (!parentPermissions || !childPermissions || childPermissions.getOwner() !== parentPermissions.getOwner()) {
			throw new Error("Shared permission environment unavailable for parent or child session. Reload the extensions.");
		}

		transitionTaskStatus(agent, "idle");
		this.changed(agent);

		const syncMessages = () => {
			agent.messages = [...session.messages];
			const streaming = session.agent.state.streamingMessage;
			agent.streamingMessage = streaming?.role === "assistant" ? streaming : undefined;
			updateUsage(agent);
			agent.model = session.model;
			agent.thinkingLevel = session.thinkingLevel;
			agent.updatedAt = now();
		};
		let nativeRunActive = false;
		agent.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			syncMessages();
			if (event.type === "agent_start" || event.type === "agent_settled" && nativeRunActive) {
				nativeRunActive = event.type === "agent_start";
				this.advanceControl(agent);
				this.changed(agent);
			}
			if (event.type === "message_start" && (event.message.role === "user" || event.message.role === "assistant")) agent.uiStatus = undefined;
			if (event.type === "message_end" || event.type === "agent_settled" || event.type === "compaction_end") {
				// Pi persists message_end after notifying subscribers. Publish once
				// that write finishes, and refresh fallback copies as messages arrive.
				queueMicrotask(() => {
					if (!this.stopping && this.agents.get(agent.id) === agent) this.publishTranscript(agent);
				});
			}
			if (event.type === "tool_execution_start") agent.activeToolNames.add(event.toolName);
			else if (event.type === "tool_execution_end") agent.activeToolNames.delete(event.toolName);
			const activity = activityLabel(event, [...agent.activeToolNames]);
			if (activity !== undefined || event.type === "agent_end" || event.type === "agent_settled") agent.activity = activity;
			this.emitAgentEvent(agent, event);
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				agent.streamText += event.assistantMessageEvent.delta;
				agent.finalText += event.assistantMessageEvent.delta;
				agent.updatedAt = now();
				this.changed();
			} else if (event.type === "queue_update" && !this.stopping) {
				agent.queuedSteering = [...event.steering];
				agent.queuedFollowUp = [...event.followUp];
				agent.updatedAt = now();
				this.changed(agent);
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
			} else if (event.type === "message_end" && event.message.role === "user") {
				const text = contentText(event.message.content);
				appendTranscript(agent, "user", text, event.message);
				this.changed();
			} else if (event.type === "message_end" && event.message.role === "custom") {
				appendTranscript(agent, "system", contentText(event.message.content));
				this.changed();
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				const text = contentText(event.message.content);
				if (text.trim()) appendTranscript(agent, "assistant", text);
				agent.streamText = "";
				this.changed();
			}
		});

		syncMessages();
	}

	private async runPrompt(agent: Subagent, submit: () => Promise<void>) {
		let superseded = false;
		this.assertActive();
		this.advanceControl(agent);
		agent.interruptRequested = false;
		agent.error = undefined;
		transitionTaskStatus(agent, "running");
		this.changed(agent);
		try {
			await submit();
			const last = agent.session?.messages.findLast((message) => message.role === "assistant");
			if (last?.role === "assistant" && last.stopReason === "error" && !agent.interruptRequested && !this.stopping) {
				throw new Error(last.errorMessage || "Subagent response failed.");
			}
			transitionTaskStatus(agent, "idle");
		} catch (error) {
			if (error instanceof SubagentControlConflict) {
				superseded = true;
				if (!agent.session?.isStreaming) transitionTaskStatus(agent, "idle");
				this.changed(agent);
				return;
			}
			if (this.stopping || agent.interruptRequested) transitionTaskStatus(agent, "idle");
			else {
				transitionTaskStatus(agent, "failed");
				agent.error = error instanceof Error ? error.message : String(error);
				appendTranscript(agent, "error", agent.error);
				this.notifyParent(agent, `Subagent failed: ${agent.error}`);
			}
		} finally {
			// A newer admitted input owns the actor; an old preflight conflict must not invalidate it.
			if (superseded) return;
			this.advanceControl(agent);
			agent.interruptRequested = false;
			agent.activity = undefined;
			agent.activeToolNames.clear();
			this.changed(agent);
		}
	}

	sendModelMessage(idOrName: string, text: string, delivery: Delivery = "auto") {
		return this.deliver(idOrName, text, delivery, "parent");
	}

	/** Trusted human console input is the only path that enables slash commands. */
	submitHumanInput(idOrName: string, text: string, delivery: Delivery = "auto", expectedRevision?: number, assertParent?: () => void, images?: ChildImages) {
		return this.deliver(idOrName, text, delivery, "user", expectedRevision, assertParent, images);
	}

	private deliver(
		idOrName: string,
		text: string,
		delivery: Delivery,
		origin: "parent" | "user",
		expectedRevision?: number,
		assertParent?: () => void,
		images?: ChildImages,
	): Promise<{ agent: Subagent; delivery: Exclude<Delivery, "auto">; reactivated: boolean }> {
		assertParent?.();
		if (remoteUI(this.uiCtx?.ui) && remoteLogin(text)) throw Error(REMOTE_LOGIN_UNSUPPORTED);
		this.assertActive();
		const agent = this.getOpen(idOrName);
		if (!agent) throw new Error(`Unknown or closed subagent: ${idOrName}`);
		// Do not track a waiter as old-runtime work: retirement must not join a
		// delivery which is itself waiting for retirement before reopening.
		this.checkControl(agent, expectedRevision);
		if (agent.retirement)
			return agent.retirement.then(() => this.deliver(idOrName, text, delivery, origin, expectedRevision, assertParent, images));
		const admitted = this.admitControl(agent, expectedRevision);
		if (origin === "user") this.recordHumanInteraction(agent);
		return this.track(
			agent,
			this.deliverTo(agent, text, delivery, origin, expectedRevision === undefined ? undefined : admitted, assertParent, images),
		);
	}

	private async deliverTo(
		agent: Subagent,
		text: string,
		delivery: Delivery,
		origin: "parent" | "user",
		admittedRevision?: number,
		assertParent?: () => void,
		images?: ChildImages,
	) {
		assertParent?.();
		const ctx = this.sessionCtx!;
		try { await this.ensureRuntime(agent, ctx); }
		catch (error) {
			if (admittedRevision !== undefined) this.checkControl(agent, admittedRevision);
			agent.error = error instanceof Error ? error.message : String(error);
			transitionTaskStatus(agent, this.stopping || agent.interruptRequested ? "idle" : "failed");
			this.changed(agent);
			throw error;
		}
		assertParent?.();
		this.checkControl(agent, admittedRevision);
		if (agent.retirement) throw new Error(`Subagent ${agent.name} is being dismissed.`);
		const session = agent.session!;
		const hasDelegation = session.sessionManager.getBranch().some((entry) =>
			entry.type === "custom_message" && entry.customType === SUBAGENT_DELEGATION
			|| entry.type === "message" && messageProvenance(entry.message)?.origin === (agent.initialOrigin ?? "parent")
				&& messageProvenance(entry.message)?.input === agent.instructions);
		if (agent.status !== "running" && !hasDelegation) {
			// An interrupted spawn may never have submitted its delegation. Seed
			// context only on explicit continuation, without starting a separate run.
			await session.sendCustomMessage({ customType: SUBAGENT_DELEGATION, display: true,
				content: `[Subagent message origin=${agent.initialOrigin ?? "parent"}]\n${agent.instructions}`, details: { origin: agent.initialOrigin ?? "parent" } }, { triggerTurn: false });
			this.checkControl(agent, admittedRevision);
			if (agent.retirement) throw new Error(`Subagent ${agent.name} is being dismissed.`);
		}
		let acceptInput: (() => void) | undefined;
		let rejectInput: ((error: unknown) => void) | undefined;
		const acceptance =
			admittedRevision === undefined
				? undefined
				: new Promise<void>((resolve, reject) => {
						acceptInput = resolve;
						rejectInput = reject;
					});
		// Attach a handler immediately: synchronous SDK failures can precede our await.
		void acceptance?.catch(() => {});
		const submit = (value: string, mode?: "steer" | "followUp") => {
			const revision = agent.controlRevision;
			const operation =
				origin === "user"
					? agent.messaging!.sendUser(
							value,
							mode,
							() => { assertParent?.(); if (admittedRevision !== undefined) this.checkControl(agent, revision); },
							acceptInput &&
								(() => {
									if (session.isStreaming) transitionTaskStatus(agent, "running");
									acceptInput?.();
								}),
							images,
						)
					: agent.messaging!.sendParent(value, mode);
			void operation.catch((error) => rejectInput?.(error));
			return operation;
		};
		const wasDormant = Boolean(agent.dormant);
		const active = agent.status === "running";
		const deliveryUsed: Exclude<Delivery, "auto"> = active ? (delivery === "auto" ? "steer" : delivery) : "prompt";
		if (delivery === "prompt" && active) throw new Error(`Subagent ${agent.name} is already running; use delivery=steer or delivery=followUp.`);
		agent.dormant = false;
		this.changed(agent);
		if (active) {
			const operation = submit(text, deliveryUsed === "followUp" ? "followUp" : "steer");
			if (acceptance) {
				// Native streaming may have ended since our status snapshot. Keep joining
				// the full operation for teardown, but acknowledge only actual admission.
				const tracked = this.track(agent, operation);
				void tracked.then(() => {
					if (!session.isStreaming) {
						transitionTaskStatus(agent, "idle");
						this.changed(agent);
					}
				}, () => {});
				await acceptance;
			} else await operation;
		}
		else {
			// Mailbox delivery returns promptly, but shutdown still joins the full run.
			const operation = this.track(
				agent,
				this.runPrompt(agent, () => submit(text)),
			);
			void operation.catch((error) => rejectInput?.(error));
			if (acceptance) await acceptance;
		}
		return { agent, delivery: deliveryUsed, reactivated: wasDormant };
	}

	dequeue(idOrName: string, expectedRevision?: number, origin: "parent" | "user" = "parent") {
		const agent = this.getOpen(idOrName);
		if (!agent) throw new Error(`Unknown subagent: ${idOrName}`);
		this.admitControl(agent, expectedRevision);
		if (origin === "user") this.recordHumanInteraction(agent);
		const native = agent.session?.clearQueue() ?? { steering: agent.queuedSteering, followUp: agent.queuedFollowUp };
		const queued = {
			steering: [...(agent.parkedQueue?.steering ?? []), ...native.steering],
			followUp: [...(agent.parkedQueue?.followUp ?? []), ...native.followUp],
		};
		agent.parkedQueue = undefined;
		agent.queuedSteering = [];
		agent.queuedFollowUp = [];
		this.changed(agent);
		return queued;
	}

	async stop(idOrName: string, expectedRevision?: number, origin: "parent" | "user" = "parent") {
		this.assertActive();
		const agent = this.get(idOrName);
		if (!agent) throw new Error(`Unknown subagent: ${idOrName}`);
		const admitted = this.admitControl(agent, expectedRevision);
		if (origin === "user") this.recordHumanInteraction(agent);
		await agent.retirement;
		this.checkControl(agent, expectedRevision === undefined ? undefined : admitted);
		const queued = this.dequeue(idOrName);
		const abortRevision = agent.controlRevision;
		agent.interruptRequested = true;
		agent.initializationAbort?.abort();
		agent.session?.abortCompaction();
		await agent.session?.abort();
		await Promise.allSettled([...agent.operations]);
		// Completion of an older stop must not overwrite a newer admitted run.
		if (expectedRevision !== undefined && agent.controlRevision !== abortRevision) return queued;
		transitionTaskStatus(agent, "idle");
		agent.interruptRequested = false;
		this.changed(agent);
		return queued;
	}

	dispose(reason: SessionShutdownEvent["reason"]): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		// Fence admissions/notifications synchronously, but publish the shared
		// promise before aborting children or invoking any shutdown callbacks.
		this.stopping = true;
		const unregister = this.unregisterQuiescence;
		this.disposePromise = Promise.resolve().then(() => this.disposeAgents(reason)).finally(() => unregister?.());
		return this.disposePromise;
	}

	private retireRuntime(agent: Subagent, reason: SessionShutdownEvent["reason"]): Promise<void> {
		if (agent.retirement) return agent.retirement;
		this.advanceControl(agent);
		// Capture admitted work before publishing retirement. Later deliveries
		// wait outside this set, so teardown cannot deadlock on a future reopen.
		const operations = [...agent.operations];
		agent.interruptRequested = true;
		agent.initializationAbort?.abort();
		const retirement = Promise.resolve().then(async () => {
			await agent.initialization?.catch(() => {});
			// Retiring closes native dialogs before joining commands that may be
			// awaiting them. Closing a UI panel never enters this teardown path.
			agent.parentUIRoute?.close();
			agent.parentUIRoute = undefined;
			await agent.nativeView?.close();
			agent.nativeView = undefined;
			const session = agent.session;
			const queued = session?.clearQueue() ?? { steering: agent.queuedSteering, followUp: agent.queuedFollowUp };
			// Park cancelled input for explicit recovery, never silently replay it.
			agent.parkedQueue = {
				steering: [...(agent.parkedQueue?.steering ?? []), ...queued.steering],
				followUp: [...(agent.parkedQueue?.followUp ?? []), ...queued.followUp],
			};
			agent.queuedSteering = [];
			agent.queuedFollowUp = [];
			session?.abortCompaction();
			session?.abortBranchSummary();
			session?.abortBash();
			const shutdownExtensions = async () => {
				if (!session) return;
				const errors: Error[] = [];
				const unsubscribe = session.extensionRunner.onError((error) => {
					if (error.event === "session_shutdown") errors.push(new Error(`${error.extensionPath}: ${error.error}`, { cause: error }));
				});
				try { await session.extensionRunner.emit({ type: "session_shutdown", reason }); }
				finally { unsubscribe(); }
				if (errors.length) throw new AggregateError(errors, `Subagent ${agent.name} (${agent.id}) shutdown failed: ${errors.map((error) => error.message).join("; ")}`);
			};
			const joined = await Promise.allSettled([
				session?.abort(), shutdownExtensions(), Promise.allSettled(operations),
			]);
			const failure = joined.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") agent.error = String(failure.reason);
			if (!this.isTerminal(agent)) transitionTaskStatus(agent, failure ? "failed" : "idle");
			await this.unloadRuntime(agent, reason, true);
			if (failure?.status === "rejected") throw failure.reason;
		}).finally(() => {
			this.advanceControl(agent);
			if (agent.retirement === retirement) agent.retirement = undefined;
			agent.interruptRequested = false;
			this.changed(agent);
		});
		agent.retirement = retirement;
		return retirement;
	}

	private async disposeAgents(reason: SessionShutdownEvent["reason"]) {
		const agents = [...this.agents.values()];
		const results = await Promise.allSettled(agents.map((agent) => this.retireRuntime(agent, reason)));
		this.uiCtx = undefined;
		this.activeId = undefined;
		this.agents.clear();
		this.sessionCtx = undefined;
		for (const listener of this.listeners) listener();
		this.listeners.clear();
		this.eventListeners.clear();
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Subagent shutdown failed");
	}
}

function toolResult(text: string, details?: unknown, isError?: boolean) {
	// Pi derives tool failure from a thrown exception, not a returned isError field.
	if (isError) throw new Error(text);
	return { content: [{ type: "text" as const, text }], details };
}

function renderDisplayResult(result: any) {
	const text = result.details?.display ?? result.content?.map((part: any) => part.text ?? "").join("\n") ?? "";
	return { invalidate() {}, render: (width: number) => text.split("\n").map((line: string) => truncateToWidth(line, width)) };
}

function renderLinear(agent: Subagent, maxChars: number) {
	const dormant = agent.dormant ? " dormant" : " active";
	const closed = agent.closedAt ? " closed" : "";
	const lines = [`Subagent ${agent.name} (${agent.id}) [${agent.status}${dormant}${closed}]`, `Delegated instructions (parent): ${agent.instructions}`, ""];
	if (agent.queuedSteering.length || agent.queuedFollowUp.length) {
		for (const text of agent.queuedSteering) lines.push(`queued steer: ${text}`);
		for (const text of agent.queuedFollowUp) lines.push(`queued follow-up: ${text}`);
		lines.push("");
	}
	for (const text of agent.parkedQueue?.steering ?? []) lines.push(`recovered steering input (not queued): ${text}`);
	for (const text of agent.parkedQueue?.followUp ?? []) lines.push(`recovered follow-up input (not queued): ${text}`);
	for (const line of agent.transcript.slice(-80)) lines.push(`${line.kind}: ${line.text}`);
	if (agent.streamText.trim()) lines.push(`assistant: ${agent.streamText}`);
	if (agent.error) lines.push(`error: ${agent.error}`);
	const text = lines.join("\n");
	return text.length > maxChars ? `[truncated to last ${maxChars} chars]\n${text.slice(-maxChars)}` : text;
}



function recoveredInputCount(agent: Subagent): number {
	return (agent.parkedQueue?.steering.length ?? 0) + (agent.parkedQueue?.followUp.length ?? 0);
}

function pendingQueueLabel(agent: Subagent): string {
	const steering = agent.queuedSteering.length;
	const followUp = agent.queuedFollowUp.length;
	const recovered = recoveredInputCount(agent);
	return (steering || followUp ? ` · queued ${steering} steer/${followUp} follow-up` : "")
		+ (recovered ? ` · ${recovered} recovered (not queued)` : "");
}


function toolCallLine(parts: Array<string | undefined>, theme: any) {
	const [name, ...rest] = parts.filter(Boolean) as string[];
	const text = [name, ...rest].filter(Boolean).join(" ");
	const line = theme?.fg && name
		? [theme.fg("toolTitle", theme.bold?.(name) ?? name), rest.length ? theme.fg("toolOutput", rest.join(" ")) : undefined].filter(Boolean).join(" ")
		: text;
	return { invalidate() {}, render: (width: number) => [truncateToWidth(line, width)] };
}

function installTools(pi: ExtensionAPI, manager: SubagentManager) {
	pi.registerTool(defineTool({
		name: "spawn_subagent",
		label: "Spawn Subagent",
		description: "Start a persistent subagent actor with delegated instructions. The subagent can notify the parent only when it is blocked, needs parent attention, or has the requested result. It remains alive and can later be dismissed or messaged again.",
		promptSnippet: "spawn_subagent: start a persistent subagent actor",
		promptGuidelines: [
			"Put all specialization, role, reporting format, and task details in the instructions field.",
			"Subagents share the parent's live permissions, scratch workspace, mounts, and running VMs. No separate permission setup or updates are needed; changes affect the whole session family.",
			PARENT_PROVENANCE_GUIDELINE,
			"If you want a response, give the subagent a task with clear completion criteria and explicitly tell it to call notify_parent with the final result; ordinary child assistant messages are not parent-visible.",
			"After spawning a subagent, continue only with independent parent-side work. If the next step depends on the subagent's result, end your turn; its notify_parent call will add a follow-up message and give you another turn.",
			"Subagents inherit the current model and thinking level by default. Only set model or thinkingLevel when the user explicitly asks for a different model or thinking level.",
			"Subagents are actors, not promises. They notify the parent when they need attention or have a result; dismiss them when you are satisfied. Do not poll them for progress with inspect_subagent.",
		],
		parameters: Type.Object({
			instructions: Type.String({ description: "Complete instructions for the subagent, including specialization/role, task, and desired reporting format." }),
			name: Type.Optional(Type.String({ description: "Short human-readable name." })),
			model: Type.Optional(Type.String({ description: "Only when explicitly requested by the user: model id for this subagent. Omit to inherit the current model." })),
			thinkingLevel: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")], { description: "Only when explicitly requested by the user: thinking level for this subagent. Omit to inherit the current thinking level." })),
		}, { additionalProperties: false }),
		renderCall(params: any, theme: any) {
			return toolCallLine(["spawn_subagent", params?.name], theme);
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			onUpdate?.(toolResult(`Starting subagent${params.name ? ` ${params.name}` : ""}.\n\nInstructions:\n${params.instructions}`));
			const agent = await manager.spawn(params, ctx, signal);
			return toolResult(
				`Spawned subagent ${agent.name} (${agent.id}) with ${modelLabel(agent.model)}${agent.thinkingLevel && agent.thinkingLevel !== "off" ? ` (${agent.thinkingLevel})` : ""}. It will notify you when it needs attention or has a result.`,
				{ id: agent.id, name: agent.name, status: agent.status, dormant: Boolean(agent.dormant), model: modelLabel(agent.model), thinkingLevel: agent.thinkingLevel, display: `Spawned ${agent.name} (${agent.id}) [${agent.status}]\nmodel: ${modelLabel(agent.model)}${agent.thinkingLevel && agent.thinkingLevel !== "off" ? ` (${agent.thinkingLevel})` : ""}\n${agent.instructions}` },
			);
		},
		renderResult: renderDisplayResult,
	}) satisfies ToolDefinition);

	pi.registerTool(defineTool({
		name: "list_subagents",
		label: "List Subagents",
		description: "List active and dormant subagents. Dormant subagents are hidden from the status bar but keep their full session state and can be messaged again.",
		promptSnippet: "list_subagents: list active and dormant subagents",
		promptGuidelines: ["Use list_subagents for occasional orientation only. Do not poll; when a subagent needs attention or has a result, its notify_parent call will add a follow-up message and give you another turn."],
		parameters: Type.Object({
			includeDormant: Type.Optional(Type.Boolean({ description: "Include dormant subagents. Defaults to true." })),
		}),
		renderCall(params: any, theme: any) {
			return toolCallLine(["list_subagents", params?.includeDormant === false ? "active-only" : undefined], theme);
		},
		async execute(_id, params) {
			const agents = manager.list().filter((agent) => (params.includeDormant ?? true) || !agent.dormant);
			const active = agents.filter((agent) => !agent.dormant);
			const dormant = agents.filter((agent) => agent.dormant);
			const running = agents.filter((agent) => agent.status === "starting" || agent.status === "running");
			const failed = agents.filter((agent) => agent.status === "failed" || agent.status === "cancelled");
			const lines = [`Subagents: ${active.length} active${params.includeDormant ?? true ? `, ${dormant.length} dormant` : ""}${running.length ? `, ${running.length} running` : ""}${failed.length ? `, ${failed.length} failed/cancelled` : ""}`, "", "Active subagents:"];
			if (active.length === 0) lines.push("  (none)");
			for (const agent of active) lines.push(`  - ${agent.name} (${agent.id}) [${agent.status}${pendingQueueLabel(agent)}] ${modelLabel(agent.model)} ${short(agent.instructions, 120)}`);
			if (params.includeDormant ?? true) {
				lines.push("", "Dormant subagents:");
				if (dormant.length === 0) lines.push("  (none)");
				for (const agent of dormant) lines.push(`  - ${agent.name} (${agent.id}) [${agent.status}${pendingQueueLabel(agent)}] ${modelLabel(agent.model)} ${short(agent.instructions, 120)}`);
			}
			return toolResult(lines.join("\n"), { agents: agents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status, dormant: Boolean(agent.dormant), model: modelLabel(agent.model), thinkingLevel: agent.thinkingLevel, instructions: agent.instructions, queuedSteering: agent.queuedSteering, queuedFollowUp: agent.queuedFollowUp, recoveredInput: agent.parkedQueue })), display: lines.join("\n") });
		},
		renderResult: renderDisplayResult,
	}) satisfies ToolDefinition);

	pi.registerTool(defineTool({
		name: "inspect_subagent",
		label: "Inspect Subagent",
		description: "Inspect a subagent's transcript/state for debugging or message provenance. Direct user messages appear in its log with origin=user; check them before overriding an apparent change in direction. Never use this as a routine progress check.",
		promptSnippet: "inspect_subagent: inspect transcript/state and user-message provenance on demand",
		promptGuidelines: [
			"Use inspect_subagent for a targeted provenance check, debugging, or when the user explicitly asks. Direct user clarifications are recorded in the child transcript, not automatically posted to the parent.",
			"Before reasserting your delegation over an apparent change in a child's direction, use inspect_subagent to check for origin=user instructions, which take precedence over your delegation.",
			"For normal workflow, end your turn and rely on notify_parent follow-up messages; do not inspect for progress.",
		],
		parameters: Type.Object({ id: Type.String({ description: "Subagent id or name." }) }),
		renderCall(params: any, theme: any) {
			return toolCallLine(["inspect_subagent", params?.id], theme);
		},
		async execute(_id, params) {
			const agent = manager.getAny(params.id);
			if (!agent) return toolResult(`Unknown subagent: ${params.id}`, undefined, true);
			return toolResult(renderLinear(agent, 20_000), { id: agent.id, name: agent.name, status: agent.status, dormant: Boolean(agent.dormant), error: agent.error });
		},
	}) satisfies ToolDefinition);

	pi.registerTool(defineTool({
		name: "dismiss_subagent",
		label: "Dismiss Subagent",
		description: "Stop and unload a subagent while retaining its saved conversation. Shared mounts and VMs stay available to the parent and other children. Message it later to resume it.",
		parameters: Type.Object({ id: Type.String({ description: "Subagent id or name." }) }),
		renderCall(params: any, theme: any) {
			return toolCallLine(["dismiss_subagent", params?.id], theme);
		},
		async execute(_id, params) {
			try {
				const agent = await manager.dismiss(params.id);
				return toolResult(`Dismissed subagent ${agent.name} (${agent.id}); its runtime has been released. Message it later to resume its saved conversation.`, {
					id: agent.id, name: agent.name, status: agent.status, dormant: Boolean(agent.dormant),
				});
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
		renderCall(params: any, theme: any) {
			return toolCallLine(["message_subagent", params?.id, params?.delivery && params.delivery !== "auto" ? params.delivery : undefined], theme);
		},
		async execute(_id, params, _signal, onUpdate) {
			try {
				onUpdate?.(toolResult(`Dispatching message to ${params.id}${params.delivery && params.delivery !== "auto" ? ` (${params.delivery})` : ""}.\n\nMessage:\n${params.message}`));
				const sent = await manager.sendModelMessage(params.id, params.message, params.delivery ?? "auto");
				return toolResult(`Sent message to subagent ${sent.agent.name} (${sent.agent.id}) using ${sent.delivery}${sent.reactivated ? "; reactivated from dormant" : ""}. Status: ${sent.agent.status}. Model: ${modelLabel(sent.agent.model)}.\n\nMessage: ${params.message}`, {
					id: sent.agent.id, name: sent.agent.name, delivery: sent.delivery,
					reactivated: sent.reactivated, status: sent.agent.status, message: params.message,
				});
			} catch (error) { return toolResult(error instanceof Error ? error.message : String(error), undefined, true); }
		},
	}) satisfies ToolDefinition);
}


function childSummary(agent: Subagent): ChildSummary {
	return {
		lastHumanInteractionAt: agent.lastHumanInteractionAt,
		recoveredInputCount: recoveredInputCount(agent),
		activity: agent.activity,
		uiStatus: agent.uiStatus,
		queued: { steering: [...agent.queuedSteering], followUp: [...agent.queuedFollowUp] },
		controlRevision: agent.controlRevision,
		nativeIdentity: agent.nativeViewIdentity ?? agent.session?.sessionId ?? agent.sessionIdentity,
		sourceFile: agent.session?.sessionFile ?? agent.sessionFile,
		id: agent.id,
		name: agent.name,
		status: agent.status,
		dormant: !!agent.dormant,
		createdAt: agent.createdAt,
		updatedAt: agent.updatedAt,
		model: agent.model ? { provider: agent.model.provider, id: agent.model.id } : undefined,
		thinkingLevel: agent.thinkingLevel,
		error: agent.error,
	};
}

export default function extension(pi: ExtensionAPI) {
	const idleStatusBridge = () => bridge;
	const bridge = bindIdleStatus(pi.events);
	let withdrawPort: (() => void) | undefined;
	const manager = new SubagentManager();
	let modes: ReturnType<typeof installClientModeHooks> | undefined;
	let panelUnavailable: string | undefined;
	try { modes = installClientModeHooks(); }
	catch (error) {
		panelUnavailable = String(error);
		pi.on("session_start", (_event, ctx) => { ctx.ui.notify(`Subagent panel unavailable: ${panelUnavailable}`, "warning"); });
	}
	let panelPort: SubagentPort | undefined;
	let localPanel: LocalPanelHost | undefined;
	let viewedAgent: Subagent | undefined;
	const runtimeIds = new WeakMap<AgentSession, string>();
	const rendererIds = new WeakMap<ExtensionAPI, string>();
	const summary = (agent: Subagent): ChildSummary => {
		if (agent.session && !runtimeIds.has(agent.session)) runtimeIds.set(agent.session, randomUUID());
		if (agent.nativeAPI && !rendererIds.has(agent.nativeAPI))
			rendererIds.set(agent.nativeAPI, randomUUID());
		return {
			...childSummary(agent),
			nativeIdentity: agent.session
				? `${runtimeIds.get(agent.session)}:${agent.nativeAPI ? rendererIds.get(agent.nativeAPI) : ""}`
				: agent.sessionIdentity,
		};
	};
	const localView = (id: string): PanelChildView => {
		const agent = manager.listAll().find((agent) => agent.id === id);
		if (!agent) throw Error("Subagent unavailable");
		viewedAgent = agent;
		const view = panelPort!.view(id);
		const toolExecutions: ToolExecution[] = [];
		for (const toolCallId of agent.session?.agent.state.pendingToolCalls ?? []) {
			const entry = agent.transcript.findLast(
				(item) => item.kind === "tool" && item.toolCallId === toolCallId,
			);
			if (!entry?.toolName) continue;
			const execution: ToolExecution = {
				start: {
					type: "tool_execution_start",
					toolCallId,
					toolName: entry.toolName,
					args: entry.args,
				},
			};
			if (entry.result) {
				const result = entry.result as NonNullable<ToolExecution["update"]>["partialResult"];
				if (entry.resultPartial)
					execution.update = {
						type: "tool_execution_update",
						toolCallId,
						toolName: entry.toolName,
						args: entry.args,
						partialResult: result,
					};
				else
					execution.end = {
						type: "tool_execution_end",
						toolCallId,
						toolName: entry.toolName,
						result,
						isError: entry.result.isError,
					};
			}
			toolExecutions.push(execution);
		}
		return {
			...view,
			child: summary(agent),
			presentation: {
				partial: agent.session?.state.streamingMessage,
				toolExecutions,
				retryAttempt: agent.session?.retryAttempt ?? 0,
				commands: manager.autocompleteCommands(id),
			},
		};
	};
	manager.setApi(pi);
	idleStatusBridge().subagentsActiveCount = () => manager.activeCount();
	idleStatusBridge().subagentsUsage = () => manager.usageTotals();
	installTools(pi, manager);

	function ensureActiveTools() {
		const active = new Set(pi.getActiveTools());
		active.add("spawn_subagent");
		active.add("list_subagents");
		active.add("inspect_subagent");
		active.add("message_subagent");
		active.add("dismiss_subagent");
		pi.setActiveTools([...active]);
	}

	pi.on("session_start", (_event, ctx) => {
		manager.restore(ctx);
		withdrawPort?.();
		let live = true;
		const subscriptions = new Set<() => void>();
		const check = () => {
			if (!live || !manager.isAccepting()) throw new Error("Subagent service retired.");
		};
		const revision = (value: number) => {
			check();
			if (!Number.isSafeInteger(value) || value < 0) throw new Error("A valid subagent control revision is required.");
		};
		const port: SubagentPort = {
			async completeCommand(id, expectedRevision, identity, name, prefix) {
				if (!live || !manager.isAccepting() || typeof name !== "string" || name.length > 256 ||
					typeof prefix !== "string" || prefix.length > 4096) return null;
				const agent = manager.getAny(id), session = agent?.session;
				if (!agent || !session || agent.retirement) return null;
				const runner = session.extensionRunner, api = agent.nativeAPI;
				const current = () => live && manager.isAccepting() && agent.session === session &&
					!agent.retirement && session.extensionRunner === runner && agent.nativeAPI === api &&
					agent.controlRevision === expectedRevision &&
					(identity === summary(agent).nativeIdentity || identity === childSummary(agent).nativeIdentity);
				if (!current()) return null;
				const command = runner.getRegisteredCommands().find((command) => command.invocationName === name);
				if (!command?.getArgumentCompletions) return null;
				try {
					const result = await command.getArgumentCompletions(prefix);
					return current() ? result : null;
				} catch { return null; }
			},
			view: (id) => { check(); return manager.view(id); },
			viewControl: (id, expectedRevision, identity, method, params, assertParent) => {
				revision(expectedRevision);
				return manager.viewControl(id, expectedRevision, identity, method, params, assertParent);
			},
			subscribeFrames: (listener) => {
				check();
				const off = manager.subscribeFrames(listener);
				subscriptions.add(off);
				return () => { subscriptions.delete(off); off(); };
			},
			list: () => {
				check();
				return manager.listAll().map(childSummary);
			},
			inspect: (id, options) => {
				check();
				return manager.inspectNative(id, options);
			},
			spawnHuman: async (params, signal) => {
				check();
				const { text, ...rest } = params;
				return childSummary(await manager.spawn({ ...rest, instructions: text }, ctx, signal, "user"));
			},
			submitHuman: async (id, text, expectedRevision, delivery, assertParent, images) => {
				revision(expectedRevision);
				const result = await manager.submitHumanInput(id, text, delivery, expectedRevision, assertParent, images);
				return { child: childSummary(result.agent), delivery: result.delivery, reactivated: result.reactivated };
			},
			stop: (id, expectedRevision) => {
				revision(expectedRevision);
				return manager.stop(id, expectedRevision, "user");
			},
			dismiss: async (id, expectedRevision) => {
				revision(expectedRevision);
				return childSummary(await manager.dismiss(id, expectedRevision, "user"));
			},
			dequeue: (id, expectedRevision) => {
				revision(expectedRevision);
				return manager.dequeue(id, expectedRevision, "user");
			},
			subscribe: (listener) => {
				check();
				const off = manager.subscribe(() => {
					try {
						listener();
					} catch {}
				});
				subscriptions.add(off);
				return () => {
					subscriptions.delete(off);
					off();
				};
			},
			subscribeEvents: (listener) => {
				check();
				const off = manager.subscribeEvents((agent, event) => {
					try {
						listener(structuredClone({ childId: agent.id, event }));
					} catch {}
				});
				subscriptions.add(off);
				return () => {
					subscriptions.delete(off);
					off();
				};
			},
		};
		panelPort = port;
  const withdraw = publishService(pi.events, {
			version: 1,
			kind: "subagents",
			sessionId: ctx.sessionManager.getSessionId(),
			generation: randomUUID(),
			port,
		});
		withdrawPort = () => {
   localPanel?.close(); localPanel = undefined; panelPort = undefined;
			live = false;
			for (const off of subscriptions) off();
			subscriptions.clear();
			withdraw();
		};
		manager.registerQuiescence(ctx.sessionManager.getSessionId(), withdrawPort);
		idleStatusBridge().subagentsActiveCount = () => manager.activeCount();
		idleStatusBridge().subagentsUsage = () => manager.usageTotals();
		ensureActiveTools();
	});
	pi.on("session_shutdown", async (event) => {
		withdrawPort?.();
		withdrawPort = undefined;
		try { await manager.dispose(event.reason); }
		finally {
			delete idleStatusBridge().subagentsActiveCount;
			delete idleStatusBridge().subagentsUsage;
		}
	});

	pi.registerCommand("subagents", {
		description: "Open a live subagent watcher. Select a subagent and send messages directly to it.",
		handler: async (_args, ctx) => {
			manager.setContext(ctx);
			ensureActiveTools();
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/subagents requires the TUI", "warning");
				return;
			}
			const remote = remoteUI(ctx.ui);
			if (remote) {
				await remote.present({ kind: "subagents" });
				return;
			}
			try {
				if (panelUnavailable) throw Error(panelUnavailable);
				const { createSubagentsPanel } = await import("./panel.ts");
				const { LocalPanelHost, localPanelState } = await import("./local-panel-host.ts");
				await ctx.ui.custom<void>(
					async (tui, theme, keybindings, done) => {
						const mode = modes?.modes.get(ctx.sessionManager) as unknown as
							| {
									settingsManager: import("@earendil-works/pi-coding-agent").SettingsManager;
									session: AgentSession;
							  }
							| undefined;
						if (!mode || !panelPort) throw Error("Native subagent frontend context unavailable");
						localPanel ??= new LocalPanelHost(
							ctx.sessionManager.getSessionId(),
							panelPort,
							localPanelState(tui),
							localView,
							() => manager.listAll().map(summary),
							(id) => manager.listAll().find((agent) => agent.id === id)?.session?.retryAttempt ?? 0,
						);
						const runner = () => viewedAgent?.session?.extensionRunner ?? mode.session.extensionRunner;
						const panel = await createSubagentsPanel(
							localPanel,
							ctx.ui,
							{
								settings: mode.settingsManager,
								toolRenderer: (name) => {
									const definition = (viewedAgent?.session ?? mode.session).getToolDefinition(name);
									return definition
										? {
												renderCall: definition.renderCall,
												renderResult: definition.renderResult,
												renderShell: definition.renderShell,
											}
										: undefined;
								},
								messageRenderer: (name) => runner().getMessageRenderer(name),
								entryRenderer: (name) => runner().getEntryRenderer(name),
								markdownTransformers: () => runner().getMarkdownTransformers(),
							},
							undefined,
							undefined,
							mode.settingsManager.getHideThinkingBlock(),
						);
						return panel(tui, theme, keybindings, () => done());
					},
					{
						overlay: true,
						overlayOptions: { width: "86%", maxHeight: "72%", anchor: "center" },
					},
				);
			} catch (error) {
				ctx.ui.notify(`Subagent panel unavailable: ${String(error)}. Main editor remains available.`, "warning");
			}
		},
	});

}
