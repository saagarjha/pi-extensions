import type { ChildQueue, Delivery } from "../shared/control-plane.ts";
import type { OperationResult } from "./protocol.ts";
import type { SubagentsPanelHost } from "../subagents/panel-host.ts";

type QueueOperation = "interrupt" | "dequeue";
type Operation = "message" | QueueOperation;
type Scope = {
	childId: string;
	childName: string;
	revision: number;
	serviceGeneration: string;
	requestId?: string;
};

export interface SubagentSubmission {
	kind: Operation;
	serverIdentity: string;
	sessionId: string;
	childId: string;
	childName: string;
	/** Outbound text only; returned queues remain separately typed. */
	text: string;
	queue?: ChildQueue;
	/** Draft moved here on panel retirement so interaction resolution cannot erase it. */
	draft?: string;
	requestId?: string;
	operationId?: string;
	status: "sending" | "pending" | "failed" | "unknown" | "completed" | "recovered";
	error?: string;
	changed?: () => void;
	/** UI/connection retirement does not prove whether the operation happened. */
	retire(): void;
	release(): void;
}

export function startSubagentSubmission(
	remote: SubagentsPanelHost,
	input: Scope & { text: string; delivery: Delivery },
): SubagentSubmission {
	return start(remote, { ...input, kind: "message" });
}

export function startSubagentQueueRecovery(
	remote: SubagentsPanelHost,
	input: Scope & { kind: QueueOperation },
): SubagentSubmission {
	return start(remote, input);
}

/** Only the three first-party operations which own recoverable human input.
 * One outbound submission and one consuming queue operation are retained per
 * client, independently of the panel. Neither slot is a replay queue or history. */
function start(
	remote: SubagentsPanelHost,
	input: Scope &
		({ kind: "message"; text: string; delivery: Delivery } | { kind: QueueOperation }),
): SubagentSubmission {
	const slot = input.kind === "message" ? "subagentSubmission" : "subagentQueueRecovery";
	if (remote[slot]) throw Error("Recover or acknowledge the previous input operation first.");
	if (!remote.isController) throw Error("NOT_CONTROLLER_OR_STALE_GENERATION");
	const sessionId = remote.sessionId;
	const serverIdentity = remote.serverIdentity;
	const controlGeneration = remote.controlGeneration;
	let off = () => {};
	const early = new Map<string, OperationResult>();
	const submission: SubagentSubmission = {
		kind: input.kind,
		serverIdentity,
		sessionId,
		childId: input.childId,
		childName: input.childName,
		text: input.kind === "message" ? input.text : "",
		requestId: input.requestId,
		status: "sending",
		retire() {
			if (submission.status === "sending" || submission.status === "pending") {
				submission.status = "unknown";
				submission.error = "Operation outcome unknown; nothing was retried or replayed.";
				submission.changed?.();
			}
		},
		release() {
			off();
			off = () => {};
			early.clear();
			submission.changed = undefined;
		},
	};
	remote[slot] = submission;
	const finish = (operation: OperationResult) => {
		if (operation.status !== "completed" && operation.status !== "failed") return;
		submission.status = operation.status;
		submission.error = operation.error;
		if (operation.status === "completed" && input.kind !== "message") {
			const queue = operation.value as ChildQueue | undefined;
			if (
				!queue ||
				!Array.isArray(queue.steering) ||
				!Array.isArray(queue.followUp) ||
				!queue.steering.every((text) => typeof text === "string") ||
				!queue.followUp.every((text) => typeof text === "string")
			) {
				submission.status = "unknown";
				submission.error = "Invalid canonical queue result; no input was recovered.";
			} else {
				submission.queue = { steering: [...queue.steering], followUp: [...queue.followUp] };
				if (queue.steering.length || queue.followUp.length || submission.draft)
					submission.status = "recovered";
			}
		}
		if (submission.status === "completed" && remote[slot] === submission)
			remote[slot] = undefined;
		submission.changed?.();
		submission.release();
	};
	const observe = (operation: OperationResult) => {
		if (operation.status !== "completed" && operation.status !== "failed") return;
		if (submission.operationId === operation.operationId) finish(operation);
		else if (
			!submission.operationId &&
			operation.command === `service:subagents:${input.kind}`
		) {
			early.set(operation.operationId, {
				operationId: operation.operationId,
				status: operation.status,
				error: operation.error,
				// Queue results can precede their ACK; dropping this value loses input.
				value: input.kind === "message" ? undefined : operation.value,
			});
			while (early.size > 16) {
				early.delete(early.keys().next().value!);
				submission.retire();
			}
		}
	};
	off = remote.subscribeFrames((frame) => {
		if (
			remote.serverIdentity !== serverIdentity ||
			(frame.type !== "disconnect" && frame.sessionId !== sessionId)
		) {
			submission.retire();
			return;
		}
		if (frame.type === "operation") observe(frame.operation);
		if (frame.type === "snapshot") for (const operation of frame.operations) observe(operation);
		if (
			frame.type === "disconnect" || frame.type === "panelRetired" ||
			(frame.type === "control" && frame.control.controlGeneration !== controlGeneration) ||
			(frame.type === "interactionResolved" && frame.requestId === input.requestId)
		)
			submission.retire();
	});
	void remote
		.customRequest<{ operationId: string }>("serviceMutate", {
			service: "subagents",
			operation: input.kind,
			args:
				input.kind === "message"
					? [input.childId, input.text.trim(), input.revision, input.delivery]
					: [input.childId, input.revision],
			serviceGeneration: input.serviceGeneration,
			controlGeneration,
		})
		.then(
			(accepted) => {
				submission.operationId = accepted.operationId;
				if (submission.status === "sending") submission.status = "pending";
				const terminal = early.get(accepted.operationId);
				early.clear();
				if (terminal) finish(terminal);
				else submission.changed?.();
			},
			(error: unknown) => {
				// Only a parsed RPC rejection proves non-admission. A broken connection,
				// timeout, or retired UI is not evidence that the owner rejected the action.
				if ((error as { remoteRejected?: boolean })?.remoteRejected) {
					submission.status = "failed";
					submission.error = String(error);
					submission.changed?.();
					submission.release();
				} else submission.retire();
			},
		);
	return submission;
}
