import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
	pi.on("model_select", (event, ctx) => {
		if (event.source === "restore" || !event.previousModel) return;

		// Pi records the model change before resetting thinking, then emits this hook.
		// Read before that boundary so manual changes are preserved without event-order races.
		const entries = ctx.sessionManager.getBranch();
		const changeIndex = entries.findLastIndex((entry) => entry.type === "model_change");
		const change = entries[changeIndex];
		if (change?.type !== "model_change"
			|| change.provider !== event.model.provider
			|| change.modelId !== event.model.id) return;

		for (let i = changeIndex - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (entry.type !== "thinking_level_change") continue;
			switch (entry.thinkingLevel) {
				case "off":
				case "minimal":
				case "low":
				case "medium":
				case "high":
				case "xhigh":
				case "max":
					// Clamps to the new model's capabilities without changing startup defaults.
					pi.setThinkingLevel(entry.thinkingLevel);
			}
			return;
		}
	});
}
