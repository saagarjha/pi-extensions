import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	openBackgroundPanel,
	type BackgroundPanelState,
	type BackgroundViewPort,
} from "../permissions/src/background-panel.ts";
import type { BackgroundTaskMetadata, BackgroundTaskDetail } from "../shared/control-plane.ts";
import type { RemoteConnection } from "./client-connection.ts";
import type { InteractionRequest } from "./protocol.ts";

const states = new WeakMap<RemoteConnection, Map<string, BackgroundPanelState>>();

/** The request binds its REAL source port on the owner, including child jobs.
 * No lookup through the parent's global permissions/background service. */
export async function openRemoteBackground(
	remote: RemoteConnection,
	ui: ExtensionUIContext,
	request: InteractionRequest,
	signal: AbortSignal,
) {
	let saved = states.get(remote);
	if (!saved) {
		saved = new Map();
		states.set(remote, saved);
	}
	for (const id of saved.keys())
		if (!remote.pendingRequests.some((p) => p.id === id)) saved.delete(id);
	const state = saved.get(request.id) ?? {};
	saved.set(request.id, state);
	const generation = remote.controlGeneration,
		sessionId = remote.sessionId,
		server = remote.serverIdentity;
	const lifecycle = new AbortController();
	const combined = AbortSignal.any([signal, lifecycle.signal]);
	const current = () =>
		!combined.aborted &&
		remote.connected &&
		remote.isController &&
		remote.controlGeneration === generation &&
		remote.sessionId === sessionId &&
		remote.serverIdentity === server &&
		remote.pendingRequests.some((p) => p.id === request.id);
	const check = () => {
		if (!current()) throw Error("BACKGROUND_PRESENTATION_RETIRED");
	};
	const call = async <T,>(method: string, id?: string) => {
		check();
		const result = await remote.customRequest<T>(method, {
			requestId: request.id,
			controlGeneration: generation,
			id,
		});
		check();
		return result;
	};
	const off = remote.subscribeFrames((frame) => {
		if (!current() || (frame.type === "interactionResolved" && frame.requestId === request.id))
			lifecycle.abort();
	});
	const port: BackgroundViewPort = {
		list: () => call<BackgroundTaskMetadata[]>("backgroundList"),
		status: (id) => call<BackgroundTaskDetail>("backgroundStatus", id),
		stop: (id) => call<BackgroundTaskDetail>("backgroundStop", id),
		subscribe: (listener) =>
			remote.subscribeFrames((frame) => {
				if (frame.type === "presentationChanged" && frame.requestId === request.id && current())
					listener();
			}),
	};
	try {
		check();
		const closed = await openBackgroundPanel(
			ui,
			port,
			combined,
			(request.args[0] as { label?: string })?.label,
			state,
		);
		if (closed) saved.delete(request.id);
		return closed;
	} finally {
		off();
		lifecycle.abort();
		if (!remote.pendingRequests.some((p) => p.id === request.id)) saved.delete(request.id);
	}
}
