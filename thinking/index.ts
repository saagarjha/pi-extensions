import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const ALIASES: Record<string, ThinkingLevel> = {
	"0": "off",
	none: "off",
	no: "off",
	"false": "off",
	min: "minimal",
	minimum: "minimal",
	med: "medium",
	mid: "medium",
	x: "xhigh",
	extra: "xhigh",
	xhigh: "xhigh",
	"x-high": "xhigh",
	maximum: "max",
};

function parseLevel(input: string): ThinkingLevel | undefined {
	const normalized = input.trim().toLowerCase().replace(/^thinking\s+/, "");
	if (!normalized) return undefined;
	if ((THINKING_LEVELS as readonly string[]).includes(normalized)) return normalized as ThinkingLevel;
	return ALIASES[normalized];
}

function levelCompletions(prefix: string): AutocompleteItem[] | null {
	const normalized = prefix.trim().toLowerCase();
	const items = THINKING_LEVELS
		.filter((level) => level.startsWith(normalized))
		.map((level) => ({ value: level, label: level }));
	return items.length > 0 ? items : null;
}

export default function extension(pi: ExtensionAPI) {
	pi.registerCommand("thinking", {
		description: "Change thinking mode (off/minimal/low/medium/high/xhigh/max)",
		getArgumentCompletions: levelCompletions,
		handler: async (args, ctx) => {
			const requested = (args ?? "").trim();
			let level = parseLevel(requested);

			if (!level) {
				if (requested || !ctx.hasUI) {
					const prefix = requested ? `Unknown thinking mode: ${requested}. ` : "";
					ctx.ui.notify(`${prefix}Usage: /thinking ${THINKING_LEVELS.join("|")}`, requested ? "error" : "info");
					return;
				}

				const current = pi.getThinkingLevel();
				const choice = await ctx.ui.select(
					`Thinking mode (current: ${current})`,
					THINKING_LEVELS.map((candidate) => candidate === current ? `${candidate} (current)` : candidate),
				);
				if (!choice) return;
				level = parseLevel(choice.replace(/ \(current\)$/, ""));
				if (!level) return;
			}

			pi.setThinkingLevel(level);
			const actual = pi.getThinkingLevel();
			const suffix = actual === level ? "" : ` (clamped from ${level} by current model)`;
			ctx.ui.notify(`Thinking mode: ${actual}${suffix}`, "info");
		},
	});
}
