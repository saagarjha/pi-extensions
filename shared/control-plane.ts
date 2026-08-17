import type {
	EventBus,
	SessionEntry,
	SessionHeader,
	AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { PermissionsSnapshot } from "../permissions/src/bridge.ts";
import type { AskRequest } from "../permissions/src/ask.ts";
export type Delivery = "auto" | "prompt" | "steer" | "followUp";
export type ChildImages = import("@earendil-works/pi-coding-agent").PromptOptions["images"];
export interface ChildSummary {
	lastHumanInteractionAt?: number;
	recoveredInputCount?: number;
	activity?: string;
	uiStatus?: { text: string; kind: "system" | "error" };
	queued?: ChildQueue;
	controlRevision: number;
	nativeIdentity?: string;
	sourceFile?: string;
	id: string;
	name: string;
	status: string;
	dormant: boolean;
	createdAt: number;
	updatedAt: number;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	error?: string;
}
export interface ChildInspection {
	leafId?: string | null;
	child: ChildSummary;
	sourceFile?: string;
	available: boolean;
	error?: string;
	header?: SessionHeader;
	entryCount: number;
	entries: SessionEntry[];
}
export interface ChildQueue {
	steering: string[];
	followUp: string[];
}
export interface ChildView {
	/** Dormant editor name hints only; never parent-owned argument callbacks. */
	commandNames?: { name: string; description?: string }[];
	child: ChildSummary;
	dormant: boolean;
	snapshot: import("../remote/protocol.ts").Snapshot | null;
	archive?: {
		header: SessionHeader | null;
		entries: SessionEntry[];
		leafId: string | null;
		sessionFile?: string;
		cwd: string;
	};
}
export interface ChildFrame {
	childId: string;
	nativeIdentity: string;
	frame: import("../remote/protocol.ts").ServerFrame;
}
export interface SubagentPort {
	/** Read only; never activate an archived child for suggestions. */
	completeCommand(id: string, expectedRevision: number, nativeIdentity: string, command: string, prefix: string): Promise<import("@earendil-works/pi-tui").AutocompleteItem[] | null>;
	view(id: string): ChildView;
	viewControl(id: string, expectedRevision: number, nativeIdentity: string, method: string, params: Record<string, unknown>, assertParent?: () => void): Promise<unknown>;
	subscribeFrames(listener: (event: ChildFrame) => void): () => void;
	list(): ChildSummary[];
	inspect(id: string, options?: { offset?: number; limit?: number }): ChildInspection;
	/** Trusted human input, same command/skill/template behavior as the child console. Not a literal-only prompt API. */
	spawnHuman(
		params: {
			text: string;
			name?: string;
			model?: string;
			thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		},
		signal?: AbortSignal,
	): Promise<ChildSummary>;
	/** Trusted human input; native child extension commands and prompt expansion are intentional. */
	submitHuman(
		id: string,
		text: string,
		expectedRevision: number,
		delivery?: Delivery,
		assertParent?: () => void,
		images?: ChildImages,
	): Promise<{ child: ChildSummary; delivery: Exclude<Delivery, "auto">; reactivated: boolean }>;
	stop(id: string, expectedRevision: number): Promise<ChildQueue>;
	dismiss(id: string, expectedRevision: number): Promise<ChildSummary>;
	dequeue(id: string, expectedRevision: number): ChildQueue;
	subscribe(listener: () => void): () => void;
	subscribeEvents(
		listener: (event: { childId: string; event: AgentSessionEvent }) => void,
	): () => void;
}
export interface ApprovalPresenter {
	confirm(request: AskRequest, signal: AbortSignal): Promise<boolean>;
}
/** Detached, compact views of the owning session's existing background records. */
export interface BackgroundTaskMetadata {
	/** Monotonic observation revision, scoped to the published service generation. */
	revision: number;
	id: string;
	target: string;
	command: string;
	cwd: string;
	status: "running" | "done" | "failed" | "stopped" | "interrupted";
	timeoutMs?: number;
	exitCode?: number;
	error?: string;
	startedAt: number;
	updatedAt: number;
}
export interface BackgroundTaskDetail extends BackgroundTaskMetadata { output: string; }
export interface BackgroundTaskPort {
	/** Read-only snapshots: no polling, execution, or completion-mailbox acknowledgement. */
	list(): BackgroundTaskMetadata[];
	status(id: string): BackgroundTaskDetail;
	subscribe(listener: () => void): () => void;
	stop(id: string): Promise<BackgroundTaskDetail>;
}
export type PermissionMutation = import("../permissions/src/mutations.ts").PermissionMutation;
export interface PermissionMutationResult { revision: number; permissions: PermissionsSnapshot; }
export interface PermissionPort {
	mutate(expectedRevision: number, mutation: PermissionMutation, assertCurrent?: () => void): Promise<PermissionMutationResult>;
	background?: BackgroundTaskPort;
	snapshot(): { revision: number; permissions: PermissionsSnapshot };
	subscribe(listener: () => void): () => void;
	attachPresenter(presenter: ApprovalPresenter): () => void;
}
export type ServiceOffer = { version: 1; sessionId: string; generation: string } & (
	| { kind: "subagents"; port: SubagentPort }
	| { kind: "permissions"; port: PermissionPort }
);
export type ServiceWithdrawal = Pick<ServiceOffer, "version" | "sessionId" | "generation" | "kind">;
const REQUEST = "pi.control.services.request.v1",
	OFFER = "pi.control.services.offer.v1",
	WITHDRAW = "pi.control.services.withdraw.v1";
function identity(value: unknown): value is ServiceWithdrawal {
	const v = value as ServiceWithdrawal;
	return (
		!!v &&
		v.version === 1 &&
		typeof v.sessionId === "string" &&
		typeof v.generation === "string" &&
		(v.kind === "subagents" || v.kind === "permissions")
	);
}
export function publishService(bus: EventBus, offer: ServiceOffer): () => void {
	let live = true;
	const off = bus.on(REQUEST, (value) => {
		const request = value as { accept?: (offer: ServiceOffer) => void };
		if (live && typeof request?.accept === "function") request.accept(offer);
	});
	bus.emit(OFFER, offer);
	return () => {
		if (!live) return;
		live = false;
		off();
		const { version, sessionId, generation, kind } = offer;
		bus.emit(WITHDRAW, { version, sessionId, generation, kind });
	};
}
export function watchServices(
	bus: EventBus,
	handlers: { offer(offer: ServiceOffer): void; withdraw(withdrawal: ServiceWithdrawal): void },
): () => void {
	const accept = (value: unknown) => {
		if (identity(value) && "port" in value && value.port && typeof value.port === "object")
			handlers.offer(value as ServiceOffer);
	};
	const offOffer = bus.on(OFFER, accept),
		offWithdraw = bus.on(WITHDRAW, (value) => {
			if (identity(value)) handlers.withdraw(value);
		});
	bus.emit(REQUEST, { accept });
	return () => {
		offOffer();
		offWithdraw();
	};
}
/** Presenter lifetime is server-owned, never connection-owned. Cancellation denies pending calls. */
export function approvalRouter() {
	let attached: { presenter: ApprovalPresenter; abort: AbortController } | undefined;
	return {
		attach(presenter: ApprovalPresenter) {
			if (attached) throw new Error("An approval presenter is already attached.");
			const entry = { presenter, abort: new AbortController() };
			attached = entry;
			return () => {
				if (attached !== entry) return;
				attached = undefined;
				entry.abort.abort();
			};
		},
		detach() {
			const entry = attached;
			attached = undefined;
			entry?.abort.abort();
		},
		confirm(
			request: AskRequest,
			signal: AbortSignal,
			fallback: () => Promise<boolean>,
		): Promise<boolean> {
			const entry = attached;
			if (!entry) return fallback();
			const combined = AbortSignal.any([signal, entry.abort.signal]);
			if (combined.aborted) return Promise.resolve(false);
			return new Promise((resolve) => {
				let settled = false;
				const finish = (answer: boolean) => {
					if (settled) return;
					settled = true;
					combined.removeEventListener("abort", cancel);
					resolve(answer && !combined.aborted);
				};
				const cancel = () => finish(false);
				combined.addEventListener("abort", cancel, { once: true });
				Promise.resolve()
					.then(() =>
						combined.aborted ? false : entry.presenter.confirm(structuredClone(request), combined),
					)
					.then(finish, () => finish(false));
			});
		},
	};
}
