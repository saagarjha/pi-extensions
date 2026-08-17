import type { SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

type QuiesceSubagents = (reason: SessionShutdownEvent["reason"]) => Promise<void>;

function callbacks(): Map<string, QuiesceSubagents> {
	// Shared across isolated extension loaders, keyed only by the owning parent's
	// native session ID. Child sessions do not register a subagent manager.
	const global = globalThis as typeof globalThis & { __piSubagentQuiescers?: Map<string, QuiesceSubagents> };
	return global.__piSubagentQuiescers ??= new Map();
}

export function registerSubagentQuiescer(sessionId: string, quiesce: QuiesceSubagents): () => void {
	const registered = callbacks();
	const callback: QuiesceSubagents = (reason) => quiesce(reason);
	registered.set(sessionId, callback);
	return () => {
		// A completed old shutdown must not unregister a replacement manager.
		if (registered.get(sessionId) === callback) registered.delete(sessionId);
	};
}

export function quiesceSubagents(sessionId: string, reason: SessionShutdownEvent["reason"]): Promise<void> {
	return callbacks().get(sessionId)?.(reason) ?? Promise.resolve();
}
