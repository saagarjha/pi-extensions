import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "../shared/tool-renderers.ts";

/** Child-only tool presentation, also used when an archive has no live child executor. */
export const notifyParentRenderers: ToolRenderers = {
	renderCall(args: { message?: string }, theme: Theme) {
		return new Text(`${theme.fg("toolTitle", theme.bold("notify_parent"))}\n${theme.fg("toolOutput", args.message ?? "")}`, 0, 0);
	},
};
