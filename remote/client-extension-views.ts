import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { emptyOutputRenderer } from "../status/footer.ts";
import { installQueuedEditor } from "../queued-up/index.ts";
/** Finite owned rendering/editor exports; no synthetic extension runtime. */
export async function loadClientViews() {
	let installed = false;
	return {
		reset: () => {
			installed = false;
		},
		getMessageRenderer: (name: string) =>
			name === "model.empty-output" ? emptyOutputRenderer : undefined,
		getEntryRenderer: (_name: string) => undefined,
		async installEditor(name: string, ui: ExtensionUIContext, hasPendingMessages: () => boolean) {
			if (name !== "queued-up") throw Error("Unknown owned client editor");
			if (installed) return;
			installQueuedEditor(ui, hasPendingMessages);
			installed = true;
		},
	};
}
