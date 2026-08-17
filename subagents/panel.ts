import {
	startSubagentSubmission,
	startSubagentQueueRecovery,
} from "../remote/subagent-submission.ts";
import { visibleWindowAroundSelected } from "../shared/task-lifecycle.ts";
import { SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Text,
	TruncatedText,
	type Component,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ChildFrame, Delivery } from "../shared/control-plane.ts";

import type { OperationResult, LiveState } from "../remote/protocol.ts";
import type {
	SubagentsPanelHost,
	SubagentsPanelState,
	PanelRenderers,
	PanelFrame,
	PanelChildView,
} from "./panel-host.ts";
import { NativeTranscript } from "../subagents/native-transcript.ts";
import { ComponentViewport } from "../subagents/component-viewport.ts";
import { bordered, createTopChromeEditor } from "../subagents/presentation.ts";
import { createPanelWorkingIndicator, type PanelWorkingIndicator } from "../shared/loading.ts";

/** First-party presentation only; all execution/control remains with the existing service. */
export async function createSubagentsPanel(
	remote: SubagentsPanelHost,
	ui: ExtensionUIContext,
	rendering: PanelRenderers,
	signal?: AbortSignal,
	requestId?: string,
	initialHideThinking = false,
) {
	if (!rendering) throw Error("Native subagent rendering context is required");
	const serverIdentity = remote.serverIdentity;
	const sessionId = remote.sessionId,
		control = remote.controlGeneration;
	const generation = remote.current.services.subagents?.serviceGeneration;
	if (!generation || !remote.isController) throw Error("NOT_CONTROLLER_OR_SERVICE_UNAVAILABLE");
	const createTranscript = await NativeTranscript.factory((message) =>
		ui.notify(message, "warning"),
	);
	if (
		signal?.aborted ||
		!remote.connected ||
		!remote.isController ||
		remote.serverIdentity !== serverIdentity ||
		remote.sessionId !== sessionId ||
		remote.controlGeneration !== control ||
		remote.current.services.subagents?.serviceGeneration !== generation
	)
		throw Error("SUBAGENT_PANEL_SCOPE_CHANGED_BEFORE_MOUNT");
	const saved = remote.subagentsPanelState;
	const state: SubagentsPanelState =
		saved && saved.requestId === (requestId ?? "") && saved.sessionId === sessionId
			? saved
			: {
					requestId: requestId ?? "",
					sessionId,
					draft: "",
					toolsExpanded: ui.getToolsExpanded(),
					hideThinking: initialHideThinking,
				};
	remote.subagentsPanelState = state;
	return (async (tui, theme, keys, done) => {
		let closed = false,
			selected: string | undefined = state.selected,
			identity: string | undefined,
			seq = -1;
		let observedIdentity: string | undefined, observedDormant: boolean | undefined;
		let replica: SessionManager | undefined, viewport: ComponentViewport | undefined;
		let transcript: NativeTranscript | undefined;
		const notification = new Text("", 0, 0);
		let notificationText = "", viewportNodes: readonly Component[] | undefined;
		let viewportHeight = 1;
		let renderingError: string | undefined;
		let live: LiveState | undefined;
		let needsContextReset = false;
		let observationSeq = -1;
		let loading = false,
			ticket = 0,
			buffered: (ChildFrame | Extract<PanelFrame, { type: "panelEvent" | "panelEntries" }>)[] = [],
			overflow = false;
		let ready = false,
			status = "";
		let toolsExpanded = state.toolsExpanded,
			hideThinking = state.hideThinking;
		let recovering = false,
			firstReconcile = true;
		let indicator: PanelWorkingIndicator | undefined;
		let indicatorChild: string | undefined, indicatorIdentity: string | undefined;
		let queueChanged: (() => void) | undefined;
		const results = new Map<string, OperationResult>();
		const pending = new Map<
			string,
			{ resolve(value: unknown): void; reject(error: Error): void }
		>();
		const editor = createTopChromeEditor(
			tui,
			{
				borderColor: (text) => theme.fg("border", text),
				selectList: {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
			},
			keys,
		);
		editor.setText(state.draft);
		const rows = () =>
			[...(remote.current.services.subagents?.children ?? [])].sort(
				(a, b) =>
					(b.lastHumanInteractionAt ?? b.createdAt) - (a.lastHumanInteractionAt ?? a.createdAt) ||
					b.createdAt - a.createdAt ||
					a.id.localeCompare(b.id),
			);
		const child = () => rows().find((c) => c.id === selected);
		const owns = () =>
			!closed &&
			remote.connected &&
			remote.isController &&
			remote.sessionId === sessionId &&
			remote.serverIdentity === serverIdentity &&
			remote.controlGeneration === control &&
			remote.current.services.subagents?.serviceGeneration === generation;
		const redraw = () => {
			if (!closed) tui.requestRender();
		};
		const finish = (operation: OperationResult) => {
			// Input-owning operations have their client-scoped recovery observer.
			if (operation.command !== "service:subagents:dismiss") return;
			if (!operation.operationId || operation.status === "running") return;
			const waiter = pending.get(operation.operationId);
			if (waiter) {
				pending.delete(operation.operationId);
				operation.status === "failed"
					? waiter.reject(Error(operation.error || "Action failed"))
					: waiter.resolve(operation.value);
			} else {
				results.set(operation.operationId, operation);
				while (results.size > 64) results.delete(results.keys().next().value!);
			}
		};
		const dispose = () => {
			if (closed) return;
			const submission = remote.subagentSubmission;
			if (submission && (submission.status === "sending" || submission.status === "pending")) {
				try {
					ui.notify(
						"Child delivery outcome is unresolved. Reopen /subagents to inspect or recover the retained text; nothing is replayed.",
						"warning",
					);
				} catch {}
			}
			if (remote.subagentSubmission?.changed === redraw)
				remote.subagentSubmission.changed = undefined;
			remote.subagentSubmission?.retire();
			const recovery = remote.subagentQueueRecovery;
			if (recovery) {
				if (recovery.status === "sending" || recovery.status === "pending") {
					try {
						ui.notify(
							"Queue operation outcome unresolved. Reopen /subagents for retained drafts and late canonical results; nothing is retried or replayed.",
							"warning",
						);
					} catch {}
				}
				if (recovery.changed === queueChanged || recovery.changed === redraw)
					recovery.changed = undefined;
				recovery.retire();
			}
			state.draft = editor.getText();
			if (
				recovery &&
				recovery.serverIdentity === serverIdentity &&
				recovery.sessionId === sessionId &&
				recovery.childId === selected
			) {
				recovery.draft = [recovery.draft, state.draft].filter(Boolean).join("\n\n");
				state.draft = "";
			}
			state.selected = selected;
			state.toolsExpanded = toolsExpanded;
			state.hideThinking = hideThinking;
			closed = true;
			ticket++;
			off();
			signal?.removeEventListener("abort", abort);
			transcript?.dispose();
			transcript = undefined;
			viewport?.dispose();
			indicator?.dispose();
			for (const p of pending.values()) p.reject(Error("Panel closed; action was not replayed"));
			pending.clear();
			results.clear();
			buffered = [];
		};
		const close = () => {
			dispose();
			done(ownsBeforeClose);
		};
		let ownsBeforeClose = true;
		const abort = () => {
			ownsBeforeClose = false;
			close();
		};
		async function action(operation: string, args: unknown[]) {
			if (!owns()) throw Error("NOT_CONTROLLER_OR_STALE_GENERATION");
			const accepted = await remote.customRequest<{ operationId: string }>("serviceMutate", {
				service: "subagents",
				operation,
				args,
				serviceGeneration: generation,
				controlGeneration: control,
			});
			if (!owns()) throw Error("Action admitted; panel scope changed. No replay.");
			const previous = results.get(accepted.operationId);
			if (previous) {
				results.delete(accepted.operationId);
				if (previous.status === "failed") throw Error(previous.error);
				return previous.value;
			}
			if (pending.size >= 16) throw Error("Too many pending panel actions");
			return new Promise<unknown>((resolve, reject) =>
				pending.set(accepted.operationId, { resolve, reject }),
			);
		}
		function reset(view: PanelChildView) {
			const value = view.snapshot ?? view.archive;
			if (!value?.header) throw Error("Missing child native header");
			transcript?.dispose();
			transcript = undefined;
			viewport?.dispose();
			replica = SessionManager.inMemory(value.cwd, {}, [value.header, ...value.entries]);
			if (value.leafId === null) replica.resetLeaf();
			else replica.branch(value.leafId);
			observedIdentity = view.child.nativeIdentity;
			observedDormant = view.child.dormant;
			identity = view.snapshot ? view.child.nativeIdentity : undefined;
			seq = view.snapshot?.seq ?? -1;
			live = view.snapshot?.live;
			needsContextReset = false;
			const scope = (transcript = createTranscript({
				tui,
				theme,
				settings: rendering!.settings,
				manager: replica,
				toolRenderer: rendering.toolRenderer,
				messageRenderer: rendering.messageRenderer,
				entryRenderer: rendering!.entryRenderer,
				markdownTransformers: rendering!.markdownTransformers,
				expanded: toolsExpanded,
				hideThinking,
				retryAttempt: live?.retryAttempt ?? view.presentation?.retryAttempt,
				changed() {
					if (transcript === scope) {
						viewport?.changed();
						redraw();
					}
				},
			}));
			viewportNodes = undefined;
			let nativeNodes: readonly Component[] | undefined;
			viewport = new ComponentViewport(() => {
				const nodes = scope.container.children;
				if (!notificationText) return nodes;
				if (!viewportNodes || nativeNodes !== nodes || viewportNodes.length !== nodes.length + 1 ||
					viewportNodes.at(-2) !== nodes.at(-1)) {
					nativeNodes = nodes;
					viewportNodes = [...nodes, notification];
				}
				return viewportNodes;
			});
			scope.reset();
			void scope
				.hydrate(
					live?.partial ?? view.presentation?.partial,
					live?.toolExecutions ?? view.presentation?.toolExecutions,
				)
				.catch((error) => renderingFailed(scope, error));
			observationSeq = view.presentation?.observationSeq ?? -1;
			const commands = view.snapshot?.live.commands ?? view.presentation?.commands ??
				view.commandNames?.map((command) => ({ ...command, invocationName: command.name, argumentCompletions: false })) ?? [];
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(
					commands.map((c) => ({
						name: c.invocationName ?? c.name,
						description: c.description,
						getArgumentCompletions: !c.argumentCompletions || view.child.dormant ? undefined : async (prefix: string) => {
							const id = view.child.id, nativeIdentity = view.child.nativeIdentity;
							const revision = child()?.controlRevision;
							const current = () => owns() && ready && transcript === scope && selected === id &&
								child()?.nativeIdentity === nativeIdentity && !child()?.dormant && child()?.controlRevision === revision;
							if (!nativeIdentity || revision === undefined || !current()) return null;
							try {
								const result = await remote.customRequest<import("@earendil-works/pi-tui").AutocompleteItem[] | null>("serviceRead", {
									service: "subagents", operation: "commandCompletions", serviceGeneration: generation,
									args: [id, revision, nativeIdentity, c.invocationName ?? c.name, prefix],
								});
								return current() ? result : null;
							} catch { return null; }
						},
					})),
					value.cwd,
				),
			);
			ready = true;
			status = "";
		}
		async function load(id: string) {
			if (renderingError) return;
			const mine = ++ticket;
			loading = true;
			ready = false;
			buffered = [];
			overflow = false;
			const requestedIdentity = child()?.nativeIdentity,
				requestedDormant = child()?.dormant;
			try {
				const view = await remote.customRequest<PanelChildView>("serviceRead", {
					service: "subagents",
					operation: "view",
					args: [id],
					serviceGeneration: generation,
				});
				if (!owns() || mine !== ticket || selected !== id) return;
				const current = child();
				if (!current || view.child.id !== id) throw Error("Subagent unavailable");
				// Identity changes need not advance the action revision. An observation that
				// arrived during the read wins over an older reply, just as in the Mac activity view.
				if (
					(current.nativeIdentity !== requestedIdentity || current.dormant !== requestedDormant) &&
					(current.nativeIdentity !== view.child.nativeIdentity ||
						current.dormant !== view.child.dormant)
				) {
					loading = false;
					void load(id);
					return;
				}
				try {
					reset(view);
				} catch (error) {
					loading = false;
					renderingFailed(transcript, error);
					return;
				}
				loading = false;
				if (overflow) {
					buffered = [];
					void load(id);
					return;
				}
				const queued = buffered;
				buffered = [];
				try {
					for (const event of queued) apply(event);
				} catch (error) {
					renderingFailed(transcript, error);
				}
			} catch (error) {
				if (mine === ticket) {
					loading = false;
					ready = false;
					status = String(error);
				}
			}
			redraw();
		}
		function apply(
			event: ChildFrame | Extract<PanelFrame, { type: "panelEvent" | "panelEntries" }>,
		) {
			if (event.childId !== selected) return;
			if (loading) {
				if (buffered.length < 256) buffered.push(event);
				else overflow = true;
				return;
			}
			if ("type" in event) {
				if (!ready || !transcript || event.observationSeq <= observationSeq) return;
				observationSeq = event.observationSeq;
				if (event.type === "panelEntries") {
					applyEntries(event);
					return;
				}
				const scope = transcript;
				scope.setRetryAttempt(event.retryAttempt);
				if (event.event.type === "compaction_end") {
					if (selected) void load(selected);
				} else void scope.event(event.event).catch((error) => renderingFailed(scope, error));
				return;
			}
			if (!ready || event.nativeIdentity !== identity) return;
			const frame = event.frame;
			if (frame.seq <= seq) return;
			if (frame.type === "snapshot") {
				const current = child();
				if (current?.nativeIdentity === identity && frame.sessionId === replica?.getSessionId())
					reset({ child: current, dormant: current.dormant, snapshot: frame });
				else if (selected) void load(selected);
				redraw();
				return;
			}
			if (frame.sessionId !== replica?.getSessionId() || frame.seq !== seq + 1) {
				if (selected) void load(selected);
				return;
			}
			seq = frame.seq;
			if (frame.type === "append") {
				(replica as unknown as { _appendEntry(entry: unknown): void })._appendEntry(frame.entry);
				// Canonical append precedes queued native events on this wire. It updates
				// the replica only; rendering it here would duplicate message_start later.
				transcript?.committed(frame.entry);
				if (frame.entry.type === "branch_summary") needsContextReset = true;
			} else if (frame.type === "leaf" && frame.leafId !== replica!.getLeafId()) {
				if (frame.leafId === null) replica!.resetLeaf();
				else replica!.branch(frame.leafId);
				rebuild();
			} else if (frame.type === "live") {
				live = frame.live;
				transcript?.setRetryAttempt(live.retryAttempt);
				if (needsContextReset) rebuild();
			} else if (frame.type === "event") {
				const scope = transcript!;
				if (frame.event.type === "compaction_end") rebuild();
				else void scope.event(frame.event).catch((error) => renderingFailed(scope, error));
			}
			redraw();
		}
		function applyEntries(frame: Extract<PanelFrame, { type: "panelEntries" }>) {
			if (
				frame.reset ||
				frame.childSessionId !== replica?.getSessionId() ||
				frame.nativeIdentity !== observedIdentity
			) {
				if (selected) void load(selected);
			} else {
				try {
					let contextChanged = false;
					for (const entry of frame.entries) {
						if (replica!.getEntry(entry.id)) continue;
						(replica as unknown as { _appendEntry(entry: unknown): void })._appendEntry(entry);
						transcript?.committed(entry);
						if (entry.type === "compaction" || entry.type === "branch_summary")
							contextChanged = true;
					}
					if (frame.leafId !== replica!.getLeafId()) {
						if (frame.leafId === null) replica!.resetLeaf();
						else replica!.branch(frame.leafId);
						contextChanged = true;
					}
					if (contextChanged) rebuild();
				} catch (error) {
					if (transcript) renderingFailed(transcript, error);
				}
			}
		}

		function renderingFailed(scope: NativeTranscript | undefined, error: unknown) {
			if (closed || transcript !== scope || renderingError) return;
			renderingError = `Child transcript disabled for this panel: ${String(error)}`;
			scope?.dispose();
			transcript = undefined;
			viewport?.dispose();
			viewport = undefined;
			ready = false;
			ui.notify(renderingError + ". Escape returns to the main editor.", "warning");
			redraw();
		}
		function rebuild() {
			needsContextReset = false;
			const scope = transcript!;
			// Branch/compaction boundaries have canonical context; do not replay the
			// latest live partial ahead of subsequently queued native message events.
			scope.reset(replica!);
			viewport?.bottom();
		}

		function syncIndicator() {
			const c = child();
			if (c?.id !== indicatorChild || c?.nativeIdentity !== indicatorIdentity) {
				// Stop the previous native timer even for running → running selection.
				indicator?.setWorking(false);
				indicatorChild = c?.id;
				indicatorIdentity = c?.nativeIdentity;
			}
			indicator?.setWorking(
				!c?.dormant && (c?.status === "running" || c?.status === "starting"),
				c?.activity,
			);
		}
		function reconcile() {
			if (!owns()) {
				close();
				return;
			}
			const list = rows();
			if (!list.some((c) => c.id === selected)) {
				selected = list[0]?.id;
				ready = false;
				transcript?.dispose();
				transcript = undefined;
				viewport?.dispose();
				viewport = undefined;
				if (selected) void load(selected);
			} else if (firstReconcile && !loading && !ready && !replica && selected) void load(selected);
			else if (
				!loading &&
				ready &&
				(child()?.nativeIdentity !== observedIdentity || child()?.dormant !== observedDormant)
			)
				void load(selected!);
			firstReconcile = false;
			syncIndicator();
			redraw();
		}
		const off = remote.subscribeFrames((frame: PanelFrame) => {
			if (
				frame.type === "disconnect" ||
				frame.type === "panelRetired" ||
				frame.type === "control" ||
				frame.type === "snapshot" ||
				(frame.type === "interactionResolved" && frame.requestId === requestId)
			) {
				abort();
				return;
			}
			if (!owns()) {
				close();
				return;
			}
			if (frame.type === "operation") finish(frame.operation);
			if (frame.type === "childFrame" && frame.event.serviceGeneration === generation) {
				try {
					apply(frame.event);
				} catch (error) {
					if (transcript) renderingFailed(transcript, error);
					else {
						ready = false;
						status = String(error);
						redraw();
					}
				}
			}
			if (frame.type === "panelEvent" || frame.type === "panelEntries") {
				try {
					if (frame.type === "panelEvent") reconcile();
					apply(frame);
				} catch (error) {
					renderingFailed(transcript, error);
				}
			}
			if (frame.type === "live" || frame.type === "panelChanged") reconcile();
		});
		function send(delivery: Delivery, value = editor.getText()) {
			const c = child();
			if (!c || !value.trim()) return;
			const previousSubmission = remote.subagentSubmission;
			try {
				if (!owns()) throw Error("NOT_CONTROLLER_OR_STALE_GENERATION");
				const submission = startSubagentSubmission(remote, {
					childId: c.id,
					childName: c.name,
					text: value,
					revision: c.controlRevision,
					delivery,
					serviceGeneration: generation!,
					requestId,
				});
				submission.changed = redraw;
				editor.setText("");
				viewport?.bottom();
				status = "";
			} catch (error) {
				// Native Editor clears before onSubmit. Restore only a synchronous
				// rejection that did not create a new retained submission.
				if (remote.subagentSubmission === previousSubmission) editor.setText(value);
				status = String(error);
			}
			redraw();
		}
		function recoverSubmission(): boolean {
			const submission = remote.subagentSubmission;
			if (
				!submission ||
				submission.sessionId !== sessionId ||
				submission.serverIdentity !== serverIdentity ||
				submission.childId !== selected ||
				!["failed", "unknown"].includes(submission.status)
			)
				return false;
			editor.setText([submission.text, editor.getText()].filter(Boolean).join("\n\n"));
			status =
				submission.status === "unknown"
					? "Outcome unknown: inspect transcript before explicitly resubmitting."
					: "Rejected submission restored for editing; not sent.";
			submission.release();
			remote.subagentSubmission = undefined;
			return true;
		}
		function recoverQueue(): boolean {
			const recovery = remote.subagentQueueRecovery;
			if (
				!recovery ||
				recovery.serverIdentity !== serverIdentity ||
				recovery.sessionId !== sessionId ||
				recovery.childId !== selected
			)
				return false;
			if (recovery.status === "recovered" && recovery.queue) {
				const text = [...recovery.queue.steering, ...recovery.queue.followUp, recovery.draft]
					.filter(Boolean)
					.join("\n\n");
				editor.setText([text, editor.getText()].filter(Boolean).join("\n\n"));
				status = "Returned queue restored for editing exactly once; not sent.";
				recovery.release();
				remote.subagentQueueRecovery = undefined;
			} else if (recovery.status === "failed") {
				editor.setText([recovery.draft, editor.getText()].filter(Boolean).join("\n\n"));
				status = "Queue operation failed; no queue recovered. " + (recovery.error ?? "");
				recovery.release();
				remote.subagentQueueRecovery = undefined;
			} else {
				if (recovery.draft) {
					editor.setText([recovery.draft, editor.getText()].filter(Boolean).join("\n\n"));
					recovery.draft = undefined;
				}
				status = "Queue outcome unresolved; awaiting canonical result. No retry or replay.";
			}
			return true;
		}
		async function controlAction(operation: "interrupt" | "dequeue" | "dismiss") {
			const c = child();
			if (!c || recovering) return;
			try {
				if (!owns()) throw Error("NOT_CONTROLLER_OR_STALE_GENERATION");
				if (operation !== "dismiss") {
					const recovery = startSubagentQueueRecovery(remote, {
						kind: operation,
						childId: c.id,
						childName: c.name,
						revision: c.controlRevision,
						serviceGeneration: generation!,
						requestId,
					});
					queueChanged = () => {
						// The original explicit gesture may restore its result while still in scope.
						// A reopened panel attaches only redraw, never this auto-restore callback.
						if (owns() && selected === c.id && recovery.status === "recovered") recoverQueue();
						else if (owns() && selected === c.id && recovery.status === "completed")
							status =
								operation === "interrupt" ? "Interrupted; no queued input" : "No queued input";
						redraw();
					};
					recovery.changed = queueChanged;
				} else {
					recovering = true;
					await action(operation, [c.id, c.controlRevision]);
					if (!closed && selected === c.id) status = "Dismissed";
				}
			} catch (error) {
				if (!closed) status = String(error);
			} finally {
				recovering = false;
			}
			redraw();
		}
		function select(step: number) {
			if (recovering) return;
			const list = rows();
			if (!list.length) return;
			const index = Math.max(
				0,
				list.findIndex((c) => c.id === selected),
			);
			const next = list[(index + step + list.length) % list.length]!.id;
			if (next === selected) return;
			selected = next;
			syncIndicator();
			transcript?.dispose();
			transcript = undefined;
			viewport?.dispose();
			viewport = undefined;
			identity = undefined;
			void load(selected);
		}
		editor.onSubmit = (text) => {
			send("auto", text);
		};
		if (remote.subagentSubmission) remote.subagentSubmission.changed = redraw;
		if (remote.subagentQueueRecovery) remote.subagentQueueRecovery.changed = redraw;
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			indicator = await createPanelWorkingIndicator(tui, editor);
		} catch (error) {
			dispose();
			throw error;
		}
		if (closed) {
			indicator.dispose();
			return { render: () => [], invalidate() {} };
		}
		reconcile();
		return {
			get focused() {
				return editor.focused;
			},
			set focused(value: boolean) {
				editor.focused = value;
			},
			dispose,
			invalidate() {
				editor.invalidate();
				indicator?.invalidate();
				viewport?.invalidate();
			},
			handleInput(data: string) {
				if (!owns()) {
					close();
					return;
				}
				if (matchesKey(data, "ctrl+c")) {
					void controlAction("interrupt");
					return;
				}
				if (
					editor.isShowingAutocomplete() &&
					[
						"tui.select.cancel",
						"tui.select.up",
						"tui.select.down",
						"tui.select.confirm",
						"tui.input.tab",
					].some((k) => keys.matches(data, k as any))
				) {
					editor.handleInput(data);
					redraw();
					return;
				}
				if (keys.matches(data, "tui.select.cancel")) {
					close();
					return;
				}
				if (keys.matches(data, "app.tools.expand")) {
					toolsExpanded = !toolsExpanded;
					try {
						transcript?.setOptions(toolsExpanded, hideThinking);
					} catch (error) {
						renderingFailed(transcript, error);
					}
				} else if (keys.matches(data, "app.thinking.toggle")) {
					hideThinking = !hideThinking;
					try {
						transcript?.setOptions(toolsExpanded, hideThinking);
					} catch (error) {
						renderingFailed(transcript, error);
					}
				} else if (keys.matches(data, "app.interrupt")) void controlAction("interrupt");
				else if (data === "\x04" && !editor.getText()) void controlAction("dismiss");
				else if (
					keys.matches(data, "tui.select.pageUp") ||
					keys.matches(data, "tui.altScreen.pageUp")
				) {
					try {
						viewport?.scroll(Math.min(10, viewportHeight));
					} catch (error) {
						renderingFailed(transcript, error);
					}
				} else if (
					keys.matches(data, "tui.select.pageDown") ||
					keys.matches(data, "tui.altScreen.pageDown")
				) {
					try {
						viewport?.scroll(-Math.min(10, viewportHeight));
					} catch (error) {
						renderingFailed(transcript, error);
					}
				} else if (keys.matches(data, "tui.altScreen.bottom")) viewport?.bottom();
				else if (
					(keys.matches(data, "app.message.dequeue") ||
						(!editor.getText() && keys.matches(data, "tui.editor.cursorUp"))) &&
					(recoverQueue() || recoverSubmission())
				) {
				} else if (
					!editor.getText() &&
					(keys.matches(data, "app.message.dequeue") ||
						(keys.matches(data, "tui.editor.cursorUp") &&
							!!(
								child()?.recoveredInputCount ||
								child()?.queued?.steering.length ||
								child()?.queued?.followUp.length
							)))
				)
					void controlAction("dequeue");
				else if (
					!editor.getText() &&
					(keys.matches(data, "tui.select.up") || matchesKey(data, "shift+tab"))
				)
					select(-1);
				else if (
					!editor.getText() &&
					(keys.matches(data, "tui.select.down") || keys.matches(data, "tui.input.tab"))
				)
					select(1);
				else if (keys.matches(data, "app.message.followUp")) void send("followUp");
				else editor.handleInput(data);
				redraw();
			},
			render(w: number) {
				const inner = Math.max(1, w - 4),
					height = Math.max(1, Math.floor((tui.terminal.rows || 24) * 0.72) - 2),
					c = child();
				// Notifications (e.g. /usage) are multiline UI, not model messages.
				// Put the full native Text component inside the scrollable viewport;
				// wrapping it as a one-row footer after budgeting overflows the overlay.
				const nextNotification = c?.uiStatus?.text ?? c?.error ?? "";
				if (nextNotification !== notificationText) {
					notificationText = nextNotification;
					notification.setText(nextNotification);
					viewportNodes = undefined;
					viewport?.changed();
				}
				const list = rows();
				const labels = list.map((x) => {
					const marker = x.status === "running" || x.status === "starting"
						? "●"
						: x.status === "failed" || x.status === "cancelled"
							? "✗"
							: x.dormant ? "◌" : "○";
					const label = ` ${marker} ${x.name} `;
					return x.id === selected
						? theme.bg("selectedBg", theme.fg("accent", label))
						: theme.fg("dim", label);
				});
				const window = visibleWindowAroundSelected({
					count: labels.length,
					selected: Math.max(
						0,
						list.findIndex((x) => x.id === selected),
					),
					maxWidth: inner,
					itemWidth: (i) => visibleWidth(labels[i] ?? ""),
				});
				const tabs = `${window.start ? "‹ " : ""}${labels.slice(window.start, window.end).join(" ")}${window.end < labels.length ? " ›" : ""}`;
				const lines = [
					truncateToWidth(tabs || "No subagents yet.", inner),
					"═".repeat(inner),
					theme.fg("dim", truncateToWidth(c ? `${c.id} · ${c.model?.provider}/${c.model?.id} · ${c.status}` : "", inner)),
					theme.fg("dim", "─".repeat(inner)),
				];
				editor.setAutocompleteMaxVisible(Math.max(3, Math.min(5, height - 3)));
				const input = editor.render(inner);
				const preview = (text: string) =>
					new TruncatedText(text.replace(/[\r\n]+/g, " "), inner >= 3 ? 1 : 0, 0).render(inner)[0]!;
				const queue = c?.queued;
				const tail: string[] = [];
				for (const text of queue?.steering ?? [])
					tail.push(preview(`Steering: ${text}`));
				for (const text of queue?.followUp ?? [])
					tail.push(preview(`Follow-up: ${text}`));
				if (c?.recoveredInputCount)
					tail.push(preview(`Recovered input: ${c.recoveredInputCount} (not queued)`));
				if (status) tail.push(preview(status));
				const submission = remote.subagentSubmission;
				if (submission) {
					const outcome = ["failed", "unknown"].includes(submission.status)
						? `${submission.status === "failed" ? "Rejected" : "Outcome unknown"}: ${submission.childName}; Up/Dequeue to recover (never replayed).`
						: `Submitting to ${submission.childName}…`;
					tail.push(preview(outcome));
				}
				const recovery = remote.subagentQueueRecovery;
				if (recovery) {
					const outcome =
						recovery.status === "recovered"
							? "Returned input retained; Dequeue to restore"
							: recovery.status === "failed"
								? "Queue failed; Dequeue restores draft / acknowledges"
								: "Queue outcome unresolved; Dequeue recovers draft only";
					tail.push(preview(recovery.childName + ": " + outcome));
				}
				const tailHeight = Math.min(tail.length, 3, Math.max(0, height - input.length - 2));
				// Match the main view's spacer above the editor, but yield this
				// optional row before crowding out chrome, content, or autocomplete.
				const editorGap = height - lines.length - input.length - tailHeight >= 3 ? 1 : 0;
				const inputHeight = input.length + editorGap;
				// Native pending messages have a leading spacer as well as the
				// separate editor gap. Yield this optional row on short terminals.
				const tailGap = tailHeight > 0 && height - lines.length - inputHeight - tailHeight >= 3 ? 1 : 0;
				const footerHeight = tailHeight + tailGap;
				// On short terminals, drop optional header rows before sacrificing
				// the editor or the scrollable content row to the overlay's maxHeight.
				const hintHeight = height - inputHeight - footerHeight >= 2 ? 1 : 0;
				lines.splice(Math.max(0, height - inputHeight - footerHeight - hintHeight - 1));
				const available = Math.max(
					0,
					height - lines.length - inputHeight - footerHeight - hintHeight,
				);
				viewportHeight = available;
				let log: ReturnType<ComponentViewport["render"]> | undefined;
				try {
					if (ready && available) log = viewport?.render(inner, available);
				} catch (error) {
					if (transcript) renderingFailed(transcript, error);
					log = {
						lines: ["Native child rendering unavailable; see error below."],
						earlier: false,
						later: false,
					};
				}
				const earlierMessages = transcript?.earlierMessages(
					log?.first === notification ? transcript.container : log?.first,
				) ?? 0;
				if (hintHeight) lines.push(
					theme.fg(
						"dim",
						truncateToWidth(log?.earlier
							? `${earlierMessages} earlier message${earlierMessages === 1 ? "" : "s"} ↑${log.later ? " · Later messages ↓" : ""}`
							: log?.later
								? "Later messages ↓"
								: "", inner),
					),
				);
				if (available) lines.push(
					...(log?.lines ?? [
						renderingError
							? truncateToWidth(renderingError + "; Escape to main editor", inner)
							: loading
								? "Loading child…"
								: "",
					]),
				);
				while (lines.length < height - inputHeight - footerHeight) lines.push("");
				if (tailGap) lines.push("");
				lines.push(...tail.slice(tail.length - tailHeight));
				if (editorGap) lines.push("");
				lines.push(...input);
				return bordered(lines, w, "subagent console", (text) => theme.fg("accent", text));
			},
		};
	}) satisfies (
		tui: import("@earendil-works/pi-tui").TUI,
		theme: ExtensionUIContext["theme"],
		keys: import("@earendil-works/pi-coding-agent").KeybindingsManager,
		done: (result: boolean) => void,
	) => Promise<import("@earendil-works/pi-tui").Component>;
}
