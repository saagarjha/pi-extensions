import { AgentSession, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// Pi 0.86 has no continuation method on ExtensionCommandContext. Associate
// command contexts with their live session when binding or accessing its runner.
const BRIDGE_KEY = Symbol.for("pi.extensions.manual-retry.sessions");
type SessionMap = WeakMap<ExtensionCommandContext["sessionManager"], AgentSession>;
type Bindings = Parameters<AgentSession["bindExtensions"]>[0];
type BindingHook = (session: AgentSession, bindings: Bindings) => Bindings | void | Promise<Bindings | void>;
const HOOKS_KEY = Symbol.for("pi.extensions.session-bindings.hooks");
const BOUND_KEY = Symbol.for("pi.extensions.session-bindings.bound-hooks");
type BoundHook = (session: AgentSession) => void | Promise<void>;
function boundHooks(): Set<BoundHook> {
	const globals = globalThis as typeof globalThis & { [BOUND_KEY]?: Set<BoundHook> };
	return globals[BOUND_KEY] ??= new Set();
}
export function registerSessionBoundHook(hook: BoundHook): () => void {
	installSessionBridge();
	boundHooks().add(hook);
	return () => boundHooks().delete(hook);
}
function bindingHooks(): Set<BindingHook> {
	const globals = globalThis as typeof globalThis & { [HOOKS_KEY]?: Set<BindingHook> };
	return globals[HOOKS_KEY] ??= new Set();
}
/** Optional extension-owned presentation binding; reuses the existing session capture. */
export function registerSessionBindingHook(hook: BindingHook): () => void {
	installSessionBridge();
	bindingHooks().add(hook);
	return () => bindingHooks().delete(hook);
}

export function installSessionBridge(): SessionMap {
	const globals = globalThis as typeof globalThis & { [BRIDGE_KEY]?: SessionMap };
	if (globals[BRIDGE_KEY]) return globals[BRIDGE_KEY];
	const sessions: SessionMap = new WeakMap();
	// Remove the previous implementation's permanent prompt trampoline on reload.
	const legacyKey = Symbol.for("pi.extensions.manual-retry.patch");
	const legacyGlobals = globalThis as typeof globalThis & {
		[legacyKey]?: { wrapper: AgentSession["prompt"]; originalPrompt: AgentSession["prompt"] };
	};
	const legacy = legacyGlobals[legacyKey];
	if (legacy && AgentSession.prototype.prompt === legacy.wrapper) {
		AgentSession.prototype.prompt = legacy.originalPrompt;
		delete legacyGlobals[legacyKey];
	}
	// TUI dispatch gets the runner directly (without prompt). This also captures
	// an already-bound session when installing this bridge for the first time
	// through /reload, which does not call bindExtensions again.
	const runner = Object.getOwnPropertyDescriptor(AgentSession.prototype, "extensionRunner")!;
	Object.defineProperty(AgentSession.prototype, "extensionRunner", {
		...runner,
		get(this: AgentSession) {
			sessions.set(this.sessionManager, this);
			return runner.get!.call(this);
		},
	});
	const bindExtensions = AgentSession.prototype.bindExtensions;
	AgentSession.prototype.bindExtensions = async function (bindings) {
		sessions.set(this.sessionManager, this);
		for (const hook of [...bindingHooks()]) bindings = await hook(this, bindings) ?? bindings;
		const result = await bindExtensions.call(this, bindings);
		for (const hook of [...boundHooks()]) await hook(this);
		return result;
	};
	globals[BRIDGE_KEY] = sessions;
	return sessions;
}

export async function continueSession(session: AgentSession): Promise<void> {
	if (!session.isIdle || session.isCompacting || session.agent.state.isStreaming) {
		throw new Error("Pi is still running or compacting. Cancel it or wait for it to finish, then /retry.");
	}

	const original = session.agent.state.messages;
	// Remove all consecutive failed attempts, not just the most recent one.
	// Stop at tool results: replaying their tool-calling turn could repeat edits.
	const stripFailedTail = (messages: typeof original) => {
		let end = messages.length;
		while (end > 0) {
			const message = messages[end - 1];
			if (message?.role !== "assistant"
				|| (message.stopReason !== "error" && message.stopReason !== "aborted")) break;
			end--;
		}
		return end < messages.length ? messages.slice(0, end) : messages;
	};
	const continuation = stripFailedTail(original);
	const failedAssistant = continuation !== original;
	const tail = continuation.at(-1);
	if (!tail || continuation.every(message => message.role === "system")) {
		throw new Error("There is no conversation to retry.");
	}
	if (tail.role === "assistant") {
		throw new Error("The last response completed. Send a new instruction instead of /retry.");
	}

	// Current-SDK private bridge: an empty message list starts the normal session
	// run without injecting a user message. Pi owns abort, auto-retry, compaction,
	// queue draining and agent_settled; do not duplicate that lifecycle here.
	const internal = session as unknown as { _runAgentPrompt(messages: []): Promise<void> };
	if (typeof internal._runAgentPrompt !== "function") {
		throw new Error("This Pi build does not expose the session run entry point required by /retry.");
	}
	if (!session.model) throw new Error("Select a model before using /retry.");
	// The agent can append to this array in place while starting a run.
	const beforeRun = continuation.slice();
	if (failedAssistant) session.agent.state.messages = continuation;
	// Compaction rebuilds state from persisted entries, resurrecting failures
	// removed above. Clean that tail again before the SDK calls agent.continue().
	const unsubscribe = session.subscribe(event => {
		if (event.type === "compaction_end" && !event.aborted && event.willRetry) {
			session.agent.state.messages = stripFailedTail(session.agent.state.messages);
		}
	});
	try {
		await internal._runAgentPrompt([]);
	} catch (error) {
		// Restore the failed attempt if startup failed before any new messages.
		const current = session.agent.state.messages;
		if (failedAssistant && current.length === beforeRun.length
			&& current.every((message, index) => message === beforeRun[index])) {
			session.agent.state.messages = original;
		}
		throw error;
	} finally {
		unsubscribe();
	}
}

