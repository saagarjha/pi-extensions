import type {
	AgentSessionEvent,
	SettingsManager,
	MessageRenderer,
	EntryRenderer,
	MarkdownTransformer,
	AgentSession,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ChildSummary, ChildView } from "../shared/control-plane.ts";
import type { ToolRenderers } from "../shared/tool-renderers.ts";
import type { ClientFrame, ToolExecution } from "../remote/protocol.ts";
import type { SubagentSubmission } from "../remote/subagent-submission.ts";

export interface SubagentsPanelState {
	requestId: string;
	sessionId: string;
	draft: string;
	selected?: string;
	toolsExpanded: boolean;
	hideThinking: boolean;
}
export interface PanelClientState {
	subagentsPanelState?: SubagentsPanelState;
	subagentSubmission?: SubagentSubmission;
	subagentQueueRecovery?: SubagentSubmission;
}
export type PanelFrame =
	| ClientFrame
	| { type: "panelChanged" | "panelRetired"; sessionId: string }
	| {
			type: "panelEvent";
			observationSeq: number;
			sessionId: string;
			childId: string;
			event: AgentSessionEvent;
			retryAttempt: number;
	  }
	| {
			type: "panelEntries";
			observationSeq: number;
			sessionId: string;
			childId: string;
			childSessionId?: string;
			nativeIdentity?: string;
			entries: SessionEntry[];
			leafId: string | null;
			reset?: boolean;
	  };
export type PanelChildView = ChildView & {
	/** Direct observation of existing native state, not a synthetic durable history. */
	presentation?: {
		observationSeq?: number;
		partial?: AgentSession["state"]["streamingMessage"];
		toolExecutions: ToolExecution[];
		retryAttempt: number;
		commands?: { name: string; description?: string; invocationName?: string; argumentCompletions?: boolean }[];
	};
};
/** The finite subagent data/action surface shared by direct and attached clients.
 * No execution runtime, component factory registry, or renderer protocol. */
export interface SubagentsPanelHost extends PanelClientState {
	readonly sessionId: string;
	readonly serverIdentity: string;
	readonly controlGeneration: number;
	readonly connected: boolean;
	readonly isController: boolean;
	readonly current: {
		services: { subagents?: { serviceGeneration: string; children: ChildSummary[] } | null };
	};
	customRequest<T>(
		method: "serviceRead" | "serviceMutate",
		params: Record<string, unknown>,
	): Promise<T>;
	subscribeFrames(listener: (frame: PanelFrame) => void): () => void;
}
export interface PanelRenderers {
	settings: SettingsManager;
	toolRenderer(name: string): ToolRenderers | undefined;
	messageRenderer(name: string): MessageRenderer | undefined;
	entryRenderer(name: string): EntryRenderer | undefined;
	markdownTransformers(): MarkdownTransformer[];
}
