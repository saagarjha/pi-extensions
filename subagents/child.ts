import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NOTIFY_PARENT_GUIDELINES } from "./protocol.ts";
import { labelMessageOrigin } from "./messaging.ts";
import { notifyParentRenderers } from "./notify-parent-renderer.ts";

type SubagentChildBridge = {
	instances: Map<string, {
		notify(message: string): void;
		connect?(api: ExtensionAPI): void;
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
		bridge()?.instances.get(sessionId)?.connect?.(pi);
		pi.registerTool({
			...notifyParentRenderers,
			name: "notify_parent",
			label: "Notify Parent",
			description: "Send a parent-visible message. Required for parent-delegated results, blockers, and requests for parent attention. Work and results directly requested by the user need not be reported to the parent and may be answered inline. Ordinary assistant replies are not delivered to the parent.",
			promptSnippet: "notify_parent: required for parent-delegated results and blockers; not required for work and results directly requested by the user",
			promptGuidelines: NOTIFY_PARENT_GUIDELINES,
			parameters: Type.Object({
				message: Type.String({ description: "Parent-visible message to send. Report parent-delegated work here, identifying relevant user-directed changes. Work and results directly requested by the user may stay inline without notifying the parent." }),
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
