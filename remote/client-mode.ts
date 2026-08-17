import type { LaunchProfile } from "./daemon-protocol.ts";
import type { ConnectionProfile } from "./connection-profile.ts";
import { runManagement, isManagementCommand, managementCompletions } from "./client-management.ts";
import { getLaunchProfile } from "./startup-policy.ts";
import { connect } from "./transport-client.ts";
import type { SessionDescription } from "./protocol.ts";
import {
	InteractiveMode,
	type AgentSession,
	type AgentSessionRuntime,
	type ExtensionAPI,
	type ExtensionCommandContext,
	SettingsManager,
	type AgentSessionEvent,
	type CustomEditor,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { bindIdleStatus } from "../shared/idle-status.ts";
import { sessionRetirementReasons } from "../shared/session-retirement.ts";
import { createClientConnection } from "./client-connection.ts";
import { prepareSessionView } from "./session-view.ts";
import { loadFreshSessionView } from "./client-extension-views.ts";
import { createClientReload } from "./client-reload.ts";
import type { ToolRenderers } from "../shared/tool-renderers.ts";

import type { TUI, Component, Focusable } from "@earendil-works/pi-tui";
import type { RemoteConnection } from "./client-connection.ts";
import type { IdleStatusBridge } from "../shared/idle-status.ts";

// Version-pinned native seams: no second InteractiveMode or executable owner is created.
type Public<T> = { [K in keyof T]: T[K] };
export type LocalSession = Omit<Public<AgentSession>, "extensionRunner" | "settingsManager"> & {
	extensionRunner: Public<AgentSession["extensionRunner"]> & {
		uiPromptDepth?: number;
		activeUIPrompt?: unknown;
	};
	settingsManager: Public<SettingsManager> & {
		storage?: { globalSettingsPath?: string; projectSettingsPath?: string };
	};
	_bashAbortControllers?: Set<AbortController>;
	_retryAbortController?: AbortController;
	_branchSummaryAbortController?: AbortController;
	_pendingNextTurnMessages?: unknown[];
	_pendingCustomMessages?: unknown[];
	_pendingBashMessages?: unknown[];
	_cacheWarmer?: object;
};
export interface NativeMode {
	session: LocalSession;
	runtimeHost: Omit<Public<AgentSessionRuntime>, "session"> & {
		session: LocalSession;
	} & { teardownCurrent(reason: "resume"): Promise<void> };
	ui: Pick<TUI, "terminal" | "addInputListener" | "requestRender">;
	editor: Pick<CustomEditor, "getText" | "setText" | "addToHistory">;
	defaultEditor: CustomEditor;
	footer: { invalidate(): void };
	themeController: { applyFromSettings(): Promise<void> };
	bindCurrentSessionExtensions(): Promise<void>;
	rebindCurrentSession(options: { renderBeforeBind: boolean }): Promise<void>;
	showError(message: string): void;
	showWarning(message: string): void;
	showStatus(message: string): void;
	setExtensionStatus(key: string, text: string | undefined): void;
	shutdown(): Promise<void>;
	handleEvent(
		event:
			| AgentSessionEvent
			| {
					type: "message_update";
					message: NonNullable<AgentSession["state"]["streamingMessage"]>;
			  },
	): Promise<void>;
	showTreeSelector(id: string): void;
	resetExtensionUI(): void;
	handleNameCommand(text: string): Promise<void>;
	handleClearCommand(): Promise<void>;
	handleReloadCommand(): Promise<void>;
	showSessionSelector(): Promise<void>;
	keybindings: KeybindingsManager;
	showSelector(
		factory: (done: () => void) => { component: Component; focus: Component & Focusable },
	): void;
	showExtensionSelector(title: string, labels: string[]): Promise<string | undefined>;
	showExtensionConfirm(title: string, message: string): Promise<boolean>;
	restoreQueuedMessagesToEditor(options?: {
		currentText?: string;
		abort?: boolean;
	}): Promise<number>;
	updatePendingMessagesDisplay(): void;
	handleDequeue(): Promise<void>;
	selectThinkingLevel(level: AgentSession["thinkingLevel"], persist: boolean): Promise<void>;
	cycleThinkingLevel(): Promise<void>;
	updateEditorBorderColor(): void;
	setupEditorSubmitHandler(): void;
	setupKeyHandlers(): void;
}
interface CaptureHook {
	modes: WeakMap<object, NativeMode>;
	original: NativeMode["bindCurrentSessionExtensions"];
	active: boolean;
	leases: { owner: number; host: number };
	restored: boolean;
	acquire(kind: "owner" | "host"): () => void;
}
interface AttachmentState {
	phase: string;
	hook: CaptureHook;
	releaseHost(): void;
	mode: NativeMode;
	originalMode: NativeMode;
	originalTerminal: NativeMode["ui"]["terminal"];
	localSession: LocalSession;
	originalManager: object;
	originalRuntime: NativeMode["runtimeHost"];
	blocked: Record<string, number>;
	retired: boolean;
	remote?: RemoteConnection;
	baselineEntries?: string;
	baselineFileHash?: string | null;
	baselineSettings?: string;
	settingsFileHashes?: [string, string | null][];
}
interface LocalOwnerState {
	serving: boolean;
	reasons?: string[];
	then?: unknown;
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
// Dynamic fencing only replaces named executable members with a function that never returns.
function fence(target: object, key: string, replacement: () => never) {
	if (!Reflect.set(target, key, replacement))
		throw new TypeError(`Cannot replace retired owner member ${key}`);
}

const hookKey = Symbol.for("pi.private.session-link.existing-tui-hook.v1");
const modesKey = Symbol.for("pi.private.session-link.native-tui-modes.v1");
const attachmentStates = new WeakMap<NativeMode, AttachmentState>();

/** Installed by the actual extension factory, before normal CLI TUI binding. */
export function installClientModeHooks() {
	const prototype = InteractiveMode.prototype as unknown as NativeMode & {
		[hookKey]?: CaptureHook;
		[modesKey]?: CaptureHook["modes"];
	};
	if (prototype[hookKey]) return prototype[hookKey];
	const original = prototype.bindCurrentSessionExtensions;
	if (typeof original !== "function" || typeof prototype.rebindCurrentSession !== "function") {
		throw Error("SESSION_LINK_UNSUPPORTED_SDK: existing InteractiveMode binding seam missing");
	}
	// Native /reload retains its SessionManager/TUI and rebinds the runner directly,
	// without calling bindCurrentSessionExtensions again. Association lifetime is
	// therefore the native objects' lifetime, not an extension owner's capture lease.
	const modes = prototype[modesKey] ?? new WeakMap<object, NativeMode>();
	if (!prototype[modesKey]) Object.defineProperty(prototype, modesKey, { value: modes });
	const hook: CaptureHook = {
		modes,
		original,
		active: true,
		leases: { owner: 0, host: 0 },
		restored: false,
		acquire: () => {
			throw Error("Hook not initialized");
		},
	};
	const wrapper = async function (
		this: NativeMode,
		...args: Parameters<NativeMode["bindCurrentSessionExtensions"]>
	) {
		if (hook.active && this.session?.sessionManager) modes.set(this.session.sessionManager, this);
		// Native command handling may add history before invoking extensions.
		for (const editor of [this.defaultEditor, this.editor]) {
			if (
				editor?.addToHistory &&
				!Reflect.get(editor, Symbol.for("pi.management-history-filter"))
			) {
				const add = editor.addToHistory.bind(editor);
				editor.addToHistory = (text) => {
					if (!isManagementCommand(text)) add(text);
				};
				Reflect.set(editor, Symbol.for("pi.management-history-filter"), true);
			}
		}
		return original.apply(this, args);
	};
	hook.acquire = (kind) => {
		if (!hook.active) throw Error("SESSION_LINK_CAPTURE_LEASE_RETIRED");
		hook.leases[kind]++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			hook.leases[kind]--;
			if (hook.leases.owner || hook.leases.host) return;
			hook.active = false;
			// Never overwrite a wrapper installed by somebody else after this one.
			if (prototype.bindCurrentSessionExtensions === wrapper) {
				prototype.bindCurrentSessionExtensions = original;
				hook.restored = true;
			}
			// If composed into another wrapper, this one remains inert in that chain.
			if (prototype[hookKey] === hook) delete prototype[hookKey];
		};
	};
	Object.defineProperty(prototype, hookKey, {
		value: hook,
		configurable: true,
	});
	prototype.bindCurrentSessionExtensions = wrapper;
	return hook;
}

function audit(state: AttachmentState, event: string, extra: Record<string, unknown> = {}) {
	const row = {
		event,
		time: new Date().toISOString(),
		...diagnostics(state),
		...extra,
	};
	const path = process.env.PI_SESSION_LINK_AUDIT;
	if (path) {
		if (!isAbsolute(path))
			throw Error("PI_SESSION_LINK_AUDIT must be an absolute private test-artifact path");
		appendFileSync(path, JSON.stringify(row) + "\n");
	}
}

function fileHash(path: string | undefined) {
	if (!path) return null;
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function diagnostics(state: AttachmentState | undefined) {
	if (!state) return { phase: "local" };
	return {
		phase: state.phase,
		localSessionAllocated: true,
		localSessionId: state.localSession.sessionId,
		localExecutorRetired: !!state.retired,
		sameInteractiveMode: state.mode === state.originalMode,
		postRebindCapturedSameMode: state.remote
			? state.hook.modes.get(state.remote.replica) === state.mode
			: undefined,
		sameTerminal: state.mode.ui.terminal === state.originalTerminal,
		captureHookActive: state.hook.active,
		captureHookRestored: state.hook.restored,
		captureLeases: { ...state.hook.leases },
		remoteSessionId: state.remote?.sessionId,
		replicaPersisted: state.remote?.replica.isPersisted(),
		blockedLocalAttempts: { ...state.blocked },
		localEntriesUnchanged:
			state.baselineEntries === undefined
				? undefined
				: JSON.stringify(state.localSession.sessionManager.getEntries()) === state.baselineEntries,
		localFileUnchanged:
			state.baselineFileHash === undefined
				? undefined
				: fileHash(state.localSession.sessionFile) === state.baselineFileHash,
		localSettingsUnchanged:
			state.baselineSettings === undefined
				? undefined
				: JSON.stringify([
						state.localSession.settingsManager.getGlobalSettings(),
						state.localSession.settingsManager.getProjectSettings(),
					]) === state.baselineSettings,
		localSettingsFilesUnchanged:
			state.settingsFileHashes === undefined
				? undefined
				: state.settingsFileHashes.every(([path, hash]) => fileHash(path) === hash),
	};
}

function assertLocalIdentity(state: AttachmentState) {
	if (
		state.mode.runtimeHost !== state.originalRuntime ||
		state.mode.session !== state.localSession ||
		state.mode.session.sessionManager !== state.originalManager
	) {
		throw Error(
			"CONNECT_LOCAL_REPLACED: the local session changed during preflight; no owner was retired and no remote control was taken",
		);
	}
}

function busyReasons(
	state: AttachmentState,
	{
		idle,
		localOwnerState,
		retirementReasons,
	}: {
		idle: IdleStatusBridge;
		localOwnerState(): LocalOwnerState;
		retirementReasons(): string[];
	},
) {
	const session = state.localSession;
	const runner = session.extensionRunner;
	const reasons = [];
	if (!session.isIdle || session.isStreaming || session.isCompacting)
		reasons.push("local agent/continuation or compaction is active");
	if (session.isBashRunning || session._bashAbortControllers?.size)
		reasons.push("local shell execution is active");
	if (session.retryAttempt || session._retryAbortController) reasons.push("local retry is active");
	if (session._branchSummaryAbortController) reasons.push("local branch summarization is active");
	if (session.pendingMessageCount) reasons.push("local steer/follow-up queue is nonempty");
	for (const key of [
		"_pendingNextTurnMessages",
		"_pendingCustomMessages",
		"_pendingBashMessages",
	] as const) {
		if (session[key]?.length) reasons.push(`local ${key} is nonempty`);
	}
	if (session.state.pendingToolCalls?.size) reasons.push("local tool calls are pending");
	if (runner.uiPromptDepth || runner.activeUIPrompt)
		reasons.push("a local extension dialog is pending");
	if (session.cacheWarmingStatus?.state === "refreshing")
		reasons.push("local cache warming is executing");
	for (const name of [
		"backgroundActiveCount",
		"subagentsActiveCount",
		"goalActiveCount",
	] as const) {
		const count = idle[name]?.() ?? 0;
		if (!Number.isFinite(count) || count < 0) reasons.push(`invalid owner busy count ${name}`);
		else if (count > 0) reasons.push(`${name}=${count}`);
	}
	const owner = localOwnerState();
	if (owner && typeof owner.then === "function")
		throw Error("getLocalOwnerState must be synchronous");
	if (owner?.serving)
		reasons.push("this local owner is already serving; stop its server before connecting");
	reasons.push(...(owner?.reasons ?? []), ...retirementReasons());
	return reasons;
}

/** Defense in depth AFTER native retirement. Never calls an original executor. */
function fenceRetiredOwner(state: AttachmentState) {
	const session = state.localSession;
	const deny = (category: string) =>
		function () {
			state.blocked[category] = (state.blocked[category] ?? 0) + 1;
			audit(state, "retired-local-attempt-blocked", { category });
			throw Error(
				`LOCAL_OWNER_RETIRED: ${category}; use the remote owner or start a new normal CLI`,
			);
		};
	for (const method of [
		"prompt",
		"sendUserMessage",
		"sendCustomMessage",
		"steer",
		"followUp",
		"clearQueue",
		"executeBash",
		"compact",
		"navigateTree",
		"setModel",
		"setThinkingLevel",
		"setSessionName",
		"cycleModel",
		"cycleThinkingLevel",
		"setScopedModels",
		"setActiveToolsByName",
		"setAutoCompactionEnabled",
		"setCacheWarmingMode",
		"setSteeringMode",
		"setFollowUpMode",
		"recordBashResult",
		"exportToHtml",
		"exportToJsonl",
		"reload",
	]) {
		fence(session, method, deny("session." + method));
	}
	for (const method of ["prompt", "continue", "steer", "followUp"])
		fence(session.agent, method, deny("agent." + method));
	fence(session.agent, "streamFn", deny("provider"));
	for (const tool of session.agent.state.tools ?? [])
		if (typeof tool.execute === "function") tool.execute = deny("tool." + tool.name);
	const manager = session.sessionManager;
	for (const method of [
		"_appendEntry",
		"_persist",
		"_rewriteFile",
		"setSessionFile",
		"_setSessionFile",
		"newSession",
		"branch",
		"resetLeaf",
		"branchWithSummary",
		"createBranchedSession",
	]) {
		fence(manager, method, deny("session-write." + method));
	}
	// Native dispose cancels the existing warmer; prevent any stale rearm hook.
	if (session._cacheWarmer) {
		for (const method of ["onAgentSettled", "onModeChanged", "schedule", "refresh"])
			fence(session._cacheWarmer, method, deny("cache-warming." + method));
	}
	for (const method of ["newSession", "fork", "switchSession", "importFromJsonl"])
		fence(state.originalRuntime, method, deny("local-lifecycle." + method));
	for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(session.settingsManager))) {
		if (
			/^(set|save|update|apply)/.test(key) &&
			typeof Reflect.get(session.settingsManager, key) === "function"
		)
			fence(session.settingsManager, key, deny("settings-write." + key));
	}
}

