import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionAPI,
	SessionEntry,
	SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { createOwnerServices } from "./owner-services.ts";

export interface ControlState {
	controllerClientId: string | null;
	controlGeneration: number;
}

export interface UIAction {
	method: string;
	args: unknown[];
}

export interface InteractionRequest {
	id: string;
	kind: "confirm" | "input" | "select" | "editor" | "subagents" | "background";
	args: unknown[];
	options?: Record<string, unknown>;
}

export interface OperationResult {
	operationId: string;
	command?: string;
	status?: "running" | "completed" | "failed";
	value?: unknown;
	error?: string;
}

export interface ToolExecution {
	start: Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
	update?: Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
	end?: Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
}

export interface LiveState {
	sessionName: string | undefined;
	leafId: string | null;
	streaming: boolean;
	idle: boolean;
	compacting: boolean;
	/** Same activity sources as the native TUI; null means an invalid/unavailable reading. */
	asyncWork: { background: number | null; subagents: number | null; goal: number | null };
	thinking: AgentSession["thinkingLevel"];
	model: AgentSession["model"];
	scopedModels: AgentSession["scopedModels"];
	modelSettings: { enabledModels?: string[]; defaultProvider?: string; defaultModel?: string };
	steering: ReturnType<AgentSession["getSteeringMessages"]>;
	followUp: ReturnType<AgentSession["getFollowUpMessages"]>;
	partial: AgentSession["state"]["streamingMessage"] | null;
	pendingTools: string[];
	toolExecutions: ToolExecution[];
	retryAttempt: number;
	contextUsage: ReturnType<AgentSession["getContextUsage"]>;
	stats: ReturnType<AgentSession["getSessionStats"]>;
	thinkingLevels: ReturnType<AgentSession["getAvailableThinkingLevels"]>;
	activeTools: string[];
	catalog: ReturnType<AgentSession["modelRuntime"]["getAvailableSnapshot"]>;
	tools: ReturnType<AgentSession["getAllTools"]>;
	commands: (ReturnType<ExtensionAPI["getCommands"]>[number] & { invocationName?: string; argumentCompletions?: boolean })[];
	subscriptionProviders?: string[];
	catalogError?: string;
	bashRunning?: boolean;
	extensions: { path: string; resolvedPath: string }[];
	extensionErrors: unknown[];
	services: ReturnType<ReturnType<typeof createOwnerServices>["snapshot"]>;
	ownerRuntime: {
		kind: string;
		pid: number;
		theme: { name?: string; sourcePath?: string };
		stdio: string;
	};
	unsupportedUI: string[];
	systemPrompt: string;
	autoCompactionEnabled: boolean;
	cacheWarmingStatus: AgentSession["cacheWarmingStatus"];
	steeringMode: AgentSession["steeringMode"];
	followUpMode: AgentSession["followUpMode"];
}

/** Acknowledges the canonical snapshot frame; never carries a second history. */
export interface AttachAck {
	sessionId: string;
	seq: number;
}

export interface Snapshot {
	type: "snapshot";
	sessionId: string;
	seq: number;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	live: LiveState;
	uiState: UIAction[];
	pendingRequests: InteractionRequest[];
	operations: OperationResult[];
	control: ControlState;
	sessionFile: string | undefined;
	cwd: string;
}

/** Auxiliary metadata: never participates in the attached canonical seq cursor. */
export interface SessionActivity {
	sessionId: string;
	ownerIncarnation: string;
	revision: number;
	working: boolean | null;
	messageCount: number;
	/** New user/assistant message entries only; scoped to this owner incarnation. */
	contentRevision: number;
	removed?: true;
}
export interface SessionActivitySubscription {
	subscriptionId: string;
	activities: SessionActivity[];
}
export interface SessionActivityEvent {
	type: "sessionActivity";
	subscriptionId: string;
	activity: SessionActivity;
	/** First observation of a newly running owner, not unread historical content. */
	baseline?: true;
}

export interface SessionDescription {
	/** Other attached clients, excluding the requesting identity. */
	attachedClientCount?: number;
	agentDir?: string;
	fileIdentity?: string;
	parentSessionPath?: string;
	created?: string;
	modified?: string;
	messageCount?: number;
	firstMessage?: string;
	allMessagesText?: string;
	id: string;
	sessionId: string;
	sessionFile?: string;
	header: SessionHeader | null;
	leafId: string | null;
	name?: string;
	cwd: string;
	streaming: boolean;
	pendingRequests: number;
	control: ControlState;
}

type Sequenced = { sessionId: string; seq: number };
export type ServerFrame =
	| Snapshot
	| (Sequenced &
			(
				| { type: "append"; entry: SessionEntry }
				| { type: "leaf"; leafId: string | null }
				| { type: "live"; live: LiveState }
				| { type: "control"; control: ControlState }
				| { type: "interaction"; request: InteractionRequest }
				| { type: "interactionResolved"; requestId: string }
				| { type: "operation"; operation: OperationResult }
				| { type: "event"; event: AgentSessionEvent }
				| { type: "ui"; method: string; args: unknown[] }
				| { type: "presentationChanged"; requestId: string }
				| {
						type: "childFrame";
						event: import("../shared/control-plane.ts").ChildFrame & { serviceGeneration: string };
				  }
				| { type: "childEvent"; event: unknown }
				| { type: "backgroundEvent"; event: { serviceGeneration: string; job: import("../shared/control-plane.ts").BackgroundTaskDetail } }
			));
export type ClientFrame = ServerFrame | { type: "disconnect" };
export interface Reply {
	code?: string;
	attachedClientCount?: number;
	replyTo: number;
	result?: unknown;
	error?: string;
}
export interface AcceptedOperation {
	accepted: true;
	operationId: string;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
