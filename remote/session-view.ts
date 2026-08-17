import { installModelScopeUI } from "./scope-ui.ts";
import { openSubagentsPanel } from "./subagents-panel.ts";
import { SessionSelectorComponent, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SessionDescription } from "./protocol.ts";
import { isManagementCommand, managementCompletions } from "./client-management.ts";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { ClientReloadOptions } from "./client-reload.ts";
import type { NativeMode } from "./client-mode.ts";
import type {
	RemoteConnection,
	RequestParams,
	LifecycleParams,
	CatalogResult,
} from "./client-connection.ts";
import { errorMessage, type InteractionRequest } from "./protocol.ts";
type PresentationCommand = Pick<SlashCommandInfo, "name"> &
	Partial<Omit<SlashCommandInfo, "name">> & { invocationName?: string; argumentCompletions?: boolean };
type Bindings = Parameters<AgentSession["bindExtensions"]>[0];
type NativeViewMethods = Pick<
	AgentSession,
	| "clearQueue"
	| "setModel"
	| "setThinkingLevel"
	| "cycleModel"
	| "cycleThinkingLevel"
	| "navigateTree"
	| "abortBranchSummary"
	| "abortCompaction"
	| "compact"
	| "setSessionName"
	| "getUserMessagesForForking"
>;
type AsyncMethod<T> = T extends (...args: infer Args) => infer Result
	? (...args: Args) => Promise<Awaited<Result>>
	: never;
