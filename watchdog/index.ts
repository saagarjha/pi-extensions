import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { continueSession, installSessionBridge } from "../shared/session-continuation.ts";
import { estimatedThinkingTokens } from "../shared/thinking-progress.ts";

const INACTIVITY_MS = 300_000;
const MAX_RETRIES = 3;

// The extension events cannot identify the start of a provider wait: assistant
// message_start arrives only with the first stream event, and turn_start also
// spans context hooks/compaction. Wrap the current SDK's public streamFunction
// instead, and observe its raw iterator before a completed response can run tools.
function watch(session: AgentSession, ctx: ExtensionContext): () => void {
	const agent = session.agent;
	const originalStream = agent.streamFunction;
	const originalAbort = agent.abort;
	const originalPrompt = session.prompt;
	const originalDispose = session.dispose;
	let disposed = false;
	let epoch = 0;
	let retries = 0;
	let ownAbort = false;
	let active: { signal: AbortSignal; stop: () => void } | undefined;

	const notify = (message: string) => {
		if (!disposed && ctx.hasUI) ctx.ui.notify(message, "warning");
	};
	const invalidate = () => { epoch++; };
	const abort: typeof agent.abort = function (this: typeof agent) {
		if (!ownAbort) invalidate();
		active?.stop();
		return originalAbort.call(this);
	};
	const prompt: typeof session.prompt = function (this: AgentSession, ...args) {
		invalidate();
		return originalPrompt.apply(this, args);
	};

	async function recover(signal: AbortSignal) {
		if (disposed || signal.aborted || agent.signal !== signal
			|| session.isCompacting || agent.state.pendingToolCalls.size > 0) return;
		const ticket = ++epoch;
		const sessionId = session.sessionId;
		const canRetry = retries < MAX_RETRIES;
		if (canRetry) retries++;
		notify(canRetry
			? `Model inactive for 5 minutes; cancelling and retrying (${retries}/${MAX_RETRIES}).`
			: "Model inactive for 5 minutes; stopped after 3 watchdog retries. Use /retry to continue manually.");
		try {
			// Only the synchronous abort dispatch is ours. A second explicit abort
			// while cancellation is settling invalidates this recovery ticket.
			ownAbort = true;
			let settling: Promise<void>;
			try { settling = session.abort(); }
			finally { ownAbort = false; }
			await settling;
			if (!canRetry || disposed || epoch !== ticket || session.sessionId !== sessionId
				|| !session.isIdle || session.isCompacting) return;
			const last = agent.state.messages.at(-1);
			// Never reinterpret a completed response or a newly-started run as the
			// interrupted attempt. Tool results preceding this failure stay intact.
			if (last?.role !== "assistant" || last.stopReason !== "aborted") return;
			await continueSession(session);
		} catch (error) {
			notify(`Watchdog could not continue: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const stream: typeof agent.streamFunction = async function (model, context, options) {
		const signal = options?.signal;
		// Compaction/branch summaries can reuse streamFunction, but have their
		// own signals. Nested model calls and tools are deliberately not timed.
		if (disposed || !signal || signal.aborted || signal !== agent.signal || session.isCompacting) {
			return originalStream(model, context, options);
		}
		active?.stop();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		let thinkingTokens = 0;
		const stop = () => {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			signal.removeEventListener("abort", stop);
			if (active?.stop === stop) active = undefined;
		};
		const arm = () => {
			if (stopped || disposed || signal.aborted) return;
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(() => {
				if (stopped || disposed) return;
				stop();
				void recover(signal);
			}, INACTIVITY_MS);
			timer.unref();
		};
		active = { signal, stop };
		signal.addEventListener("abort", stop, { once: true });
		arm();
		try {
			const response = await originalStream(model, context, options);
			return new Proxy(response, {
				get(target, property) {
					if (property === Symbol.asyncIterator) return async function* () {
						try {
							for await (const event of target) {
								if (event.type === "done" || event.type === "error") {
									stop();
									if (!signal.aborted && event.type === "done"
										&& (event.reason === "stop" || event.reason === "toolUse")) retries = 0;
								} else {
									const tokens = estimatedThinkingTokens(event);
									const thinkingAdvanced = tokens !== undefined && tokens > thinkingTokens;
									if (thinkingAdvanced) thinkingTokens = tokens;
									// Empty Claude thinking text still counts as activity when its
									// estimate advances. Repeated/stale counts are not heartbeats.
									if (thinkingAdvanced || ((event.type === "text_delta" || event.type === "thinking_delta"
										|| event.type === "toolcall_delta") && event.delta.length > 0)) arm();
								}
								yield event;
							}
						} finally { stop(); }
					};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		} catch (error) {
			stop();
			throw error;
		}
	};

	agent.abort = abort;
	session.prompt = prompt;
	agent.streamFunction = stream;
	// This catches direct native continuations as well as prompts racing with
	// abort settlement. Do not reset the retry budget merely because a run starts.
	const unsubscribe = agent.subscribe(event => {
		if (event.type === "agent_start") invalidate();
	});
	// Preserve input queued before the timeout, but yield to input newly queued
	// during cancellation (including direct SDK steer/followUp calls).
	const unsubscribeQueue = session.subscribe(event => {
		if (event.type === "queue_update") invalidate();
	});
	// SDK hosts may dispose without emitting extension session_shutdown.
	const dispose: typeof session.dispose = function (this: AgentSession) {
		cleanup();
		return originalDispose.call(this);
	};
	session.dispose = dispose;
	function cleanup() {
		if (disposed) return;
		disposed = true;
		invalidate();
		active?.stop();
		unsubscribe();
		unsubscribeQueue();
		if (agent.streamFunction === stream) agent.streamFunction = originalStream;
		if (agent.abort === abort) agent.abort = originalAbort;
		if (session.prompt === prompt) session.prompt = originalPrompt;
		if (session.dispose === dispose) session.dispose = originalDispose;
	}
	return cleanup;
}

export default function extension(pi: ExtensionAPI) {
	const sessions = installSessionBridge();
	let cleanup: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		cleanup?.();
		const session = sessions.get(ctx.sessionManager);
		if (!session) throw new Error("Watchdog session binding unavailable. Restart Pi.");
		cleanup = watch(session, ctx);
	});
	pi.on("session_shutdown", () => {
		cleanup?.();
		cleanup = undefined;
	});
}
