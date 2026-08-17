import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";

type AgentMessage = AgentSession["messages"][number];
type ImageContent = NonNullable<PromptOptions["images"]>[number];
export type MessageOrigin = "parent" | "user" | "extension";
export type MessageProvenance = {
	origin: MessageOrigin;
	id: string;
	/** Input before skill/template expansion, when submitted through AgentSession. */
	input?: string;
	labelled?: boolean;
};

type TaggedMessage = AgentMessage & { subagentMessage: MessageProvenance };
export type MessagingSession = Pick<AgentSession, "prompt"> & {
	agent: Pick<AgentSession["agent"], "prompt" | "steer" | "followUp">;
};
export interface SubagentMessaging {
	sendParent(text: string, delivery?: "steer" | "followUp"): Promise<void>;
	sendUser(text: string, delivery?: "steer" | "followUp"): Promise<void>;
	dispose(): void;
}
const installed = new WeakMap<MessagingSession, SubagentMessaging>();

export function messageProvenance(message: unknown): MessageProvenance | undefined {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user") return undefined;
	const metadata = (message as TaggedMessage).subagentMessage;
	if (!metadata || typeof metadata.id !== "string") return undefined;
	if (metadata.origin !== "parent" && metadata.origin !== "user" && metadata.origin !== "extension") return undefined;
	return metadata;
}

/** Keep queued text untouched: Pi matches its queue entries by message content. */
export function tagMessage(message: AgentMessage, origin: MessageOrigin, input?: string): AgentMessage {
	if (message.role !== "user" || messageProvenance(message)) return message;
	const tagged = { ...message, subagentMessage: { origin, id: randomUUID(), input } } satisfies TaggedMessage;
	return tagged;
}

/**
 * Materialize the model-visible label at message_end, after Pi removes the raw
 * text from its queue at message_start, but before persistence and inference.
 * The label stays in content so compaction also sees the sender distinction.
 */
export function labelMessageOrigin(message: AgentMessage): AgentMessage {
	const metadata = messageProvenance(message);
	if (message.role !== "user" || !metadata || metadata.labelled) return message;
	const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	const labelled = {
		...message,
		content: [{ type: "text", text: `[Subagent message origin=${metadata.origin}]\n` }, ...content],
		subagentMessage: { ...metadata, labelled: true },
	} satisfies TaggedMessage;
	return labelled;
}

/** Strip only our trusted label for Pi's skill-aware user-message renderer. */
export function userMessageDisplayText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	const metadata = messageProvenance(message);
	let content = message.content;
	if (metadata?.labelled && content[0]?.type === "text"
		&& content[0].text === `[Subagent message origin=${metadata.origin}]\n`) content = content.slice(1);
	return content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

/**
 * Instance-local ingress adapter; never patches root sessions or Pi prototypes.
 * AgentSession constructs messages only after command dispatch, input transforms,
 * template expansion, and preflight. Tag at its public Agent handoff instead of
 * rewriting raw editor input. Steering/follow-up queues then retain the same tag.
 */
export function installSubagentMessaging(session: MessagingSession): SubagentMessaging {
	const existing = installed.get(session);
	if (existing) return existing;
	const submissions = new AsyncLocalStorage<{ origin: MessageOrigin; input: string; consumed: boolean }>();
	let inFlight = 0;
	let disposed = false;
	// Only these harness entry points assign parent/user origin. Extension-created
	// prompts cannot inherit human authority from the async turn that spawned them.
	const origins = new WeakMap<PromptOptions, MessageOrigin>();
	const originalPrompt = session.prompt;
	const originalAgentPrompt = session.agent.prompt;
	const originalSteer = session.agent.steer;
	const originalFollowUp = session.agent.followUp;
	const agent = session.agent;

	const annotate = (messages: AgentMessage[]) => {
		const submission = submissions.getStore();
		const origin = submission && !submission.consumed ? submission.origin : "extension";
		const input = submission && !submission.consumed ? submission.input : undefined;
		// The SDK's retry/continuation and settled hooks resume in prompt's async
		// scope. Consume authorship at the first handoff, not at the end of a run.
		if (submission) submission.consumed = true;
		return messages.map((message) => tagMessage(message, origin, input));
	};

	session.prompt = async (text, options) => {
		const origin = options ? origins.get(options) ?? "extension" : "extension";
		if (options) origins.delete(options);
		inFlight++;
		try {
			return await submissions.run({ origin, input: text, consumed: false }, () => originalPrompt.call(session, text, options));
		} finally {
			inFlight--;
			if (disposed && inFlight === 0) submissions.disable();
		}
	};
	agent.prompt = (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) => {
		const messages: AgentMessage[] = typeof input === "string"
			? [{ role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }]
			: Array.isArray(input) ? input : [input];
		const tagged = annotate(messages);
		const promptMessages: (messages: AgentMessage[]) => Promise<void> = originalAgentPrompt;
		// Do not let tools/events during this run inherit its original sender.
		return submissions.exit(() => promptMessages.call(agent, tagged));
	};
	agent.steer = (message) => { originalSteer.call(agent, annotate([message])[0]!); };
	agent.followUp = (message) => { originalFollowUp.call(agent, annotate([message])[0]!); };
	const wrappers = { prompt: session.prompt, agentPrompt: agent.prompt, steer: agent.steer, followUp: agent.followUp };

	async function submit(origin: "parent" | "user", text: string, streamingBehavior?: "steer" | "followUp") {
		if (disposed) throw new Error("Subagent messaging has been disposed.");
		const options: PromptOptions = {
			source: origin === "user" ? "interactive" : "extension",
			expandPromptTemplates: origin === "user",
			streamingBehavior,
		};
		origins.set(options, origin);
		return session.prompt(text, options);
	}

	const messaging: SubagentMessaging = {
		sendParent: (text: string, delivery?: "steer" | "followUp") => submit("parent", text, delivery),
		sendUser: (text: string, delivery?: "steer" | "followUp") => submit("user", text, delivery),
		dispose() {
			if (installed.get(session) !== messaging) return;
			installed.delete(session);
			disposed = true;
			if (session.prompt === wrappers.prompt) session.prompt = originalPrompt;
			if (agent.prompt === wrappers.agentPrompt) agent.prompt = originalAgentPrompt;
			if (agent.steer === wrappers.steer) agent.steer = originalSteer;
			if (agent.followUp === wrappers.followUp) agent.followUp = originalFollowUp;
			if (inFlight === 0) submissions.disable();
		},
	};
	installed.set(session, messaging);
	return messaging;
}
