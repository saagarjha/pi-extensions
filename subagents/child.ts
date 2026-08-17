import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SubagentChildBridge = {
	instances: Map<string, {
		notify(message: string): void;
	}>;
};

function bridge(): SubagentChildBridge | undefined {
	return (globalThis as typeof globalThis & { __piSubagentChildBridge?: SubagentChildBridge }).__piSubagentChildBridge;
}

function result(text: string, details?: unknown, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

export default function extension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		pi.registerTool({
			name: "notify_parent",
			label: "Notify Parent",
			description: "Notify the parent agent when parent attention is needed: you are blocked, cannot continue autonomously, or have the requested result. Do not use for routine progress.",
			promptSnippet: "notify_parent: notify the parent when attention is needed",
			promptGuidelines: [
				"Use notify_parent only when you cannot continue autonomously or have the result the parent asked for.",
				"Do not use notify_parent for routine progress logging; keep ordinary progress in your own transcript.",
			],
			parameters: Type.Object({
				message: Type.String({ description: "Message to send to the parent agent." }),
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
