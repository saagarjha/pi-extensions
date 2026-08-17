import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NOTIFY_PARENT_GUIDELINES } from "./protocol.ts";
import { labelMessageOrigin } from "./messaging.ts";

type SubagentChildBridge = {
	instances: Map<string, {
		notify(message: string): void;
	}>;
};

function bridge(): SubagentChildBridge | undefined {
	return (globalThis as typeof globalThis & { __piSubagentChildBridge?: SubagentChildBridge }).__piSubagentChildBridge;
}

function result(text: string, details?: unknown, isError = false) {
	// Pi derives tool failure from a thrown exception, not a returned isError field.
	if (isError) throw new Error(text);
	return { content: [{ type: "text" as const, text }], details };
}

export default function extension(pi: ExtensionAPI) {
	pi.on("message_end", (event, ctx) => {
		if (!bridge()?.instances.has(ctx.sessionManager.getSessionId())) return;
		const message = labelMessageOrigin(event.message);
		if (message !== event.message) return { message };
	});

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		pi.registerTool({
			name: "notify_parent",
			label: "Notify Parent",
			description: "Send a parent-visible message. Mandatory for delegated results, blockers, and parent attention. Ordinary assistant replies are not delivered to the parent. Only replies specifically to harness-tagged origin=user messages may be answered inline instead.",
			promptSnippet: "notify_parent: required for delegated results, blockers, and parent attention; only direct origin=user replies may be inline",
			promptGuidelines: NOTIFY_PARENT_GUIDELINES,
			parameters: Type.Object({
				message: Type.String({ description: "Parent-visible message to send. Put delegated results here, identifying relevant user-directed changes. Direct origin=user replies may instead be inline." }),
			}),
			async execute(_id, params) {
				const instance = bridge()?.instances.get(sessionId);
				if (!instance) return result("This subagent is not connected to a parent session.", undefined, true);
				instance.notify(params.message);
				return result(`Sent notification to parent.\n\nMessage: ${params.message}`, { message: params.message });
			},
		});
		const active = new Set(pi.getActiveTools());
		active.add("notify_parent");
		pi.setActiveTools([...active]);
	});
}