export interface ClientAttachOptions {
	profile?: LaunchProfile;
	connection?: ConnectionProfile;
	connectionName?: string;
	sessionId: string;
	takeover?: boolean;
	hello?: Record<string, unknown>;
}

export function registerClientCommands(
	pi: ExtensionAPI,
	{
		getLocalOwnerState = () => ({ serving: false }),
	}: {
		getLocalOwnerState?: (ctx?: ExtensionCommandContext) => LocalOwnerState;
	} = {},
) {
	const hook = installClientModeHooks();
	if (typeof hook.acquire !== "function")
		throw Error(
			"SESSION_LINK_OLD_CAPTURE_HOOK: restart the normal CLI to load the lease-aware extension",
		);
	const { modes } = hook;
	const releaseOwner = hook.acquire("owner");
	pi.on("session_shutdown", () => releaseOwner());
	const idle = bindIdleStatus(pi.events);
	// Scoped events are queried only before local retirement, never afterwards.
	const retirementReasons = () => sessionRetirementReasons(pi.events);

	const attach = async (
		mode: NativeMode,
		parsed: ClientAttachOptions,
		ctx?: ExtensionCommandContext,
	): Promise<void> => {
		if (!parsed.sessionId) throw Error("Session ID required");
		const previous = attachmentStates.get(mode);
		if (previous && previous.phase !== "local") {
			throw Error("An attachment transition already exists; /disconnect exits this client.");
		}
		if (typeof mode.runtimeHost.teardownCurrent !== "function") {
			throw Error("SESSION_LINK_UNSUPPORTED_SDK: native runtime retirement unavailable");
		}

		const state: AttachmentState = {
			phase: "preflight",
			hook,
			releaseHost: hook.acquire("host"),
			mode,
			originalMode: mode,
			originalTerminal: mode.ui.terminal,
			localSession: mode.session,
			originalManager: mode.session.sessionManager,
			originalRuntime: mode.runtimeHost,
			blocked: {},
			retired: false,
		};
		attachmentStates.set(mode, state);
		const localOwnerState = () => getLocalOwnerState(ctx);
		const guards = { idle, localOwnerState, retirementReasons };
		let releaseInput: (() => void) | undefined;
		let retirementStarted = false;
		const refreshConnectionStatus = () => {
			if (!state.retired) return;
			mode.setExtensionStatus(
				"remote.connection",
				state.remote?.changingSession ? "connecting…" : state.remote?.connected
					? `${state.remote.connectionName} · ${state.remote.isController ? "control" : "view"}`
					: "\u001b[3mdisconnected\u001b[23m",
			);
		};
		try {
			let reasons = busyReasons(state, guards);
			if (reasons.length) throw Error("CONNECT_LOCAL_BUSY: " + reasons.join("; "));
			audit(state, "watch-preflight-start");
			mode.showStatus("Connecting to session server…");
			state.remote = await createClientConnection({
				...parsed,
				onConnectionChange: refreshConnectionStatus,
				notify: (message) => mode.showWarning(String(message)),
			});
			if (
				state.remote.sessionId === state.localSession.sessionId ||
				state.remote.snapshot.header?.id === state.localSession.sessionId
			) {
				throw Error(
					"CONNECT_SELF_OWNER: cannot retire the owner being attached; use a separate normal CLI",
				);
			}
			const localProfile = getLaunchProfile(mode);
			const localSettings = state.localSession.settingsManager;
			const remote = state.remote;
			// Keep only presentation callbacks from the already-loaded client extensions.
			// Their startup-code lifetime deliberately survives owner retirement and
			// presentation reload; /reload does not hot-load renderer source. Tools
			// installed only on the remote owner retain the native generic fallback.
			const toolRenderers = new Map<string, ToolRenderers>();
			for (const { name } of state.localSession.getAllTools()) {
				const definition = state.localSession.getToolDefinition(name);
				if (!definition?.renderCall && !definition?.renderResult) continue;
				toolRenderers.set(name, {
					renderCall: definition.renderCall,
					renderResult: definition.renderResult,
					renderShell: definition.renderShell,
				});
			}
			// Capture the native submit setup once, before any presentation wrapper.
			// Reusing a previous wrapper would retain old driver code on every reload.
			const nativeSubmitSetup = mode.setupEditorSubmitHandler;
			let reload: ReturnType<typeof createClientReload>;
			let clientBindings: Parameters<AgentSession["bindExtensions"]>[0] | undefined;
			const readPresentationSettings = () => {
				// Read only the original client host's settings. Never reload the
				// retired resource loader or execute its extension/provider factories.
				const settings = SettingsManager.fromStorage(
					{
						withLock(scope, read) {
							const path =
								scope === "global"
									? localSettings.storage?.globalSettingsPath
									: localSettings.storage?.projectSettingsPath;
							let content: string | undefined;
							if (path) {
								try {
									content = readFileSync(path, "utf8");
								} catch (error) {
									if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
								}
							} else
								content = JSON.stringify(
									scope === "global"
										? mode.session.settingsManager.getGlobalSettings()
										: mode.session.settingsManager.getProjectSettings(),
								);
							if (read(content) !== undefined) throw Error("CLIENT_SETTINGS_READ_ONLY");
						},
					},
					{ projectTrusted: localSettings.isProjectTrusted() },
				);
				const errors = settings.drainErrors();
				if (errors.length)
					throw new AggregateError(
						errors.map((item) => item.error),
						"Client settings reload failed",
					);
				return { ...settings.getGlobalSettings(), ...settings.getProjectSettings() };
			};
			const viewOptions = (
				settingsSnapshot = {
					...mode.session.settingsManager.getGlobalSettings(),
					...mode.session.settingsManager.getProjectSettings(),
				},
			): Parameters<typeof prepareSessionView>[2] => ({
				settingsSnapshot,
				toolRenderers,
				resourceLoader: state.localSession.resourceLoader,
				services: {
					cwd: remote.replica.getCwd(),
					agentDir: state.originalRuntime.services.agentDir,
				},
				onReload: (options) => reload.reload(options),
				onBindings: (bindings) => {
					clientBindings = bindings;
					refreshConnectionStatus();
				},
				onManagement: (text) =>
					runManagement(text, {
						localProfile,
						showStatus: (message) => mode.showStatus(message),
						confirm: (title, message) => mode.showExtensionConfirm(title, message),
						connect: async (connection, launchProfile, name) => {
							const transition = await remote.switchServer(connection, launchProfile, name);
							if (transition) await reload.refreshPresentation();
							// Reconnecting Local never steals control. Different-server
							// selection retains the pre-existing explicit connect behavior.
							if (transition === "switch") await remote.request("takeover");
						},
					}),
				onDispose: () => {
					state.phase = "disconnected";
					state.releaseHost();
					audit(state, "client-disconnected");
				},
			});
			let installView = await prepareSessionView(mode, remote, viewOptions());
			const attach = () => installView();
			reload = createClientReload({
				mode,
				remote,
				capturePresentation: () => {
					const previous = installView;
					return async () => {
						// Failed preparation/installation restores only the old UI driver.
						// Its normal rebind replaces subscriptions, never stacks them.
						mode.resetExtensionUI();
						mode.setupEditorSubmitHandler = nativeSubmitSetup;
						await previous();
						installView = previous;
					};
				},
				prepareReload: async () => {
					const fresh = await loadFreshSessionView();
					const next = await fresh.prepareSessionView(
						mode,
						remote,
						viewOptions(readPresentationSettings()),
					);
					return async ({ nativeReload, beforeSessionStart }) => {
						if (nativeReload && !clientBindings) throw Error("Client UI bindings are unavailable");
						mode.setupEditorSubmitHandler = nativeSubmitSetup;
						await next(
							nativeReload ? { bindings: clientBindings!, beforeSessionStart } : undefined,
						);
						installView = next;
					};
				},
			});
			// Handshake/loading can yield; local /new or /resume can replace the owner.
			assertLocalIdentity(state);
			reasons = busyReasons(state, guards);
			if (reasons.length) throw Error("CONNECT_LOCAL_BUSY: " + reasons.join("; "));
			assertLocalIdentity(state);
			if (!state.remote.connected)
				throw Error("Remote disconnected during preflight; local owner unchanged");
			const draft = mode.editor.getText();
			releaseInput = mode.ui.addInputListener(() => ({ consume: true }));
			mode.showStatus(
				"Connecting: retiring the quiescent local owner; local input is briefly paused.",
			);
			state.phase = "retiring";
			retirementStarted = true;
			// Native lifecycle retires all original owner extensions/resources.
			// The attachment driver itself has a separate host/UI lifetime.
			await state.originalRuntime.teardownCurrent("resume");
			state.retired = true;
			state.baselineEntries = JSON.stringify(state.localSession.sessionManager.getEntries());
			state.baselineFileHash = fileHash(state.localSession.sessionFile);
			state.baselineSettings = JSON.stringify([
				localSettings.getGlobalSettings(),
				localSettings.getProjectSettings(),
			]);
			state.settingsFileHashes = [
				localSettings.storage?.globalSettingsPath,
				localSettings.storage?.projectSettingsPath,
			]
				.filter((path): path is string => !!path)
				.map((path) => [path, fileHash(path)]);
			fenceRetiredOwner(state);
			state.remote.clientDiagnostics = () => diagnostics(state);
			await attach();
			if (mode !== state.originalMode || mode.ui.terminal !== state.originalTerminal)
				throw Error("SESSION_LINK_IDENTITY_CHANGED");
			mode.editor.setText(draft);
			state.phase = "connected";
			audit(state, "connected-watch");
			// Explicit takeover is LAST, after local execution has ceased.
			if (parsed.takeover) {
				try {
					await state.remote.request("takeover");
					if (!ctx && !state.remote.isController)
						throw Error(
							"SESSION_LINK_CONTROL_REQUIRED: startup attachment did not acquire control",
						);
				} catch (error) {
					if (!ctx) throw error;
					mode.showWarning(`Takeover rejected; watching only. ${errorMessage(error)}`);
				}
			}
			mode.showStatus(
				`Connected existing TUI to ${state.remote.sessionId} (${state.remote.isController ? "control" : "watch"}). /disconnect exits only this client.`,
			);
			audit(state, "connect-complete");
		} catch (error) {
			state.remote?.close();
			if (!retirementStarted) {
				state.phase = "local";
				audit(state, "connect-rejected-local-unchanged", {
					error: errorMessage(error),
				});
			} else {
				state.phase = "failed-after-retirement";
				state.releaseHost();
				audit(state, "connect-failed-no-local-resurrection", {
					error: errorMessage(error),
				});
				// Never resume the retired execution domain as an accidental fallback.
				mode.runtimeHost = {
					...mode.runtimeHost,
					session: mode.session,
					services: mode.runtimeHost.services,
					dispose: async () => state.remote?.close(),
				};
				mode.showError(
					`Attachment failed after local retirement: ${errorMessage(error)}. Exiting this client; no draft replay.`,
				);
				if (ctx) await mode.shutdown();
			}
			throw error;
		} finally {
			releaseInput?.();
			if (state.phase !== "connected") state.releaseHost();
		}
		if (state.phase !== "connected" || !state.remote?.connected)
			throw Error("SESSION_LINK_ATTACH_FAILED: local execution must not resume");
	};

	let marker!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	for (const command of ["daemon", "remote"]) {
		const handler = async (args: string, ctx: ExtensionCommandContext) => {
			const mode = modes.get(ctx.sessionManager);
			if (!mode) {
				ctx.ui.notify("Native TUI required", "error");
				return;
			}
			mode.editor.setText("");
			try {
				await runManagement(`/${command} ${args}`, {
					localProfile: getLaunchProfile(mode),
					showStatus: (message) => mode.showStatus(message),
					confirm: (title, message) => mode.showExtensionConfirm(title, message),
					connect: async (connection, launchProfile, name) => {
						const client = await connect({ connection });
						try {
							const created = await client.request<SessionDescription>("create", launchProfile ? { profile: launchProfile } : {});
							await attach(
								mode,
								{
									connection,
									connectionName: name,
									profile: launchProfile,
									sessionId: created.sessionId,
									takeover: true,
								},
								ctx,
							);
						} finally {
							client.close();
						}
					},
				});
			} catch {
				mode.showError(
					"Local management command failed; check configuration and command syntax. Credentials were not retained.",
				);
			}
		};
		if (command === "daemon") marker = handler;
		pi.registerCommand(command, {
			getArgumentCompletions: (prefix) => managementCompletions(command, prefix),
			description:
				command === "daemon"
					? "Start, stop, restart, or connect to the local daemon"
					: "Manage local remote configuration and select a session server",
			handler,
		});
	}
	pi.registerCommand("disconnect", {
		description: "Exit this client without stopping a connected remote owner.",
		handler: async (_args, ctx) => {
			const mode = modes.get(ctx.sessionManager);
			const state = mode && attachmentStates.get(mode);
			if (state?.retired && mode) await mode.shutdown();
			else
				ctx.ui.notify(
					"Not connected. No local work was stopped; use /remote connect NAME.",
					"warning",
				);
		},
	});
	return {
		marker,
		attach,
		diagnostics: (manager: object) => {
			const mode = modes.get(manager);
			return diagnostics(mode ? attachmentStates.get(mode) : undefined);
		},
	};
}
