import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSessionBridge, continueSession } from "../shared/session-continuation.ts";

export default function extension(pi: ExtensionAPI) {
	const sessions = installSessionBridge();
	pi.registerCommand("retry", {
		description: "Continue an interrupted turn without adding a user message or replaying tool results",
		handler: async (args, ctx) => {
			try {
				if (args.trim()) throw new Error("Usage: /retry (no arguments)");
				const session = sessions.get(ctx.sessionManager);
				if (!session) throw new Error("Session binding unavailable. Restart Pi to enable /retry.");
				await continueSession(session);
			} catch (error) {
				const message = `Cannot retry: ${error instanceof Error ? error.message : String(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else throw new Error(message);
			}
		},
	});
}
