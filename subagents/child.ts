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
			description: "Send a parent-visible message. This is the only way to report a result, say you are blocked, or ask the parent for attention; ordinary assistant messages remain hidden in the child transcript.",
			promptSnippet: "notify_parent: send a parent-visible message; final results must use this tool",
			promptGuidelines: [
				"The parent cannot see your ordinary assistant messages; to communicate with the parent, call notify_parent.",
				"When you have the requested result, call notify_parent with the result in its message argument. Do not write final results as ordinary assistant text.",
				"Use notify_parent only for final results, blockers, or parent attention; keep routine progress in your own transcript.",
			],
			parameters: Type.Object({
				message: Type.String({ description: "Parent-visible message to send. Put final results here instead of in ordinary assistant text." }),
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
