import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RemoteConnection } from "./client-connection.ts";
import type { PanelRenderers } from "../subagents/panel-host.ts";
export type { SubagentsPanelState } from "../subagents/panel-host.ts";
export async function openSubagentsPanel(
	remote: RemoteConnection,
	ui: ExtensionUIContext,
	rendering: PanelRenderers,
	signal?: AbortSignal,
	requestId?: string,
	initialHideThinking = false,
) {
	const { serverIdentity, sessionId, controlGeneration } = remote;
	const serviceGeneration = remote.current.services.subagents?.serviceGeneration;
	try {
		const { createSubagentsPanel } = await import("../subagents/panel.ts");
		return await ui.custom<boolean>(
			await createSubagentsPanel(remote, ui, rendering, signal, requestId, initialHideThinking),
			{ overlay: true, overlayOptions: { width: "86%", maxHeight: "72%", anchor: "center" } },
		);
	} catch (error) {
		// A retired/controller-preempted presentation must not answer its old prompt.
		if (
			signal?.aborted ||
			!remote.connected ||
			!remote.isController ||
			remote.serverIdentity !== serverIdentity ||
			remote.sessionId !== sessionId ||
			remote.controlGeneration !== controlGeneration ||
			remote.current.services.subagents?.serviceGeneration !== serviceGeneration
		)
			return false;
		ui.notify(
			`Subagent panel unavailable: ${String(error)}. Main editor remains available.`,
			"warning",
		);
		// Resolve only this failed owned presentation through drain's normal, fenced
		// answer path. Throwing would make each later live frame retry the same UI.
		return true;
	}
}
