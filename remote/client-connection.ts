import { isOwnedPresentation, presentationPriority } from "../shared/owned-ui.ts";
import type { LaunchProfile } from "./daemon-protocol.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	errorMessage,
	type ClientFrame,
	type UIAction,
	type SessionDescription,
	type LiveState,
} from "./protocol.ts";
export interface RequestParams {
	args?: unknown[];
	text?: string;
	options?: unknown;
}
export interface LifecycleParams {
	sessionId?: string;
	fileIdentity?: string;
	profile?: LaunchProfile;
	control?: boolean;
	ifUnoccupied?: boolean;
	leafId?: string | null;
}
export interface CatalogResult {
	catalog?: LiveState["catalog"];
	errors?: [string, string][];
}
export type RemoteConnection = Awaited<ReturnType<typeof createClientConnection>>;
import { connect } from "./transport-client.ts";
import { discoverDaemon } from "./daemon-discovery.ts";
import type { ConnectionProfile } from "./connection-profile.ts";
import type { SubagentSubmission } from "./subagent-submission.ts";
import type { SubagentsPanelState } from "./subagents-panel.ts";

/** Socket/replica presentation bridge. Initial attach NEVER takes control. */
export async function createClientConnection({
	connection,
	sessionId,
	profile,
	hello,
	connectionName = profile ? "local" : "remote",
	onConnectionChange = () => {},
	notify = () => {},
}: {
	connection?: ConnectionProfile;
	sessionId: string;
	profile?: LaunchProfile;
	hello?: Record<string, unknown>;
	connectionName?: string;
	onConnectionChange?: () => void;
	notify?: (message: string) => void;
}) {
	// Keep the discovered transport identity when the connection is omitted,
	// so an already-connected /daemon connect remains a true no-op.
	if (!connection) {
		const daemon = await discoverDaemon();
		connection = {
			version: 1,
			origin: daemon.origin,
			token: daemon.token,
			instanceId: daemon.instanceId,
		};
	}
	let client = await connect({ connection, hello });
	try {
		await client.attach(sessionId, { control: false, profile });
	} catch (error) {
		client.close();
		throw error;
	}

	const frames = new Set<(frame: ClientFrame) => void>();
	const events = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
	const seen = new Set<string>();
	const uiQueue = (client.snapshot.uiState ?? []).filter(
		(frame) => !["setEditorText", "pasteToEditor"].includes(frame.method),
	);
	let uiHandler: ((action: UIAction) => Promise<unknown>) | undefined;
	let uiReady = false;
	const uiHolds = new Set<object>();
	let uiHold: Promise<void> | undefined;
	let resumeUI: (() => void) | undefined;
	let dialogBusy = false;
	let dialogAbort: AbortController | undefined;
	let activeDialogKind: string | undefined;
	let activeDialogId: string | undefined;
	let drainRequested = false;
	let connected = true;
	let closedByClient = false;

	const remote = {
		// Shared presentation flag keeps both footer writers truthful during rebind.
		changingSession: false,
		// Local editor state and bounded input recovery, never a second history/runtime.
		subagentsPanelState: undefined as SubagentsPanelState | undefined,
		subagentSubmission: undefined as SubagentSubmission | undefined,
		subagentQueueRecovery: undefined as SubagentSubmission | undefined,
		get serverIdentity() {
			return client.serverIdentity;
		},
		get connectionName() {
			return connectionName;
		},
		async switchServer(
			nextConnection: ConnectionProfile,
			localProfile?: LaunchProfile,
			name = localProfile ? "local" : "remote",
		) {
			// Discovery may rotate Local's port, token and instance ID after restart.
			// This scope is distinct from saved remote names and transport identity.
			// Each discovery mints a fresh credential; token equality is not identity.
			const sameLocal =
				connectionName === "local" && name === "local" && !!profile && !!localProfile;
			if (
				sameLocal &&
				connected &&
				connection?.origin === nextConnection.origin &&
				!!connection?.instanceId &&
				connection.instanceId === nextConnection.instanceId &&
				connection?.certificate === nextConnection.certificate
			) return false;
			const selectedSessionId = sameLocal ? client.snapshot.header?.id : undefined;
			if (sameLocal && !selectedSessionId)
				throw Error("Selected native session identity is unavailable; no session was created.");
			const next = await connect({ connection: nextConnection });
			try {
				if (sameLocal) {
					await next.attach(selectedSessionId!, { controlIfFree: true, profile: localProfile });
				} else {
					// Different-server selection retains its existing behavior. Never
					// carry this server's native session ID into another server scope.
					const created = await next.request<SessionDescription>("create", localProfile ? { profile: localProfile } : {});
					await next.attach(created.sessionId, { control: false });
				}
			} catch (error) {
				next.close();
				throw error;
			}
			removeListener();
			client.close();
			remote.subagentSubmission?.retire();
			remote.subagentQueueRecovery?.retire();
			client = next;
			connection = nextConnection;
			remote.subagentsPanelState = undefined;
			profile = localProfile;
			connectionName = name;
			connected = true;
			closedByClient = false;
			dialogAbort?.abort();
			seen.clear();
			uiQueue.length = 0;
			removeListener = client.onFrame(handleFrame);
			onConnectionChange();
			if (sameLocal)
				notify(`Reconnected to the selected session in ${client.control.controllerClientId === client.clientId ? "control" : "watch"} mode. Draft not replayed.`);
			return sameLocal ? "reconnect" : "switch";
		},
		clientDiagnostics: undefined as (() => unknown) | undefined,
		get replica() {
			return client.replica;
		},
		get sessionId() {
			return client.snapshot.sessionId;
		},
		get snapshot() {
			return client.snapshot;
		},
		get current() {
			return client.live;
		},
		get connected() {
			return connected;
		},
		get isController() {
			return connected && client.control.controllerClientId === client.clientId;
		},
		get controlGeneration() {
			return client.control.controlGeneration;
		},
		get pendingRequests() {
			return client.pendingRequests;
		},
		subscribeFrames(fn: (frame: ClientFrame) => void) {
			frames.add(fn);
			return () => {
				frames.delete(fn);
			};
		},
		customRequest: <Result = unknown>(method: string, params?: object) =>
			client.request<Result>(method, params ? { ...params } : undefined),

		subscribe(fn: (event: AgentSessionEvent) => void | Promise<void>) {
			events.add(fn);
			return () => events.delete(fn);
		},
		async request<Result = unknown>(method: string, params: RequestParams = {}): Promise<Result> {
			if (method === "takeover") {
				const result = await client.takeControl();
				void drain();
				return result as Result;
			}
			if (method === "watch")
				return (remote.isController ? await client.releaseControl() : undefined) as Result;
			if (method === "refreshCatalog") {
				const result = await client.request<CatalogResult>("refreshCatalog");
				if (result.catalog) client.live = { ...client.live, catalog: result.catalog };
				return result as Result;
			}
			const args =
				params.args ??
				(method === "prompt"
					? [params.text, params.options]
					: method === "abort"
						? []
						: [params.text]);
			return client.mutate<Result>(method, args);
		},
		close() {
			closedByClient = true;
			remote.subagentSubmission?.retire();
			remote.subagentQueueRecovery?.retire();
			remote.subagentSubmission?.release();
			remote.subagentQueueRecovery?.release();
			remote.subagentsPanelState = undefined;
			connected = false;
			uiReady = false;
			dialogAbort?.abort();
			releaseHeldUI();
			removeListener();
			client.close();
			onConnectionChange();
		},
		holdUI() {
			// Admission can reject without changing attachment. Pause presentation
			// delivery/answers without cancelling the old dialog or replaying its UI.
			if (!uiHolds.size)
				uiHold = new Promise<void>((resolve) => {
					resumeUI = resolve;
				});
			const hold = {};
			uiHolds.add(hold);
			return () => {
				if (!uiHolds.delete(hold)) return;
				if (!uiHolds.size) {
					releaseHeldUI();
					void drain();
				}
			};
		},
		beginRebind() {
			uiReady = false;
			dialogAbort?.abort();
			uiQueue.length = 0;
			seen.clear();
		},
		async endRebind() {
			uiQueue.push(
				...(client.snapshot.uiState ?? []).filter(
					(frame) => !["setEditorText", "pasteToEditor"].includes(frame.method),
				),
			);
			uiReady = true;
			void drain();
		},
		listSessions: () =>
			client.request<SessionDescription[]>("list", {
				...(profile ? { profile } : {}),
			}),
		resumeProfile: (session: SessionDescription) =>
			profile
				? { ...profile, agentDir: session.agentDir ?? profile.agentDir }
				: undefined,
		async lifecycle(method: string, params: LifecycleParams = {}) {
			if (method === "new") {
				// Native /new inherits the currently attached owner's live profile,
				// not the client's original startup model.
				const made = await client.request<{ sessionId?: string; id: string }>("create");
				await client.attach(made.sessionId ?? made.id, {
					control: true,
				});
			} else if (method === "fork") {
				await client.request("fork", {
					...params,
					controlGeneration: client.control.controlGeneration,
				});
			} else if (method === "resume") {
				if (!params.sessionId) throw Error("Resume requires a session ID");
				await client.attach(params.sessionId, {
					control: params.control ?? true,
					ifUnoccupied: params.ifUnoccupied ?? params.control === undefined,
					profile: params.profile ?? profile,
					fileIdentity: params.fileIdentity,
				});
				// The same socket may still own an earlier session. Explicit Watch
				// must release that old lease rather than merely omit a new takeover.
				if (params.control === false && client.control.controllerClientId === client.clientId) {
					await client.releaseControl();
				}
			} else throw Error("Unknown client lifecycle: " + method);
			return { cancelled: false };
		},
		set onUI(fn: ((action: UIAction) => Promise<unknown>) | undefined) {
			uiHandler = fn;
			uiReady = true;
			void drain();
		},
		get onUI() {
			return uiHandler;
		},
	};

	function releaseHeldUI() {
		uiHolds.clear();
		uiHold = undefined;
		const resume = resumeUI;
		resumeUI = undefined;
		resume?.();
	}

	async function drain() {
		if (!uiReady || uiHolds.size || !uiHandler) return;
		if (dialogBusy) {
			drainRequested = true;
			return;
		}
		dialogBusy = true;
		drainRequested = false;
		try {
			while (uiReady && !uiHolds.size && uiQueue.length) {
				try {
					await uiHandler(uiQueue.shift()!);
				} catch (error) {
					notify(errorMessage(error));
				}
			}
			if (!uiReady || uiHolds.size || !remote.isController) return;
			// Native questions temporarily preempt a local custom host; owner survives.
			const requests = [...client.pendingRequests].sort(
				(a, b) => presentationPriority(a.kind) - presentationPriority(b.kind),
			);
			for (const request of requests) {
				if (!uiReady || uiHolds.size) break;
				if (seen.has(request.id) || !remote.isController) continue;
				seen.add(request.id);
				const generation = client.control.controlGeneration;
				const sessionId = client.snapshot.sessionId;
				dialogAbort = new AbortController();
				activeDialogKind = request.kind;
				activeDialogId = request.id;
				try {
					if (!["confirm", "input", "select", "subagents", "background"].includes(request.kind)) {
						throw Error(`Remote ${request.kind} dialog is not supported by this attachment`);
					}
					const args = isOwnedPresentation(request.kind)
						? [request, dialogAbort.signal]
						: [
								...request.args.slice(0, 2),
								{
									...(request.args[2] as Record<string, unknown> | undefined),
									signal: dialogAbort.signal,
								},
							];
					const value = await uiHandler({ method: request.kind, args });
					while (uiHold) await uiHold;
					if (
						!dialogAbort.signal.aborted &&
						remote.isController &&
						client.snapshot.sessionId === sessionId &&
						client.pendingRequests.some((pending) => pending.id === request.id) &&
						generation === client.control.controlGeneration
					) {
						if (!isOwnedPresentation(request.kind) || value === true)
							await client.answer(
								request.id,
								isOwnedPresentation(request.kind) ? undefined : value,
							);
					} else seen.delete(request.id);
				} catch (error) {
					seen.delete(request.id);
					notify(errorMessage(error));
					break;
				} finally {
					dialogAbort = undefined;
					activeDialogKind = undefined;
					activeDialogId = undefined;
				}
			}
		} finally {
			dialogBusy = false;
			if (drainRequested) {
				drainRequested = false;
				queueMicrotask(() => void drain());
			}
		}
	}

	const handleFrame = (frame: ClientFrame) => {
		if (frame.type === "interactionResolved" && frame.requestId === activeDialogId)
			dialogAbort?.abort();
		if (
			frame.type === "interactionResolved" &&
			remote.subagentsPanelState?.requestId === frame.requestId
		) remote.subagentsPanelState = undefined;
		if (
			frame.type === "snapshot" &&
			(remote.subagentsPanelState?.sessionId !== frame.sessionId ||
				!frame.pendingRequests.some((p) => p.id === remote.subagentsPanelState?.requestId))
		) remote.subagentsPanelState = undefined;
		for (const fn of frames) {
			try {
				fn(frame);
			} catch (error) {
				notify(errorMessage(error));
			}
		}
		if (frame.type === "event") {
			for (const fn of events)
				Promise.resolve(fn(frame.event)).catch((error) => notify(errorMessage(error)));
		}
		if (
			frame.type === "ui" &&
			(remote.isController || !["setEditorText", "pasteToEditor"].includes(frame.method))
		) {
			if (
				uiReady &&
				!uiHolds.size &&
				uiHandler &&
				["ownedFooter", "ownedStatus"].includes(frame.method)
			) {
				void uiHandler({ method: frame.method, args: frame.args }).catch((error) =>
					notify(errorMessage(error)),
				);
				return;
			}
			uiQueue.push({ method: frame.method, args: frame.args });
			void drain();
		}
		if (frame.type === "control" || frame.type === "disconnect") {
			if (frame.type === "disconnect") {
				connected = false;
				uiReady = false;
				releaseHeldUI();
			}
			onConnectionChange();
			dialogAbort?.abort();
			for (let i = uiQueue.length - 1; i >= 0; i--) {
				if (["setEditorText", "pasteToEditor"].includes(uiQueue[i]!.method)) uiQueue.splice(i, 1);
			}
			void drain();
		}
		if (frame.type === "interaction" || frame.type === "control") {
			if (
				frame.type === "interaction" &&
				isOwnedPresentation(activeDialogKind) &&
				presentationPriority(frame.request.kind) < presentationPriority(activeDialogKind)
			)
				dialogAbort?.abort();
			if (!remote.isController && client.pendingRequests.length)
				notify("Owner awaits a dialog. /control explicitly takes over; watching does not answer.");
			void drain();
		}
		if (frame.type === "disconnect" && !closedByClient)
			notify("Disconnected. Draft not replayed; /disconnect exits this client.");
	};
	let removeListener = client.onFrame(handleFrame);
	return remote;
}
