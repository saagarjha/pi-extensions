import { changeModelScope } from "./scope-state.ts";
import { writeSocket } from "./socket-writer.ts";
import { LineFramer } from "./line-framer.ts";
import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionUIContext,
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	ownedUI,
	nativeOwnedPrompt,
	isOwnedPresentation,
	remoteLogin,
	REMOTE_LOGIN_UNSUPPORTED,
	type OwnedUI,
} from "../shared/owned-ui.ts";
import type { BackgroundTaskPort } from "../shared/control-plane.ts";
import type { AttachAck, SessionDescription, LiveState, SessionActivity } from "./protocol.ts";
import type { ServiceRequest } from "./owner-services.ts";

type Bindings = Parameters<AgentSession["bindExtensions"]>[0];
type NativeManager = Pick<SessionManager, keyof SessionManager> & {
	_appendEntry(entry: SessionEntry): void;
};
interface Client {
	socket?: net.Socket;
	id: string | null;
	attached: string | null;
	observesActivity?: boolean;
}
interface Interaction {
	id: string;
	kind: string;
	args?: unknown[];
}
interface Pending {
	request: Interaction;
	resolve?: (value: unknown) => void;
}
interface Operation {
	operationId: string;
	command: string;
	status: string;
	value?: unknown;
	error?: string;
}
interface ToolExecution {
	start: Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
	update?: Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
	end?: Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
}
interface RPCParams extends ServiceRequest {
	[key: string]: unknown;
	sessionId: string;
	control?: boolean;
	controlGeneration: number;
	operationId: string;
	leafId?: string | null;
	requestId: string;
	value: unknown;
	command: string;
	editorText?: string;
	toolsExpanded?: boolean;
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
import net from "node:net";
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createOwnerServices } from "./owner-services.ts";
import { forkSession } from "./fork-session.ts";
import { bindIdleStatus } from "../shared/idle-status.ts";

function activeCount(getter: (() => number) | undefined): number | null {
	if (getter === undefined) return 0;
	try {
		const value = getter();
		return Number.isSafeInteger(value) && value >= 0 ? value : null;
	} catch {
		return null;
	}
}
export interface LinkedOwnerOptions {
	workerToken?: string;
	/** In-process child projection: no socket, listener, or second runtime. */
	embedded?: {
		emit(frame: import("./protocol.ts").ServerFrame): void;
		check(params: Record<string, unknown>): void;
		track?(operation: Promise<unknown>, command: string): void;
		command(command: string, args: unknown[], params: Record<string, unknown>): { handled: true; value: unknown } | undefined;
	};
}

