import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
	let enabled = false;
	pi.registerCommand("fast", {
		getArgumentCompletions: (prefix) => ["on", "off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		description: "Toggle Codex fast mode, or set on/off",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!["", "on", "off"].includes(action)) {
				ctx.ui.notify("Usage: /fast [on|off]", "warning");
				return;
			}
			enabled = action === "" ? !enabled : action === "on";
			ctx.ui.setStatus("codex-fast", enabled ? "+" : undefined);
			ctx.ui.notify(`Codex fast mode ${enabled ? "on (uses more credits)" : "off"}`);
		},
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || ctx.model?.api !== "openai-codex-responses") return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		return { ...event.payload, service_tier: "priority" };
	});
	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		ctx.ui.setStatus("codex-fast", undefined);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		enabled = false;
		ctx.ui.setStatus("codex-fast", undefined);
	});
}