type ViewMethods = {
	[K in Exclude<keyof NativeViewMethods, "getUserMessagesForForking">]: AsyncMethod<
		NativeViewMethods[K]
	>;
} & Pick<NativeViewMethods, "getUserMessagesForForking">;
import {
	SettingsManager,
	type AgentSession,
	type ExtensionUIContext,
	type SessionMessageEntry,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { openRemoteBackground } from "./background-panel.ts";
import { createStatusFooter, type StatusFooterData } from "../status/footer.ts";
import {
	renderOwnedStatus,
	remoteLogin,
	REMOTE_LOGIN_UNSUPPORTED,
	type OwnedStatus,
} from "../shared/owned-ui.ts";
import { loadClientViews } from "./client-extension-views.ts";
import type { ToolRenderers } from "../shared/tool-renderers.ts";
// Prepare presentation data while the original native owner is still valid.
// The returned installer operates on that SAME already-running CLI mode.
export async function prepareSessionView(
	mode: NativeMode,
	remote: RemoteConnection,
	{
		settingsSnapshot,
		toolRenderers = new Map<string, ToolRenderers>(),
		resourceLoader,
		services,
		onDispose = () => {},
		onReload,
		onBindings,
		onManagement,
	}: {
		settingsSnapshot: Parameters<typeof SettingsManager.inMemory>[0];
		toolRenderers?: ReadonlyMap<string, ToolRenderers>;
		resourceLoader: AgentSession["resourceLoader"];
		services: { cwd: string; agentDir: string };
		onDispose?: () => void | Promise<void>;
		onReload?: (options?: ClientReloadOptions) => Promise<void>;
		onBindings?: (bindings: Bindings) => void;
		onManagement?: (text: string) => Promise<void>;
	},
) {
	if (typeof remote.holdUI !== "function")
		throw Error(
			"Client relaunch required to load session admission UI support; the existing connection is unchanged",
		);
	const settings = SettingsManager.inMemory({
		...settingsSnapshot,
		cacheWarming: "off",
	});
	const loader = resourceLoader;
	const clientViews = await loadClientViews();
	return async function attachExistingMode(reload?: ClientReloadOptions & { bindings: Bindings }) {
		clientViews.reset();
		let binding: Bindings;
		let ownedFooter: StatusFooterData | undefined,
			footerUI: ExtensionUIContext | undefined,
			redrawFooter: (() => void) | undefined;
		const current = () => remote.current;
		const notify = (text: unknown) => mode?.showWarning(String(text));
		const unsupported = (name: string) => {
			notify(
				`${name} is unavailable in this client. Use /hotkeys for keyboard help, /resume for sessions, or /remote connect local|NAME to select a server.`,
			);
		};
		const commands = [
			"daemon",
			"remote",
			"disconnect",
			"control",
			"watch",
			"abort",
			"steer",
			"followup",
		];
		const serverCommands = () =>
			(current().commands ?? [])
				.map((c): PresentationCommand => (typeof c === "string" ? { name: c } : c))
				.filter((c) => typeof c.name === "string" && (c.invocationName ?? c.name) !== "reload");
		const isServerCommand = (name: string) =>
			serverCommands().some((c) => (c.invocationName ?? c.name) === name);
		const commandList = () =>
			[
				...commands.map((name) => ({
					name,
					description: "Client connection and session control",
					invocationName: name,
					sourceInfo: undefined,
					source: undefined,
					argumentCompletions: false,
				})),
				...serverCommands(),
			].map((c) => ({
				...c,
				invocationName: c.invocationName ?? c.name,
				sourceInfo: {
					path: c.sourceInfo?.path ?? "remote",
					source: c.sourceInfo?.source ?? c.source ?? "remote",
					scope: c.sourceInfo?.scope ?? "temporary",
				},
				description: c.description ?? "Server extension command",
				getArgumentCompletions: c.name === "daemon" || c.name === "remote"
					? (prefix: string) => managementCompletions(c.name, prefix)
					: !c.argumentCompletions ? undefined : async (prefix: string): Promise<AutocompleteItem[] | null> => {
						const sessionId = remote.sessionId, server = remote.serverIdentity;
						try {
							const result = await remote.customRequest<AutocompleteItem[] | null>("commandCompletions", {
								sessionId, name: c.invocationName ?? c.name, prefix,
							});
							return remote.connected && remote.sessionId === sessionId && remote.serverIdentity === server ? result : null;
						} catch { return null; }
					},
				handler: async () => {},
			}));
		const registry = {
			getRegisteredCommands: commandList,
			getCommandDiagnostics: () => [],
			getShortcutDiagnostics: () => [],
			getShortcuts: () => new Map(),
			getMarkdownTransformers: () => [],
			getEntryRenderer: clientViews.getEntryRenderer,
			getMessageRenderer: clientViews.getMessageRenderer,
			getModelRegistry: () => catalog,
			getCommand: (name: string) => commandList().find((c) => c.name === name),
		};
		const catalog = {
			getAvailableSnapshot: () => current().catalog ?? [],
			getAvailable: async () => current().catalog ?? [],
			getModel: (provider: string, id: string) =>
				(current().catalog ?? []).find((m) => m.provider === provider && m.id === id),
			getProviders: () => [...new Set((current().catalog ?? []).map((m) => m.provider))],
			isUsingSubscription: (provider: string) =>
				(current().subscriptionProviders ?? []).includes(provider),
			getError: () => current().catalogError,
			refresh: async ({ signal }: { signal?: AbortSignal } = {}) => {
				signal?.throwIfAborted();
				const r = await remote.request<CatalogResult>("refreshCatalog");
				signal?.throwIfAborted();
				return { ...r, errors: new Map(r.errors ?? []) };
			},
		};
		const mutate = async <Result = unknown>(
			method: string,
			args: RequestParams = {},
		): Promise<Result> => {
			try {
				return await remote.request<Result>(method, args);
			} catch (e) {
				notify(
					`${errorMessage(e)}. Draft was not replayed. Use /control to explicitly take control, /watch to watch, or reconnect to a forked session.`,
				);
				throw e;
			}
		};
		const view = {
			...({} as ViewMethods),
			settingsManager: settings,
			get sessionManager() {
				return remote.replica;
			},
			resourceLoader: loader,
			modelRuntime: catalog,
			extensionRunner: registry,
			get scopedModels() { return current().scopedModels ?? []; },
			sessionFile: undefined,
			get sessionId() {
				return remote.sessionId;
			},
			get isStreaming() {
				return current().streaming;
			},
			get isIdle() {
				return current().idle;
			},
			get isCompacting() {
				return current().compacting;
			},
			get isBashRunning() {
				return current().bashRunning ?? false;
			},
			get model() {
				return current().model;
			},
			get thinkingLevel() {
				return current().thinking;
			},
			get retryAttempt() {
				return current().retryAttempt;
			},
			get autoCompactionEnabled() {
				return current().autoCompactionEnabled;
			},
			get cacheWarmingStatus() {
				return current().cacheWarmingStatus;
			},
			get systemPrompt() {
				return current().systemPrompt;
			},
			get steeringMode() {
				return current().steeringMode;
			},
			get followUpMode() {
				return current().followUpMode;
			},
			get pendingMessageCount(): number {
				return this.getSteeringMessages().length + this.getFollowUpMessages().length;
			},
			get state(): Pick<
				AgentSession["state"],
				"thinkingLevel" | "messages" | "pendingToolCalls"
			> & {
				model: AgentSession["model"];
				streamingMessage: AgentSession["state"]["streamingMessage"] | null;
			} {
				return {
					model: this.model,
					thinkingLevel: this.thinkingLevel,
					messages: remote.replica.buildSessionContext().messages,
					streamingMessage: current().partial,
					pendingToolCalls: new Set(current().pendingTools ?? []),
				};
			},
			get messages(): AgentSession["messages"] {
				return this.state.messages;
			},
			getContextUsage: () => current().contextUsage,
			getAvailableThinkingLevels: () => current().thinkingLevels ?? [],
			getSteeringMessages: () => current().steering ?? [],
			getFollowUpMessages: () => current().followUp ?? [],
			getSessionStats: () => current().stats,
			promptTemplates: [],
			// Captured client presentation only, never wire metadata or executors.
			// Native Pi still merges built-in renderers and supplies unknown-tool fallback.
			getToolDefinition: (name: string) => toolRenderers.get(name),
			getActiveToolNames: () => (current().tools ?? []).map((t) => t.name),
			subscribe: (f: Parameters<RemoteConnection["subscribe"]>[0]) => remote.subscribe(f),
			bindExtensions: async (b: Bindings) => {
				binding = b;
				onBindings?.(b);
				if (remote.changingSession) refreshTransitionStatus();
			},
			reload: async (options?: ClientReloadOptions) => {
				if (!onReload) throw Error("Client presentation reload is unavailable");
				await onReload(options);
			},
			prompt: async (text: string, options?: Parameters<AgentSession["prompt"]>[1]) => {
				if (remoteLogin(text)) throw Error(REMOTE_LOGIN_UNSUPPORTED);
				// Native /reload is exact and local. Malformed variants must never
				// fall through as a server prompt/extension command.
				if (/^\/reload(?:\s|$)/.test(text.trim())) throw Error("Usage: /reload");
				try {
					return await mutate("prompt", { text, options });
				} catch (e) {
					mode.editor.setText(text);
					throw e;
				}
			},
			abort: () => mutate("abort"),
			steer: (text: string) => mutate("steer", { text }),
			followUp: (text: string) => mutate("followUp", { text }),
			getLastAssistantText: () => {
				const m = [...view.messages].reverse().find((m) => m.role === "assistant");
				return m?.content
					?.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("");
			},
		};
		// Guard keyboard-accessible operations too: they must never execute locally.
		for (const name of [
			"abortBash",
			"abortBranchSummary",
			"abortCompaction",
			"abortRetry",
			"compact",
			"cycleModel",
			"cycleThinkingLevel",
			"executeBash",
			"exportToHtml",
			"exportToJsonl",
			"navigateTree",
			"setAutoCompactionEnabled",
			"setCacheWarmingMode",
			"setFollowUpMode",
			"setModel",
			"setScopedModels",
			"setSessionName",
			"setSteeringMode",
			"setThinkingLevel",
			"recordBashResult",
		])
			Reflect.set(view, name, () => unsupported(name));
		view.clearQueue = () =>
			mutate<Awaited<ReturnType<ViewMethods["clearQueue"]>>>("clearQueue", {
				args: [],
			});
		view.setModel = (model, options) =>
			mutate<Awaited<ReturnType<ViewMethods["setModel"]>>>("setModel", {
				args: [{ provider: model.provider, id: model.id }, options],
			});
		view.setThinkingLevel = (level, options) =>
			mutate<Awaited<ReturnType<ViewMethods["setThinkingLevel"]>>>("setThinkingLevel", {
				args: [level, options],
			});
		view.cycleModel = async (direction) =>
			(await mutate<Awaited<ReturnType<ViewMethods["cycleModel"]>>>("cycleModel", {
				args: [direction],
			})) ?? undefined;
		view.cycleThinkingLevel = () =>
			mutate<Awaited<ReturnType<ViewMethods["cycleThinkingLevel"]>>>("cycleThinkingLevel", {
				args: [],
			});
		view.navigateTree = (id, options) =>
			mutate<Awaited<ReturnType<ViewMethods["navigateTree"]>>>("navigateTree", {
				args: [id, options],
			});
		view.abortBranchSummary = () =>
			mutate<Awaited<ReturnType<ViewMethods["abortBranchSummary"]>>>("abortBranchSummary", {
				args: [],
			});
		view.abortCompaction = () =>
			mutate<Awaited<ReturnType<ViewMethods["abortCompaction"]>>>("abortCompaction", { args: [] });
		view.compact = (instructions) =>
			mutate<Awaited<ReturnType<ViewMethods["compact"]>>>("compact", {
				args: [instructions],
			});
		view.setSessionName = (name) =>
			mutate<Awaited<ReturnType<ViewMethods["setSessionName"]>>>("setSessionName", {
				args: [name],
			});
		view.getUserMessagesForForking = () =>
			remote.replica
				.getEntries()
				.filter(
					(
						e,
					): e is SessionMessageEntry & {
						message: Extract<SessionMessageEntry["message"], { role: "user" }>;
					} => e.type === "message" && e.message.role === "user",
				)
				.map((e) => ({
					entryId: e.id,
					text:
						typeof e.message.content === "string"
							? e.message.content
							: e.message.content
									.filter((p) => p.type === "text")
									.map((p) => p.text)
									.join(""),
				}))
				.filter((e) => e.text);
		const hookReplica = () => {
			// Native label callback is fire-and-forget here; the authoritative append arrives over transport.
			const replica = remote.replica as unknown as {
				appendLabelChange(id: string, label: string | undefined): void;
			};
			replica.appendLabelChange = (id, label) => {
				void mutate("labelChange", { args: [id, label] })
					.then(() => mode.ui.requestRender())
					.catch(() => {
						mode.showTreeSelector(id);
						mode.showWarning(
							"Label change rejected; tree restored from authoritative session state.",
						);
					});
			};
		};
		const hydrate = async () => {
			hookReplica();
			const partial = current().partial;
			if (partial) {
				await mode.handleEvent({ type: "message_start", message: partial });
				await mode.handleEvent({
					type: "message_update",
					message: current().partial!,
				});
			}
			for (const tool of current().toolExecutions ?? []) {
				await mode.handleEvent(tool.start);
				if (tool.update) await mode.handleEvent(tool.update);
				if (tool.end) await mode.handleEvent(tool.end);
			}
			if (current().streaming) await mode.handleEvent({ type: "turn_start" });
		};
		let beforeInvalidate: (() => void) | undefined, rebind: (() => Promise<void>) | undefined;
		let resumePending = false;
		const refreshTransitionStatus = () => {
			mode.setExtensionStatus(
				"remote.connection",
				remote.changingSession
					? "connecting…"
					: remote.connected
						? `${remote.connectionName} · ${remote.isController ? "control" : "view"}`
						: "\u001b[3mdisconnected\u001b[23m",
			);
		};
		const changeSession = async (
			method: string,
			params: LifecycleParams = {},
			fromResume = false,
		) => {
			if (remote.changingSession || (resumePending && !fromResume))
				throw Error("A session transition is already in progress");
			const previousReplica = remote.replica;
			// Snapshots can arrive before the HTTP acknowledgement. Fence input and
			// hold remote UI/answers, but leave the old presentation intact until
			// admission succeeds. A rejected conditional attach changes nothing.
			const releaseInput = mode.ui.addInputListener(() => ({ consume: true }));
			const releaseUI = remote.holdUI();
			remote.changingSession = true;
			let rebinding = false;
			const installCurrent = async () => {
				rebinding = true;
				remote.beginRebind();
				beforeInvalidate?.();
				clientViews.reset();
				await rebind?.();
				await hydrate();
			};
			try {
				mode.showStatus("Connecting to session…");
				refreshTransitionStatus();
				const result = await remote.lifecycle(method, params);
				await installCurrent();
				mode.showStatus("Connected to session.");
				return result;
			} catch (e) {
				try {
					if (rebinding) {
						await rebind?.();
						await hydrate();
					} else if (remote.replica !== previousReplica) {
						// If a canonical snapshot already committed despite a later error,
						// show that attachment rather than reviving a stale presentation.
						await installCurrent();
					}
				} finally {
					mode.showStatus("Session connection did not complete.");
				}
				throw e;
			} finally {
				try {
					if (rebinding) await remote.endRebind();
				} catch (error) {
					mode.showStatus("Session connection did not complete.");
					throw error;
				} finally {
					try {
						releaseUI();
					} finally {
						remote.changingSession = false;
						try {
							refreshTransitionStatus();
						} finally {
							releaseInput();
						}
					}
				}
			}
		};
		const resumeSession = async (params: LifecycleParams) => {
			if (resumePending || remote.changingSession)
				throw Error("A session selection is already in progress");
			resumePending = true;
			// Keep server UI from replacing the local chooser while deciding. This
			// hold is nondestructive: Cancel releases it without replaying UI state.
			const releaseUI = remote.holdUI();
			try {
				try {
					// Presence in the picker can become stale. Admission is atomic at
					// the owner, counting watchers too, without changing the old lease.
					return await changeSession(
						"resume",
						{
							...params,
							control: true,
							ifUnoccupied: true,
						},
						true,
					);
				} catch (error) {
					if (!/^CONTEXT_OCCUPIED\b/.test(errorMessage(error))) throw error;
				}
				mode.showStatus("Session already attached; choose how to connect.");
				const choice = await mode.showExtensionSelector("Another client is attached", [
					"Take control",
					"Watch",
					"Fork",
					"Cancel",
				]);
				if (choice === undefined || choice === "Cancel") {
					mode.showStatus("Resume cancelled.");
					return { cancelled: true };
				}
				await changeSession(
					"resume",
					{
						...params,
						control: choice === "Take control",
						ifUnoccupied: false,
					},
					true,
				);
				if (choice === "Fork") {
					try {
						return await changeSession("fork", {}, true);
					} catch (error) {
						throw Error(
							`Fork failed; watching the selected source session. ${errorMessage(error)}`,
						);
					}
				}
				return { cancelled: false };
			} finally {
				resumePending = false;
				releaseUI();
			}
		};
		const runtime = {
			session: view,
			services: {
				get cwd() {
					return remote.replica.getCwd();
				},
				agentDir: services.agentDir,
			},
			diagnostics: [],
			setBeforeSessionInvalidate: (f: () => void) => {
				beforeInvalidate = f;
			},
			setRebindSession: (f: () => Promise<void>) => {
				rebind = f;
			},
			newSession: () => changeSession("new"),
			fork: async (entryId: string, options: { position?: "at" | "before" } = {}) => {
				const entry = remote.replica.getEntry(entryId);
				if (!entry) throw Error("Fork entry not found");
				const at = options.position === "at";
				const selectedText = at
					? ""
					: (view.getUserMessagesForForking().find((e) => e.entryId === entryId)?.text ?? "");
				const result = await changeSession("fork", {
					leafId: at ? entryId : entry.parentId,
				});
				return { ...result, selectedText };
			},
			switchSession: (id: string, options: { control?: boolean } = {}) =>
				options.control === undefined
					? resumeSession({ sessionId: id })
					: changeSession("resume", { sessionId: id, control: options.control }),
			dispose: async () => {
				remote.close();
				await onDispose();
			},
		};
		// Native InteractiveMode consumes a presentation-only structural runtime at this pinned seam.
		mode.runtimeHost = runtime as unknown as NativeMode["runtimeHost"];
		beforeInvalidate = () => mode.resetExtensionUI();
		rebind = async () => {
			await mode.rebindCurrentSession({ renderBeforeBind: true });
			// Remote switches retain this TUI and its in-memory settings. Reapplying
			// the same theme probes the terminal and invalidates the entire transcript
			// a second time. Native theme notifications and explicit UI theme changes
			// remain active without repeating that initialization on every attachment.
		};
		mode.handleNameCommand = async (text) => {
			const name = text.replace(/^\/name\s*/, "").trim();
			if (!name) {
				mode.showStatus(
					view.sessionManager.getSessionName()
						? `Session name: ${view.sessionManager.getSessionName()}`
						: "Usage: /name <name>",
				);
				return;
			}
			try {
				await view.setSessionName(name);
				mode.showStatus(`Session name set: ${view.sessionManager.getSessionName() ?? name}`);
			} catch (e) {
				mode.editor.setText(text);
				mode.showError(errorMessage(e));
			}
		};
		mode.handleClearCommand = async () => {
			try {
				await runtime.newSession();
				mode.showStatus("New server-owned session started");
			} catch (e) {
				mode.showError(errorMessage(e));
			}
		};
		mode.showSessionSelector = async () => {
			const listed = new Map<string, SessionDescription>();
			const load = async (): Promise<SessionInfo[]> => {
				mode.showStatus("Loading sessions…");
				let sessions: SessionDescription[];
				try {
					sessions = await remote.listSessions();
					mode.showStatus("Choose a session to connect.");
				} catch (error) {
					mode.showStatus("Could not load sessions.");
					throw error;
				}
				return sessions.map((s) => {
					const path = s.sessionFile ?? s.id;
					listed.set(path, s);
					return {
						path,
						id: s.id,
						cwd: "", // No working-directory labels in this HOME-only picker.
						name: s.name,
						parentSessionPath: s.parentSessionPath,
						created: new Date(s.created ?? 0),
						modified: new Date(s.modified ?? 0),
						messageCount: s.messageCount ?? 0,
						firstMessage: s.firstMessage ?? "",
						allMessagesText: s.allMessagesText ?? s.firstMessage ?? "",
					};
				});
			};
			mode.showSelector((done) => {
				const selector = new SessionSelectorComponent(
					load,
					load,
					(path) => {
						done();
						void (async () => {
							const selected = listed.get(path);
							if (!selected) throw Error("Selected session is no longer listed");
							const result = await resumeSession({
								sessionId: selected.id,
								fileIdentity: selected.fileIdentity,
								profile: remote.resumeProfile(selected),
							});
							if (!result.cancelled) mode.showStatus("Resumed session");
						})().catch((e) => {
							mode.showStatus("Could not resume the selected session.");
							mode.showError(errorMessage(e));
						});
					},
					() => {
						done();
						mode.showStatus("Resume cancelled.");
						mode.ui.requestRender();
					},
					() => {
						done();
						void mode.shutdown();
					},
					() => mode.ui.requestRender(),
					{ keybindings: mode.keybindings, showRenameHint: false },
					remote.snapshot.sessionFile,
				);
				// The native picker normally deletes files itself. A replica must never
				// write history or bypass daemon ownership/control fencing.
				const list = selector.getSessionList();
				// Keep native search/selection, without its directory-scope chrome.
				list.onToggleScope = undefined;
				// SDK generic empty-state text is coupled to its all-scope rendering.
				// Use that text, with no cwd labels or directory switching.
				const setSessions = list.setSessions.bind(list);
				list.setSessions = (sessions) => setSessions(sessions, true);
				list.setSessions([], true);
				selector.clear();
				selector.addChild(new Text("Resume session", 0, 1));
				selector.addChild(list);
				list.onDeleteSession = async () => {
					list.onError?.("Session deletion is unavailable from a watching client");
				};
				return { component: selector, focus: selector };
			});
		};
		mode.restoreQueuedMessagesToEditor = async (options = {}) => {
			try {
				const q = await view.clearQueue();
				const texts = [...(q.steering ?? []), ...(q.followUp ?? [])];
				if (texts.length)
					mode.editor.setText(
						[...texts, options.currentText ?? mode.editor.getText()]
							.filter((t) => t.trim())
							.join("\n\n"),
					);
				mode.updatePendingMessagesDisplay();
				if (options.abort) await view.abort();
				return texts.length;
			} catch (e) {
				mode.showError(errorMessage(e));
				return 0;
			}
		};
		mode.handleDequeue = async () => {
			const count = await mode.restoreQueuedMessagesToEditor();
			mode.showStatus(
				count ? `Restored ${count} queued messages to editor` : "No queued messages to restore",
			);
		};
		mode.selectThinkingLevel = async (level, persist) => {
			try {
				await view.setThinkingLevel(level, { persist });
				mode.footer.invalidate();
				mode.updateEditorBorderColor();
				mode.showStatus(`Thinking level: ${view.thinkingLevel}`);
			} catch (e) {
				mode.showError(errorMessage(e));
			}
		};
		mode.cycleThinkingLevel = async () => {
			try {
				const level = await view.cycleThinkingLevel();
				mode.footer.invalidate();
				mode.updateEditorBorderColor();
				mode.showStatus(
					level == null ? "Current model does not support thinking" : `Thinking level: ${level}`,
				);
			} catch (e) {
				mode.showError(errorMessage(e));
			}
		};
		const setup = mode.setupEditorSubmitHandler.bind(mode);
		mode.setupEditorSubmitHandler = () => {
			setup();
			const stock = mode.defaultEditor.onSubmit;
			mode.defaultEditor.onSubmit = async (text) => {
				if (remoteLogin(text)) {
					mode.showError(REMOTE_LOGIN_UNSUPPORTED);
					return;
				}
				const trimmed = text.trim(),
					[cmd = "", ...rest] = trimmed.split(/\s+/),
					args = rest.join(" ");
				try {
					if (isManagementCommand(text)) {
						mode.editor.setText("");
						try {
							if (!onManagement) throw Error("MANAGEMENT_UNAVAILABLE");
							await onManagement(text);
						} catch {
							notify(
								"Local management command failed; check configuration and command syntax. Credentials were not retained.",
							);
						}
						return;
					}
					if (cmd === "/disconnect") {
						await mode.shutdown();
						return;
					}
					if (cmd === "/control" || cmd === "/watch") {
						await remote.request(cmd === "/control" ? "takeover" : "watch", {});
						mode.showStatus(
							cmd === "/control"
								? "Control acquired; submit your draft explicitly."
								: "Watching; server session continues.",
						);
						return;
					}
					if (["/abort", "/steer", "/followup"].includes(cmd)) {
						await mutate(cmd === "/followup" ? "followUp" : cmd.slice(1), {
							text: args,
						});
						mode.editor.setText("");
						return;
					}
					if (
						trimmed.startsWith("!") ||
						(trimmed.startsWith("/") &&
							![
								"/quit",
								"/reload",
								"/model",
								"/scoped-models",
								"/thinking",
								"/session",
								"/tree",
								"/fork",
								"/clone",
								"/new",
								"/resume",
								"/name",
								"/compact",
								"/copy",
								"/hotkeys",
							].includes(cmd) &&
							!isServerCommand(cmd.slice(1)))
					) {
						unsupported(cmd);
						return;
					}
					if (
						![
							"/quit",
							"/reload",
							"/model",
							"/scoped-models",
							"/thinking",
							"/session",
							"/tree",
							"/resume",
							"/fork",
							"/clone",
							"/new",
							"/name",
							"/copy",
							"/hotkeys",
						].includes(cmd) &&
						!remote.isController
					) {
						notify(
							"Watching: draft preserved. /control explicitly takes control; /watch stays read-only. No automatic replay.",
						);
						mode.editor.setText(text);
						return;
					}
					if (cmd !== "/quit" && trimmed.startsWith("/") && isServerCommand(cmd.slice(1))) {
						mode.editor.addToHistory?.(text);
						mode.editor.setText("");
						await view.prompt(text);
						return;
					}
					await stock!(text);
				} catch (e) {
					mode.editor.setText(text);
					notify(errorMessage(e));
				}
			};
		};
		installModelScopeUI(mode, remote, catalog as unknown as AgentSession["modelRuntime"]);
		mode.setupKeyHandlers();
		mode.setupEditorSubmitHandler();
		if (reload) {
			// Native subscribeToAgent closes over InteractiveMode, not this facade.
			// Preserve that subscription to the unchanged connection/native replica.
			await view.bindExtensions(reload.bindings);
			await reload.beforeSessionStart?.();
		} else await rebind();
		await hydrate();
		mode.defaultEditor.onEscape = () => {
			if (view.isStreaming && remote.isController) void view.abort().catch(() => {});
			else if (!remote.isController) notify("Watching. /control takes control explicitly.");
		};
		mode.defaultEditor.onAction("app.message.followUp", async () => {
			const text = mode.editor.getText();
			if (!text.trim()) return;
			try {
				await view.followUp(text);
				mode.editor.setText("");
			} catch {
				mode.editor.setText(text);
			}
		});
		remote.onUI = async ({ method, args = [] }) => {
			if (
				!remote.isController &&
				[
					"confirm",
					"input",
					"select",
					"editor",
					"subagents",
					"background",
					"setEditorText",
					"pasteToEditor",
				].includes(method)
			)
				throw Error("Only the controlling client can answer dialogs or change its draft");
			if (method === "installClientEditor")
				return clientViews.installEditor(
					args[0] as string,
					binding.uiContext!,
					() => view.pendingMessageCount > 0,
				);
			if (method === "ownedStatus") {
				binding.uiContext!.setStatus(
					args[0] as string,
					renderOwnedStatus(args[1] as OwnedStatus | undefined, binding.uiContext!.theme),
				);
				return;
			}
			if (method === "ownedFooter") {
				ownedFooter = args[0] as StatusFooterData;
				if (footerUI !== binding.uiContext) {
					const ui = binding.uiContext!;
					ui.setFooter((tui, theme, footer) => {
						footerUI = ui;
						const redraw = () => tui.requestRender();
						redrawFooter = redraw;
						const component = createStatusFooter(() => ownedFooter!, theme, footer);
						return {
							...component,
							dispose() {
								if (redrawFooter === redraw) {
									redrawFooter = undefined;
									footerUI = undefined;
								}
							},
						};
					});
				}
				redrawFooter?.();
				return;
			}
			if (method === "background") {
				const [request, signal] = args as [InteractionRequest, AbortSignal];
				return openRemoteBackground(remote, binding.uiContext!, request, signal);
			}
			if (method === "subagents") {
				const [request, signal] = args as [InteractionRequest, AbortSignal];
				return openSubagentsPanel(
					remote,
					binding.uiContext!,
					{
						settings,
						toolRenderer: (name) => toolRenderers.get(name),
						messageRenderer: clientViews.getMessageRenderer,
						entryRenderer: clientViews.getEntryRenderer,
						markdownTransformers: () => [],
					},
					signal,
					request.id,
					settings.getHideThinkingBlock(),
				);
			}

			args = [...args];
			if (["setStatus", "setWidget"].includes(method) && args[1] === null) args[1] = undefined;
			if (method === "setWidget" && args[2] === null) args[2] = undefined;
			if (method === "setWorkingMessage" && args[0] === null) args[0] = undefined;
			if (["setFooter", "setHeader"].includes(method) && args[0] === null) args[0] = undefined;
			const fn: unknown = binding?.uiContext && Reflect.get(binding.uiContext, method);
			if (typeof fn !== "function") throw Error(`Unsupported remote UI ${method}`);
			return await Reflect.apply(fn, undefined, args);
		};
		return { view, runtime };
	};
}
