import { randomUUID } from "node:crypto";
import type { TUI } from "@earendil-works/pi-tui";
import type { SubagentPort, ChildSummary, Delivery } from "../shared/control-plane.ts";
import type {
	PanelClientState,
	PanelFrame,
	PanelChildView,
	SubagentsPanelHost,
} from "./panel-host.ts";

type LocalClientState = PanelClientState & { identity: string };
const stateKey = Symbol.for("pi.extensions.subagents.client-state");
const shared = globalThis as typeof globalThis & { [stateKey]?: WeakMap<TUI, LocalClientState> };
const clients = (shared[stateKey] ??= new WeakMap<TUI, LocalClientState>());
export function localPanelState(tui: TUI): LocalClientState {
	let state = clients.get(tui);
	if (!state) {
		state = { identity: `direct:${randomUUID()}` };
		clients.set(tui, state);
	}
	return state;
}
/** Direct adapter for the existing owner's finite SubagentPort. The promise is
 * its canonical completion; no backend/session/runtime is constructed here. */
export class LocalPanelHost implements SubagentsPanelHost {
	readonly controlGeneration = 1;
	readonly generation = randomUUID();
	readonly serverIdentity: string;
	private live = true;
	private listeners = new Set<(frame: PanelFrame) => void>();
	private off?: () => void;
	private sequence = 0;
	private selected?: string;
	private entryCount = 0;
	private leafId: string | null = null;
	private childSessionId?: string;
	private flushQueued = false;
	constructor(
		readonly sessionId: string,
		private port: SubagentPort,
		private state: LocalClientState,
		private presentation: (id: string) => PanelChildView,
		private summaries: () => ChildSummary[],
		private retryAttempt: (id: string) => number,
	) {
		this.serverIdentity = state.identity;
	}
	get subagentsPanelState() {
		return this.state.subagentsPanelState;
	}
	set subagentsPanelState(value) {
		this.state.subagentsPanelState = value;
	}
	get subagentSubmission() {
		return this.state.subagentSubmission;
	}
	set subagentSubmission(value) {
		this.state.subagentSubmission = value;
	}
	get subagentQueueRecovery() {
		return this.state.subagentQueueRecovery;
	}
	set subagentQueueRecovery(value) {
		this.state.subagentQueueRecovery = value;
	}
	get connected() {
		return this.live;
	}
	get isController() {
		return this.live;
	}
	get current() {
		return {
			services: {
				subagents: this.live
					? { serviceGeneration: this.generation, children: this.summaries() }
					: null,
			},
		};
	}
	private emit(frame: PanelFrame) {
		for (const listener of [...this.listeners]) listener(frame);
	}
	subscribeFrames(listener: (frame: PanelFrame) => void) {
		this.listeners.add(listener);
		if (!this.off && this.live) {
			const changed = this.port.subscribe(() => {
				this.emit({ type: "panelChanged", sessionId: this.sessionId });
			});
			const events = this.port.subscribeEvents(({ childId, event }) => {
				this.emit({
					type: "panelEvent",
					observationSeq: ++this.sequence,
					sessionId: this.sessionId,
					childId,
					event: structuredClone(event),
					retryAttempt: this.retryAttempt(childId),
				});
				if (
					childId === this.selected &&
					[
						"message_end",
						"agent_settled",
						"entry_appended",
						"compaction_end",
						"session_info_changed",
						"bash_execution_update",
					].includes(event.type)
				)
					this.queueContext();
			});
			this.off = () => {
				changed();
				events();
			};
		}
		return () => {
			this.listeners.delete(listener);
			if (!this.listeners.size) {
				this.off?.();
				this.off = undefined;
			}
		};
	}
	private check(params: Record<string, unknown>) {
		if (
			!this.live ||
			params.service !== "subagents" ||
			params.serviceGeneration !== this.generation
		)
			throw Object.assign(Error("DIRECT_PANEL_SCOPE_RETIRED"), { remoteRejected: true });
	}
	async customRequest<T>(
		method: "serviceRead" | "serviceMutate",
		params: Record<string, unknown>,
	): Promise<T> {
		this.check(params);
		const args = params.args as unknown[];
		if (method === "serviceRead") {
			if (params.operation === "commandCompletions") {
				const result = await this.port.completeCommand(...(args as Parameters<SubagentPort["completeCommand"]>));
				this.check(params);
				return result as T;
			}
			if (params.operation !== "view") throw Error("Unsupported direct panel read");
			// Native persistence follows synchronous event delivery. Read after that turn,
			// then suppress observations already represented by this canonical bootstrap.
			await Promise.resolve();
			this.check(params);
			const id = String(args[0]);
			const view = this.presentation(id),
				context = view.snapshot ?? view.archive;
			if (view.presentation) view.presentation.observationSeq = this.sequence;
			this.selected = id;
			this.entryCount = context?.entries.length ?? 0;
			this.leafId = context?.leafId ?? null;
			this.childSessionId = context?.header?.id;
			return view as T;
		}
		if (params.controlGeneration !== this.controlGeneration)
			throw Object.assign(Error("DIRECT_PANEL_SCOPE_RETIRED"), { remoteRejected: true });
		const operation = params.operation;
		if (!["message", "interrupt", "dequeue", "dismiss"].includes(String(operation)))
			throw Object.assign(Error("Unsupported direct panel action"), { remoteRejected: true });
		const operationId = randomUUID();
		// Deliberately separate admission from canonical completion, just like the
		// attached adapter. Completion remains observable after the popup retires.
		void Promise.resolve()
			.then(async () => {
				this.check(params);
				const id = String(args[0]);
				if (operation === "message")
					return this.port.submitHuman(
						id,
						String(args[1]),
						Number(args[2]),
						args[3] as Delivery,
						() => this.check(params),
					);
				if (operation === "interrupt") return this.port.stop(id, Number(args[1]));
				if (operation === "dequeue") return this.port.dequeue(id, Number(args[1]));
				return this.port.dismiss(id, Number(args[1]));
			})
			.then(
				(value) => this.complete(operationId, String(operation), { status: "completed", value }),
				(error) =>
					this.complete(operationId, String(operation), { status: "failed", error: String(error) }),
			);
		return { operationId } as T;
	}
	private queueContext() {
		if (this.flushQueued) return;
		this.flushQueued = true;
		queueMicrotask(() => {
			this.flushQueued = false;
			if (!this.live || !this.selected || !this.listeners.size) return;
			const childId = this.selected;
			try {
				// Native persistence follows message_end callbacks. Read only the new
				// canonical entries after that write, never fabricate or retain messages.
				const update = this.port.inspect(childId, { offset: this.entryCount, limit: 1000 });
				const reset =
					!update.available ||
					update.header?.id !== this.childSessionId ||
					update.entryCount < this.entryCount ||
					update.entryCount > this.entryCount + update.entries.length;
				if (!reset && !update.entries.length && update.leafId === this.leafId) return;
				this.entryCount = update.entryCount;
				this.leafId = update.leafId ?? null;
				this.emit({
					type: "panelEntries",
					observationSeq: ++this.sequence,
					sessionId: this.sessionId,
					childId,
					childSessionId: update.header?.id,
					nativeIdentity: this.summaries().find((child) => child.id === childId)?.nativeIdentity,
					entries: update.entries,
					leafId: this.leafId,
					reset,
				});
			} catch {
				this.emit({
					type: "panelEntries",
					observationSeq: ++this.sequence,
					sessionId: this.sessionId,
					childId,
					entries: [],
					leafId: null,
					reset: true,
				});
			}
		});
	}
	private complete(
		operationId: string,
		command: string,
		result: { status: "completed" | "failed"; value?: unknown; error?: string },
	) {
		this.emit({
			type: "operation",
			sessionId: this.sessionId,
			seq: ++this.sequence,
			operation: { operationId, command: `service:subagents:${command}`, ...result },
		});
	}
	close() {
		if (!this.live) return;
		this.live = false;
		this.emit({ type: "panelRetired", sessionId: this.sessionId });
		this.off?.();
		this.off = undefined;
		// Input-operation subscribers intentionally survive for late terminal results.
	}
}