export function createLinkedOwner(
	api: ExtensionAPI,
	session: AgentSession,
	socketPath: string,
	nativeUI: ExtensionUIContext | undefined,
	options: LinkedOwnerOptions = {},
) {
	if (!isAbsolute(socketPath)) throw Error("SESSION_LINK_SOCKET_MUST_BE_ABSOLUTE");
	const theme = nativeUI?.theme;
	if (!theme) throw Error("NATIVE_CLI_THEME_UNAVAILABLE");
	const sm = session.sessionManager as unknown as NativeManager,
		mr = session.modelRuntime,
		cwd = sm.getCwd(),
		dir = dirname(socketPath);
	if (!options.embedded) mkdirSync(dir, { recursive: true });
	const idleStatus = bindIdleStatus(api.events);
	const loaded = session.resourceLoader.getExtensions();
	if (loaded.errors.length) throw Error("EXTENSION_LOAD_FAILED " + JSON.stringify(loaded.errors));
	let closed = false,
		started = false;
	const sessions = new Map<string, Owner>(),
		clients = new Set<Client>();
	function send(c: Client, f: unknown) {
		if (c.socket && !c.socket.destroyed) writeSocket(c.socket, JSON.stringify(f) + "\n");
	}
	function frame(o: Owner, type: string, data: Record<string, unknown>) {
		if (closed) return;
		const f = { type, sessionId: o.id, seq: ++o.seq, ...data };
		options.embedded?.emit(f as import("./protocol.ts").ServerFrame);
		for (const c of clients) if (c.attached === o.id) send(c, f);
	}
	const localManagementCommands = new Set(["daemon", "remote", "disconnect"]);
	function live(o: Owner): LiveState {
		const s = o.session;
		const completingCommands = new Set(s.extensionRunner.getRegisteredCommands()
			.filter((command) => command.getArgumentCompletions).map((command) => command.invocationName));
		return {
			sessionName: o.sm.getSessionName(),
			leafId: o.sm.getLeafId(),
			streaming: s.isStreaming,
			idle: s.isIdle,
			compacting: s.isCompacting,
			asyncWork: {
				background: activeCount(idleStatus.backgroundActiveCount),
				subagents: activeCount(idleStatus.subagentsActiveCount),
				goal: activeCount(idleStatus.goalActiveCount),
			},
			thinking: s.thinkingLevel,
			model: s.model,
			scopedModels: s.scopedModels,
			modelSettings: { enabledModels: s.settingsManager.getEnabledModels(), defaultProvider: s.settingsManager.getDefaultProvider(), defaultModel: s.settingsManager.getDefaultModel() },
			steering: [...s.getSteeringMessages()],
			followUp: [...s.getFollowUpMessages()],
			partial: s.state.streamingMessage ?? null,
			pendingTools: [...s.state.pendingToolCalls],
			toolExecutions: [...o.toolExecutions.values()],
			retryAttempt: s.retryAttempt,
			contextUsage: s.getContextUsage(),
			stats: s.getSessionStats(),
			thinkingLevels: s.getAvailableThinkingLevels(),
			activeTools: s.getActiveToolNames(),
			catalog: o.mr.getAvailableSnapshot(),
			tools: s.getAllTools(),
			commands: o.api.getCommands().filter((command) => !localManagementCommands.has(command.name)).map((command) => ({
				...command,
				// A capability bit only; executable callbacks never cross the wire.
				argumentCompletions: completingCommands.has(command.name),
			})),
			extensions: o.loadedExtensions,
			extensionErrors: o.extensionErrors,
			services: o.services.snapshot(),
			ownerRuntime: {
				kind: options.embedded ? "native-subagent-session" : "normal-pi-cli-extension",
				pid: process.pid,
				theme: { name: theme!.name, sourcePath: theme!.sourcePath },
				stdio: "supervision-only; socket is sole user ingress",
			},
			unsupportedUI: [...o.unsupportedUI],
			systemPrompt: s.systemPrompt,
			autoCompactionEnabled: s.autoCompactionEnabled,
			cacheWarmingStatus: s.cacheWarmingStatus,
			steeringMode: s.steeringMode,
			followUpMode: s.followUpMode,
		};
	}
	function refresh(o: Owner) {
		if (closed) return;
		publishActivity();
		o.updateFooter?.();
		frame(o, "leaf", { leafId: o.sm.getLeafId() });
		frame(o, "live", { live: live(o) });
	}
	function snapshot(o: Owner) {
		return {
			type: "snapshot",
			sessionId: o.id,
			seq: o.seq,
			header: o.sm.getHeader(),
			entries: o.sm.getEntries(),
			leafId: o.sm.getLeafId(),
			live: live(o),
			uiState: [...o.uiState.values()],
			pendingRequests: [...o.pending.values()].map((p) => p.request),
			operations: [...o.operations.values()],
			control: o.control,
			sessionFile: o.sm.getSessionFile(),
			cwd,
		};
	}
	function take(o: Owner, c: Client) {
		refresh(o);
		o.control = {
			controllerClientId: c.id,
			controlGeneration: o.control.controlGeneration + 1,
		};
		frame(o, "control", { control: o.control });
		return o.control;
	}
	function fence(o: Owner, c: Client, p: RPCParams) {
		options.embedded?.check(p);
		if (
			o.control.controllerClientId !== c.id ||
			p.controlGeneration !== o.control.controlGeneration
		)
			throw Error("NOT_CONTROLLER_OR_STALE_GENERATION");
	}
	const services = createOwnerServices(api, {
			changed: () => queueMicrotask(() => refresh(o)),
			childEvent: (event) => frame(o, "childEvent", { event }),
			childFrame: (event) => frame(o, "childFrame", { event }),
			backgroundEvent: (event) => frame(o, "backgroundEvent", { event }),
		}),
		o = {
			api,
			loadedExtensions: loaded.extensions.map((e) => ({
				path: e.path,
				resolvedPath: e.resolvedPath,
			})),
			extensionErrors: [] as {
				timestamp: string;
				sessionId: string;
				extensionPath: string;
				event: string;
				error: string;
				stack?: string;
			}[],
			services,
			unsupportedUI: new Set<string>(),
			id: session.sessionId,
			session,
			sm,
			mr,
			seq: 0,
			pending: new Map<string, Pending>(),
			uiState: new Map<string, { method: string; args: unknown[] }>(),
			toolExecutions: new Map<string, ToolExecution>(),
			operations: new Map<string, Operation>(),
			control: {
				controllerClientId: null as string | null,
				controlGeneration: 0,
			},
			updateFooter: undefined as (() => void) | undefined,
			backgroundViews: new Map<string, BackgroundTaskPort>(),
			syncUIState: (_p: RPCParams) => true,
		};
	type Owner = typeof o;
	// Inspect only the already-loaded native owner once; never load a history for activity.
	let messageCount = sm.getEntries().filter((entry) => entry.type === "message").length;
	let contentRevision = 0;
	const ownerIncarnation = randomUUID();
	let activity: SessionActivity | undefined;
	let activityTimer: ReturnType<typeof setInterval> | undefined;
	function currentActivity(): SessionActivity {
		const counts = [activeCount(idleStatus.backgroundActiveCount), activeCount(idleStatus.subagentsActiveCount), activeCount(idleStatus.goalActiveCount)];
		const busy = session.isStreaming || session.isCompacting || !session.isIdle || o.pending.size > 0 || counts.some((n) => n !== null && n > 0);
		const working = busy ? true : counts.includes(null) ? null : false;
		if (!activity || activity.working !== working || activity.messageCount !== messageCount || activity.contentRevision !== contentRevision)
			activity = { sessionId: o.id, ownerIncarnation, revision: (activity?.revision ?? 0) + 1, working, messageCount, contentRevision };
		return activity;
	}
	function publishActivity() {
		if (closed) return;
		const previous = activity;
		const next = currentActivity();
		if (next !== previous)
			for (const c of clients) if (c.observesActivity) send(c, { type: "ownerActivity", activity: next });
	}
	sessions.set(o.id, o);
	const restores: (() => void)[] = [],
		original = sm._appendEntry;
	restores.push(() => {
		sm._appendEntry = original;
	});
	sm._appendEntry = function (entry) {
		const r = original.call(this, entry);
		if (entry.type === "message") {
			messageCount++;
			if (entry.message.role === "user" || entry.message.role === "assistant") contentRevision++;
		}
		frame(o, "append", { entry });
		if (entry.type === "message" && entry.message?.role === "toolResult")
			o.toolExecutions.delete(entry.message.toolCallId);
		queueMicrotask(() => refresh(o));
		return r;
	};
	const originalBranch = sm.branch,
		originalResetLeaf = sm.resetLeaf;
	restores.push(() => {
		sm.branch = originalBranch;
		sm.resetLeaf = originalResetLeaf;
	});
	sm.branch = function (...args: Parameters<SessionManager["branch"]>) {
		const result = originalBranch.apply(this, args);
		queueMicrotask(() => refresh(o));
		return result;
	};
	sm.resetLeaf = function (...args: Parameters<SessionManager["resetLeaf"]>) {
		const result = originalResetLeaf.apply(this, args);
		queueMicrotask(() => refresh(o));
		return result;
	};
	const unsubscribe = session.subscribe((event) => {
		const copy = structuredClone(event);
		queueMicrotask(() => {
			if (copy.type === "tool_execution_start")
				o.toolExecutions.set(copy.toolCallId, { start: copy });
			if (copy.type === "tool_execution_update") {
				const tool = o.toolExecutions.get(copy.toolCallId);
				if (tool) tool.update = copy;
			}
			if (copy.type === "tool_execution_end") {
				const tool = o.toolExecutions.get(copy.toolCallId);
				if (tool) tool.end = copy;
			}
			refresh(o);
			frame(o, "event", { event: copy });
		});
	});
	let editorText = "",
		toolsExpanded = false,
		workingMessage: string | undefined;
	const unsupported = (method: string) => {
			o.unsupportedUI.add(method);
			frame(o, "ui", {
				method: "notify",
				args: [`Unsupported remote UI feature: ${method}`, "warning"],
			});
		},
		emitUI = (method: string, args: unknown[]) => {
			if (method !== "notify")
				o.uiState.set(
					["setStatus", "setWidget", "ownedStatus"].includes(method)
						? method + ":" + String(args[0])
						: method,
					{
						method,
						args: args.map((value) => (value === undefined ? null : value)),
					},
				);
			frame(o, "ui", { method, args });
		};
	const uiContext: Partial<ExtensionUIContext> & Record<string, unknown> & { [ownedUI]?: OwnedUI } =
		{};
	uiContext[ownedUI] = {
		remote: true,
		present: (request) =>
			nativeOwnedPrompt(
				session.extensionRunner,
				request.label,
				() =>
					new Promise<void>((resolve, reject) => {
						if (closed) {
							reject(Error("OWNER_CLOSED"));
							return;
						}
						const id = randomUUID(),
							signal = request.signal;
						let off = () => {};
						const finish = () => {
							if (!o.pending.delete(id)) return;
							off();
							signal?.removeEventListener("abort", finish);
							o.backgroundViews.delete(id);
							frame(o, "interactionResolved", { requestId: id });
							resolve();
						};
						const wire = { id, kind: request.kind, args: [{ label: request.label }] };
						o.pending.set(id, { request: wire, resolve: finish });
						if (signal?.aborted) {
							finish();
							return;
						}
						try {
							if (request.kind === "background") {
								o.backgroundViews.set(id, request.port);
								off = request.port.subscribe(() =>
									frame(o, "presentationChanged", { requestId: id }),
								);
							}
						} catch (error) {
							o.pending.delete(id);
							o.backgroundViews.delete(id);
							reject(error);
							return;
						}
						signal?.addEventListener("abort", finish, { once: true });
						frame(o, "interaction", { request: wire });
					}),
			),
		footer: (read) => {
			let previous = "";
			o.updateFooter = () => {
				try {
					const data = read(),
						next = JSON.stringify(data);
					if (next !== previous) {
						previous = next;
						emitUI("ownedFooter", [data]);
					}
				} catch (error) {
					emitUI("notify", [errorMessage(error), "error"]);
				}
			};
			o.updateFooter();
		},
		status: (key, value) => {
			emitUI("ownedStatus", [key, value]);
			o.updateFooter?.();
		},
	};
	for (const method of [
		"notify",
		"setTitle",
		"setEditorText",
		"pasteToEditor",
		"setWorkingMessage",
		"setWorkingVisible",
		"setWorkingIndicator",
		"setHiddenThinkingLabel",
		"setToolsExpanded",
	] as const)
		uiContext[method] = (...args: unknown[]) => {
			if (args.some((v) => typeof v === "function")) {
				unsupported(method + "(factory)");
				return;
			}
			if (method === "setEditorText") editorText = String(args[0] ?? "");
			if (method === "pasteToEditor") editorText += String(args[0] ?? "");
			if (method === "setWorkingMessage") workingMessage = args[0] as string | undefined;
			if (method === "setToolsExpanded") toolsExpanded = !!args[0];
			emitUI(method, args);
		};
	uiContext.setStatus = (key, text) => {
		emitUI("setStatus", [key, text]);
		o.updateFooter?.();
	};
	uiContext.setWidget = (key, content, options) => {
		if (typeof content === "function") throw Error("OWNED_WIDGET_MUST_RENDER_ON_CLIENT");
		emitUI("setWidget", [key, content, options]);
	};
	uiContext.setFooter = (factory) => {
		if (factory) throw Error("OWNED_FOOTER_MUST_RENDER_ON_CLIENT");
		o.updateFooter = undefined;
		emitUI("setFooter", [undefined]);
	};
	uiContext.setHeader = (factory) => {
		if (factory) throw Error("OWNED_HEADER_MUST_RENDER_ON_CLIENT");
		emitUI("setHeader", [undefined]);
	};

	for (const kind of ["confirm", "input", "select", "editor"] as const)
		Object.assign(uiContext, {
			[kind]: (...args: unknown[]) =>
				new Promise<unknown>((resolve) => {
					if (closed) { resolve(kind === "confirm" ? false : undefined); return; }
					const options = args.find(
							(v) => v && typeof v === "object" && !Array.isArray(v) && "signal" in v,
						) as { signal?: AbortSignal } | undefined,
						signal = options?.signal,
						request = {
							id: randomUUID(),
							kind,
							args: args.map((v) => (v === options ? { ...options, signal: undefined } : v)),
						},
						cancel = () => finish(kind === "confirm" ? false : undefined),
						finish = (value: unknown) => {
							if (!o.pending.delete(request.id)) return;
							signal?.removeEventListener("abort", cancel);
							frame(o, "interactionResolved", { requestId: request.id });
							resolve(value);
						};
					o.pending.set(request.id, { request, resolve: finish });
					if (signal?.aborted) {
						cancel();
						return;
					}
					signal?.addEventListener("abort", cancel, { once: true });
					frame(o, "interaction", { request });
				}),
		});
	Object.assign(uiContext, {
		installClientEditor: (name: string) => {
			if (name !== "queued-up") throw Error("UNKNOWN_CLIENT_EDITOR");
			emitUI("installClientEditor", [name]);
		},
		theme,
		getEditorText: () => editorText,
		getEditorState: () => ({ text: editorText }),
		getEditorComponent: () => {
			return;
		},
		getToolsExpanded: () => toolsExpanded,
		getAllTools: () => session.getAllTools(),
		getTools: () => session.getAllTools(),
		setTools: (names: string[]) => session.setActiveToolsByName(names),
		getAllThemes: () => nativeUI!.getAllThemes(),
		getTheme: (name: string) => nativeUI!.getTheme(name),
		setTheme: () => ({
			success: false,
			error: "Remote theme switching unsupported",
		}),
		getWorkingMessage: () => workingMessage,
		setEditorComponent: () => unsupported("setEditorComponent(factory)"),
		addAutocompleteProvider: () => unsupported("addAutocompleteProvider(factory)"),
		setSessionName: (name: string) => session.setSessionName(name),
		setThinkingLevel: (level: AgentSession["thinkingLevel"]) => session.setThinkingLevel(level),
		custom: () =>
			Promise.reject(
				Error("OWNED_PRESENTATION_REQUIRED: custom factories never execute on the owner"),
			),
	});
	o.syncUIState = (p) => {
		if (typeof p.editorText === "string") editorText = p.editorText;
		if (typeof p.toolsExpanded === "boolean") toolsExpanded = p.toolsExpanded;
		return true;
	};
	function attachedClientCount(o: Owner, excludeId: string | null) {
		return new Set(
			[...clients]
				.filter(
					(other) => other.attached === o.id && !other.socket?.destroyed && other.id !== excludeId,
				)
				.map((other) => other.id),
		).size;
	}
	async function rpc(c: Client, method: string, p = {} as RPCParams) {
		if (method === "observeActivity") {
			publishActivity();
			c.observesActivity = true;
			// The idle bridge has getter-only async participants. Sample only an observed,
			// already-running owner; dedupe changes, with no SDK list/history reads.
			activityTimer ??= setInterval(publishActivity, 1000);
			activityTimer.unref();
			return currentActivity();
		}
		if (method === "list")
			return [...sessions.values()].map(
				(o): SessionDescription => ({
					attachedClientCount: attachedClientCount(
						o,
						typeof p.excludeClientId === "string" ? p.excludeClientId : c.id,
					),
					id: o.id,
					sessionId: o.id,
					sessionFile: o.sm.getSessionFile(),
					header: o.sm.getHeader(),
					leafId: o.sm.getLeafId(),
					name: o.sm.getSessionName(),
					cwd,
					messageCount,
					streaming: o.session.isStreaming,
					pendingRequests: o.pending.size,
					control: o.control,
				}),
			);
		if (method === "attach") {
			const o = sessions.get(p.sessionId);
			if (!o) {
				throw Error("NO_SESSION");
			}
			const count = attachedClientCount(o, c.id);
			if (p.ifUnoccupied && count > 0)
				throw Object.assign(new Error("CONTEXT_OCCUPIED"), {
					code: "CONTEXT_OCCUPIED",
					attachedClientCount: count,
				});
			// Admission and lease mutation must not yield between checking and attaching.

			c.attached = o.id;
			if (p.control && (!p.controlIfFree || !o.control.controllerClientId || o.control.controllerClientId === c.id)) take(o, c);

			const s = snapshot(o);

			send(c, s);
			return { sessionId: s.sessionId, seq: s.seq } satisfies AttachAck;
		}
		if (method === "create") throw Error("MANAGED_WORKER_REQUIRES_DAEMON");
		const o = sessions.get(c.attached!);
		if (!o) throw Error("ATTACH_FIRST");
		if (method === "takeControl") {
			await Promise.resolve();
			return take(o, c);
		}
		if (method === "releaseControl") {
			fence(o, c, p);
			o.control = {
				controllerClientId: null,
				controlGeneration: o.control.controlGeneration + 1,
			};
			frame(o, "control", { control: o.control });
			return o.control;
		}
		if (method === "get") return live(o);
		// Same sequence boundary and authoritative native history as the attach SSE snapshot.
		if (method === "snapshot") return snapshot(o);
		if (method === "operation") return o.operations.get(p.operationId) ?? null;
		if (method === "prepareFork") {
			if (!options.workerToken) throw Error("PREPARE_FORK_REQUIRES_MANAGED_WORKER");
			// The authenticated broker may clone for a watcher without taking source control.
			if (p.controlGeneration !== undefined && p.controlGeneration !== o.control.controlGeneration)
				throw Error("STALE_GENERATION");
			if (
				!session.isIdle ||
				session.isCompacting ||
				[...o.operations.values()].some((operation) => operation.status === "running")
			)
				throw Error("FORK_SOURCE_BUSY");
			if (typeof p.sessionDirectory !== "string" || !isAbsolute(p.sessionDirectory))
				throw Error("FORK_DIRECTORY_MUST_BE_ABSOLUTE");
			const manager = forkSession(session.sessionManager, p.leafId ?? sm.getLeafId(), {
				sessionDir: p.sessionDirectory,
			});
			const sessionFile = manager.getSessionFile();
			if (!sessionFile || !existsSync(sessionFile))
				throw Error(
					"PREASSISTANT_FORK_NOT_PERSISTED: native unflushed manager cannot be handed to another CLI; no manual history rewriting.",
				);
			const context = manager.buildSessionContext();
			return {
				sessionFile,
				sessionId: manager.getSessionId(),
				model: context.model,
				thinkingLevel: context.thinkingLevel,
			};
		}
		if (method === "fork") throw Error("MANAGED_WORKER_REQUIRES_DAEMON");
		if (method === "answer") {
			fence(o, c, p);
			const pending = o.pending.get(p.requestId);
			if (!pending) throw Error("UNKNOWN_OR_ALREADY_ANSWERED");
			if (pending.request.kind === "confirm" && typeof p.value !== "boolean")
				throw Error("INVALID_CONFIRM");
			if (isOwnedPresentation(pending.request.kind) && p.value != null)
				throw Error("INVALID_PRESENTATION_ANSWER");
			pending.resolve?.(p.value);
			return true;
		}
		if (["backgroundList", "backgroundStatus", "backgroundStop"].includes(method)) {
			fence(o, c, p);
			const port = o.backgroundViews.get(p.requestId);
			if (!port || o.pending.get(p.requestId)?.request.kind !== "background")
				throw Error("BACKGROUND_PRESENTATION_RETIRED");
			if (method === "backgroundList") return port.list();
			if (typeof p.id !== "string") throw Error("BACKGROUND_ID_REQUIRED");
			return method === "backgroundStatus" ? port.status(p.id) : port.stop(p.id);
		}

		if (method === "uiStateSync") {
			fence(o, c, p);
			return o.syncUIState(p);
		}
		if (method === "refreshCatalog") {
			const result = await o.mr.refresh();
			return {
				catalog: o.mr.getAvailableSnapshot(),
				aborted: result.aborted,
				errors: [...result.errors].map(([provider, error]) => [
					provider,
					String(error?.message ?? error),
				]),
			};
		}
		// Completion is a read of the attached owner's registered command, never a command
		// handler, prompt, provider refresh, or tool. Keep argument text in POST bodies.
		if (method === "commandCompletions") {
			if (p.sessionId !== o.id || typeof p.name !== "string" || p.name.length > 256 ||
				typeof p.prefix !== "string" || p.prefix.length > 4096) return null;
			const command = o.session.extensionRunner.getRegisteredCommands()
				.find((command) => command.invocationName === p.name);
			if (!command?.getArgumentCompletions) return null;
			try { return await command.getArgumentCompletions(p.prefix); }
			catch { return null; } // Typing must not display owner errors or reveal exception details.
		}
		if (method === "serviceRead") return await o.services.read(p);
		if (method === "serviceMutate") {
			fence(o, c, p);
			const operationId = randomUUID(),
				operation = {
					operationId,
					command: "service:" + p.service + ":" + p.operation,
					status: "running",
				};
			o.operations.set(operationId, operation);
			Promise.resolve()
				.then(() => { fence(o, c, p); return o.services.mutate(p, () => fence(o, c, p)); })
				.then(
					(value) => {
						Object.assign(operation, {
							status: "completed",
							value: value ?? null,
						});
					},
					(error: unknown) => {
						Object.assign(operation, {
							status: "failed",
							error: errorMessage(error),
						});
					},
				)
				.finally(() => {
					refresh(o);
					frame(o, "operation", { operation });
				});
			return { accepted: true, operationId };
		}
		if (method === "mutate") {
			fence(o, c, p);
			const args = p.args || [];
			if (["prompt", "steer", "followUp"].includes(p.command) && remoteLogin(args[0]))
				throw Error(REMOTE_LOGIN_UNSUPPORTED);
			// Management is local-client authority, never a forwarded worker slash command.
			const slashCommand =
				["prompt", "steer", "followUp"].includes(p.command) && typeof args[0] === "string"
					? /^\s*\/([^\s]+)(?:\s|$)/.exec(args[0])?.[1]
					: undefined;
			if (
				localManagementCommands.has(p.command) ||
				(slashCommand !== undefined && localManagementCommands.has(slashCommand))
			)
				throw Error("LOCAL_MANAGEMENT_ONLY");
			if (
				![
					"prompt",
					"abort",
					"steer",
					"followUp",
					"setModel",
					"changeModelScope",
					"setThinkingLevel",
					"cycleModel",
					"cycleThinkingLevel",
					"clearQueue",
					"navigateTree",
					"abortBranchSummary",
					"abortCompaction",
					"labelChange",
					"compact",
					"setSessionName",
				].includes(p.command)
			)
				throw Error("UNSUPPORTED_COMMAND");
			if (p.command === "setModel") {
				const m = args[0] as { provider: string; id: string };
				args[0] = o.mr.getModel(m.provider, m.id);
				if (!args[0]) throw Error("UNKNOWN_MODEL");
			}
			const operationId = randomUUID(),
				operation = { operationId, command: p.command, status: "running" };
			o.operations.set(operationId, operation);
			const pending = Promise.resolve()
				.then<unknown>(() => {
					options.embedded?.check(p);
					const override = options.embedded?.command(p.command, args, p);
					if (override) return override.value;
					switch (p.command) {
						case "labelChange":
							return o.sm.appendLabelChange(
								...(args as Parameters<SessionManager["appendLabelChange"]>),
							);
						case "prompt":
							return o.session.prompt(...(args as Parameters<AgentSession["prompt"]>));
						case "abort":
							return o.session.abort(...(args as Parameters<AgentSession["abort"]>));
						case "steer":
							return o.session.steer(...(args as Parameters<AgentSession["steer"]>));
						case "followUp":
							return o.session.followUp(...(args as Parameters<AgentSession["followUp"]>));
						case "changeModelScope":
							return changeModelScope(o.session, args[0], args[1], () => fence(o, c, p));
						case "setModel":
							return o.session.setModel(...(args as Parameters<AgentSession["setModel"]>));
						case "setThinkingLevel":
							return o.session.setThinkingLevel(
								...(args as Parameters<AgentSession["setThinkingLevel"]>),
							);
						case "cycleModel":
							return o.session.cycleModel(...(args as Parameters<AgentSession["cycleModel"]>));
						case "cycleThinkingLevel":
							return o.session.cycleThinkingLevel(
								...(args as Parameters<AgentSession["cycleThinkingLevel"]>),
							);
						case "clearQueue":
							return o.session.clearQueue(...(args as Parameters<AgentSession["clearQueue"]>));
						case "navigateTree":
							return o.session.navigateTree(...(args as Parameters<AgentSession["navigateTree"]>));
						case "abortBranchSummary":
							return o.session.abortBranchSummary(
								...(args as Parameters<AgentSession["abortBranchSummary"]>),
							);
						case "abortCompaction":
							return o.session.abortCompaction(
								...(args as Parameters<AgentSession["abortCompaction"]>),
							);
						case "compact":
							return o.session.compact(...(args as Parameters<AgentSession["compact"]>));
						case "setSessionName":
							return o.session.setSessionName(
								...(args as Parameters<AgentSession["setSessionName"]>),
							);
						default:
							throw Error("UNSUPPORTED_COMMAND");
					}
				})
				.then(
					(value) => {
						Object.assign(operation, {
							status: "completed",
							value: value ?? null,
						});
					},
					(error: unknown) => {
						Object.assign(operation, {
							status: "failed",
							error: errorMessage(error),
						});
					},
				)
				.finally(() => {
					refresh(o);
					frame(o, "operation", { operation });
				});
			options.embedded?.track?.(pending, p.command);
			return { accepted: true, operationId };
		}
		throw Error("UNKNOWN_METHOD");
	}
	const server = net.createServer((socket) => {
			socket.setEncoding("utf8");
			const c: Client = { socket, id: null, attached: null };
			clients.add(c);
			const framer = new LineFramer();
			socket.on("data", (b: string) => {
				for (const line of framer.push(b)) {
					let m: {
						id: string;
						method: string;
						params?: RPCParams & { clientId?: string };
					};
					try {
						m = JSON.parse(line);
					} catch {
						socket.destroy();
						return;
					}
					(async () => {
						try {
							if (m.method === "hello") {
								if (options.workerToken) {
									const supplied = m.params?.token;
									const expected = Buffer.from(options.workerToken);
									const actual =
										typeof supplied === "string" ? Buffer.from(supplied) : Buffer.alloc(0);
									if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
										throw Error("WORKER_AUTHENTICATION_FAILED");
								}
								c.id = String(m.params?.clientId || randomUUID());
								send(c, {
									replyTo: m.id,
									result: {
										clientId: c.id,
										protocol: 1,
										capabilities: { conditionalAttach: true, conditionalControl: true },
									},
								});
								return;
							}
							if (!c.id) throw Error("HELLO_FIRST");
							send(c, {
								replyTo: m.id,
								result: await rpc(c, m.method, m.params),
							});
						} catch (e) {
							send(c, {
								replyTo: m.id,
								error: errorMessage(e),
								...(e instanceof Error && "code" in e
									? {
											code: e.code,
											attachedClientCount: (e as Error & { attachedClientCount?: number })
												.attachedClientCount,
										}
									: {}),
							});
						}
					})();
				}
			});
			socket.on("close", () => {
				clients.delete(c);
				if (![...clients].some((client) => client.observesActivity)) {
					clearInterval(activityTimer);
					activityTimer = undefined;
				}
				const owner = c.attached ? sessions.get(c.attached) : undefined;
				if (
					owner &&
					c.id &&
					owner.control.controllerClientId === c.id &&
					![...clients].some(
						(other) =>
							other.id === c.id && other.attached === owner.id && !other.socket?.destroyed,
					)
				) {
					// A same-logical-client replacement preserves its lease. Otherwise release
					// control without touching ongoing operations or pending UI requests.
					owner.control = {
						controllerClientId: null,
						controlGeneration: owner.control.controlGeneration + 1,
					};
					frame(owner, "control", { control: owner.control });
				}
			});
			socket.on("error", () => {});
		}),
		oldReload = session.reload;
	if (!options.embedded) {
		session.reload = async () => {
			throw Error("RELOAD_UNSUPPORTED_WHILE_SESSION_LINK_ACTIVE");
		};
		restores.push(() => { session.reload = oldReload; });
	}
	function recordError(error: Parameters<NonNullable<Bindings["onError"]>>[0]) {
		const record = {
			timestamp: new Date().toISOString(),
			sessionId: o.id,
			extensionPath: error.extensionPath,
			event: error.event,
			error: String(error.error),
			stack: error.stack,
		};
		o.extensionErrors.push(record);
		console.error(JSON.stringify(record));
		frame(o, "ui", {
			method: "notify",
			args: [
				[record.extensionPath, record.event, record.error].filter(Boolean).join(": "),
				"error",
			],
		});
	}
	return {
		session,
		uiContext,
		bind(bindings: Bindings): Bindings {
			if (options.workerToken && bindings.commandContextActions) {
				const rejectReplacement = async (): Promise<never> => {
					throw Error(
						"MANAGED_WORKER_REQUIRES_DAEMON: create, fork, and session switching must be coordinated by the daemon.",
					);
				};
				bindings = {
					...bindings,
					commandContextActions: {
						...bindings.commandContextActions,
						newSession: rejectReplacement,
						fork: rejectReplacement,
						switchSession: rejectReplacement,
					},
				};
			}
			return {
				...bindings,
				uiContext: uiContext as ExtensionUIContext,
				mode: "tui",
				onError: (error) => {
					recordError(error);
					bindings.onError?.(error);
				},
			};
		},
		async start() {
			if (options.embedded) throw Error("EMBEDDED_OWNER_HAS_NO_LISTENER");
			if (started) return;
			if (closed) throw Error("OWNER_CLOSED");
			if (existsSync(socketPath)) throw Error("SOCKET_EXISTS: " + socketPath);
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			started = true;
			chmodSync(socketPath, 384);
			console.error(
				JSON.stringify({
					sessionLinkReady: true,
					pid: process.pid,
					socketPath,
					sessionId: o.id,
					owner: "normal-pi-cli",
				}),
			);
		},
		snapshot: () => snapshot(o),
		/** Only the already authenticated parent service may enter this port. */
		embeddedRequest(method: string, params: Record<string, unknown> = {}) {
			if (!options.embedded || closed) throw Error("EMBEDDED_OWNER_UNAVAILABLE");
			if (
				![
					"mutate",
					"answer",
					"backgroundList",
					"backgroundStatus",
					"backgroundStop",
					"uiStateSync",
					"operation",
					"refreshCatalog",
				].includes(method)
			)
				throw Error("UNSUPPORTED_CHILD_METHOD");
			options.embedded.check(params);
			o.control = { controllerClientId: "parent-service", controlGeneration: 0 };
			return rpc({ id: "parent-service", attached: o.id }, method, { ...params, controlGeneration: 0 } as RPCParams);
		},
		async close() {
			if (closed) return;
			closed = true;
			clearInterval(activityTimer);
			unsubscribe();
			services.close();
			for (const pending of [...o.pending.values()])
				pending.resolve?.(pending.request.kind === "confirm" ? false : undefined);
			for (const restore of restores) restore();
			for (const c of clients) {
				c.socket?.destroy();
			}
			if (started) await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
