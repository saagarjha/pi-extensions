import { AgentSession, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const RETRY_COMMAND = /^\/retry *$/;
const PATCH_KEY = Symbol.for("pi.extensions.manual-retry.patch");

type Prompt = AgentSession["prompt"];
type PromptOptions = Parameters<Prompt>[1];
type InternalSession = {
	_isAgentRunActive: boolean;
	_lastAssistantMessage?: unknown;
	_retryAttempt: number;
	_overflowRecoveryAttempted: boolean;
	_systemPromptOverride?: string;
	_handlePostAgentRun(): Promise<boolean>;
	_flushPendingBashMessages(): void;
	_flushPendingCustomMessages(): void;
	_emitAgentSettled(): Promise<void>;
};

type RetryPatch = {
	originalPrompt: Prompt;
	retry(session: AgentSession, onAccepted?: () => void): Promise<void>;
	commandHandler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	handlePrompt(session: AgentSession, text: string, options?: PromptOptions): Promise<void>;
	wrapper: Prompt;
};

function globalPatch(): RetryPatch | undefined {
	return (globalThis as any)[PATCH_KEY] as RetryPatch | undefined;
}

function setGlobalPatch(patch: RetryPatch): void {
	(globalThis as any)[PATCH_KEY] = patch;
}

function retryBase(session: AgentSession): { original: any[]; continuation: any[] } {
	const original = session.agent.state.messages as any[];
	const last = original.at(-1);
	if (!last || last.role !== "assistant") {
		throw new Error("Nothing to retry: the conversation does not end with an assistant response.");
	}
	if (last.stopReason !== "error" && last.stopReason !== "aborted") {
		throw new Error("Nothing to retry: the last assistant response did not fail or abort.");
	}
	const continuation = original.slice(0, -1);
	const tail = continuation.at(-1);
	if (!tail || tail.role === "assistant") {
		throw new Error("Nothing to retry: there is no valid pre-response conversation state.");
	}
	return { original, continuation };
}

/**
 * Manual counterpart to AgentSession's private automatic-retry continuation.
 * It deliberately mirrors _runAgentPrompt(), but starts with agent.continue()
 * after dropping the failed terminal assistant message from live model state.
 * The failed attempt stays in SessionManager history, matching automatic retry.
 */
async function retryWithoutConversationChange(session: AgentSession, onAccepted?: () => void): Promise<void> {
	if (!session.isIdle || session.isCompacting || session.agent.state.isStreaming) {
		throw new Error("Cannot retry while Pi is already running or compacting.");
	}

	const internal = session as unknown as InternalSession;
	for (const method of ["_handlePostAgentRun", "_flushPendingBashMessages", "_flushPendingCustomMessages", "_emitAgentSettled"] as const) {
		if (typeof internal[method] !== "function") {
			throw new Error(`Manual retry is incompatible with this Pi version (missing ${method}).`);
		}
	}
	if (typeof internal._isAgentRunActive !== "boolean" || typeof internal._retryAttempt !== "number" || typeof internal._overflowRecoveryAttempted !== "boolean") {
		throw new Error("Manual retry is incompatible with this Pi version (session lifecycle fields changed).");
	}

	const { original, continuation } = retryBase(session);
	onAccepted?.();
	// This is the same live-state rewrite used by AgentSession._prepareRetry().
	// Session history remains append-only and retains the failed attempt.
	session.agent.state.messages = continuation;
	internal._lastAssistantMessage = undefined;
	internal._retryAttempt = 0;
	internal._overflowRecoveryAttempted = false;
	internal._isAgentRunActive = true;

	try {
		try {
			await session.agent.continue();
		} catch (error) {
			// A synchronous/pre-stream continuation failure must not destroy the
			// only retryable response in live state.
			if (session.agent.state.messages.length === continuation.length
				&& session.agent.state.messages.every((message, index) => message === continuation[index])) {
				session.agent.state.messages = original;
			}
			throw error;
		}
		while (await internal._handlePostAgentRun()) await session.agent.continue();
	} finally {
		internal._systemPromptOverride = undefined;
		internal._flushPendingBashMessages();
		internal._flushPendingCustomMessages();
		await internal._emitAgentSettled();
	}
}

function dispatchPrompt(patch: RetryPatch, session: AgentSession, text: string, options?: PromptOptions): Promise<void> {
	const command = (session as any)._extensionRunner?.getCommand?.("retry");
	const retryIsOurs = command?.handler === patch.commandHandler;
	const commandsEnabled = options?.expandPromptTemplates ?? true;
	if (typeof text !== "string" || !RETRY_COMMAND.test(text) || !commandsEnabled || !retryIsOurs) {
		return patch.originalPrompt.call(session, text, options);
	}
	let accepted = false;
	return patch.retry(session, () => {
		accepted = true;
		options?.preflightResult?.(true);
	}).catch((error) => {
		if (!accepted) options?.preflightResult?.(false);
		throw error;
	});
}

function createPromptTrampoline(patch: RetryPatch): Prompt {
	return async function (this: AgentSession, text, options) {
		return patch.handlePrompt(this, text, options);
	};
}

function installPromptPatch(commandHandler: RetryPatch["commandHandler"]): void {
	const existing = globalPatch();
	if (existing) {
		// The permanent wrapper delegates through this mutable slot, so all logic
		// (not only retry execution) updates on hot reload.
		existing.retry = retryWithoutConversationChange;
		existing.commandHandler = commandHandler;
		existing.handlePrompt = (session, text, options) => dispatchPrompt(existing, session, text, options);
		return;
	}

	const patch = {
		originalPrompt: AgentSession.prototype.prompt,
		retry: retryWithoutConversationChange,
		commandHandler,
		handlePrompt: undefined as unknown as RetryPatch["handlePrompt"],
		wrapper: undefined as unknown as Prompt,
	} satisfies RetryPatch;
	patch.handlePrompt = (session, text, options) => dispatchPrompt(patch, session, text, options);
	patch.wrapper = createPromptTrampoline(patch);
	setGlobalPatch(patch);
	AgentSession.prototype.prompt = patch.wrapper;
}

export default function extension(pi: ExtensionAPI) {
	const commandHandler = async (_args: string, _ctx: ExtensionCommandContext) => {};

	// Registration adds /retry to normal command discovery and autocomplete.
	// AgentSession.prompt's wrapper consumes it before command dispatch so the
	// command itself never becomes a conversation message.
	pi.registerCommand("retry", {
		description: "Retry the failed or aborted assistant response without adding a user message",
		handler: commandHandler,
	});
	installPromptPatch(commandHandler);
}
