import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { emptyOutputRenderer } from "../status/footer.ts";
import { installQueuedEditor } from "../queued-up/index.ts";
function freshLoader() {
	// Use the pinned native extension loader's transformer, but never its extension
	// runtime. Shared SDK/TUI identity is essential for the existing native TUI.
	const require = createRequire(join(codingAgent.getPackageDir(), "package.json"));
	const { createJiti } = require("jiti") as {
		createJiti(
			base: string,
			options: object,
		): {
			import(path: string, options?: { default: true }): Promise<unknown>;
		};
	};
	return createJiti(import.meta.url, {
		moduleCache: false,
		fsCache: false,
		tryNative: false,
		virtualModules: {
			"@earendil-works/pi-coding-agent": codingAgent,
			"@earendil-works/pi-tui": tui,
		},
	});
}

/** Refresh the presentation driver and its local dependency graph, not transport. */
export async function loadFreshSessionView(): Promise<typeof import("./session-view.ts")> {
	return (await freshLoader().import(
		fileURLToPath(new URL("./session-view.ts", import.meta.url)),
	)) as typeof import("./session-view.ts");
}

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
