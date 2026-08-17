import { LineFramer } from "./line-framer.ts";
import { HTTPWire } from "./http-wire.ts";
import type { ConnectionProfile } from "./connection-profile.ts";
import { discoverDaemon } from "./daemon-discovery.ts";
import { randomUUID } from "node:crypto";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	errorMessage,
	type AcceptedOperation,
	type AttachAck,
	type ClientFrame,
	type ControlState,
	type InteractionRequest,
	type LiveState,
	type OperationResult,
	type Reply,
	type ServerFrame,
	type Snapshot,
} from "./protocol.ts";

import type { LaunchProfile } from "./daemon-protocol.ts";

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}
interface PendingOperation {
	finish(operation: OperationResult): void;
	reject(error: Error): void;
}
// Native indexing only: this replica is created in memory and never persists.
interface ReplicaInternals {
	_appendEntry(entry: SessionEntry): void;
	_buildIndex(): void;
}

export interface TransportClient {
	readonly serverIdentity: string;
	clientId: string;
	socket: HTTPWire;
	readonly snapshot: Snapshot;
	readonly replica: SessionManager;
	live: LiveState;
	control: ControlState;
	pendingRequests: InteractionRequest[];
	seq: number;
	request<Result = unknown>(method: string, params?: Record<string, unknown>): Promise<Result>;
	onFrame(listener: (frame: ClientFrame) => void): () => boolean;
	attach(
		sessionId: string,
		options?: {
			control?: boolean;
			ifUnoccupied?: boolean;
			controlIfFree?: boolean;
			profile?: LaunchProfile;
			fileIdentity?: string;
		},
	): Promise<Snapshot>;
	takeControl(): Promise<ControlState>;
	releaseControl(): Promise<ControlState>;
	admit(command: string, args?: unknown[]): Promise<AcceptedOperation>;
	mutate<Result = unknown>(command: string, args?: unknown[]): Promise<Result>;
	answer(requestId: string, value: unknown): Promise<unknown>;
	close(): void;
}

export async function connect({
	clientId = randomUUID(),
	hello = {},
	connection,
}: {
	connection?: ConnectionProfile;
	clientId?: string;
	hello?: Record<string, unknown>;
} = {}): Promise<TransportClient> {
	if (!connection) {
		const descriptor = await discoverDaemon();
		connection = {
			version: 1,
			origin: descriptor.origin,
			token: descriptor.token,
			instanceId: descriptor.instanceId,
		};
	}
	const broker = !!connection.instanceId;
	hello = { ...hello, instanceId: connection.instanceId };
	const socket = new HTTPWire(connection, clientId);
	const pending = new Map<number, PendingRequest>();
	const listeners = new Set<(frame: ClientFrame) => void>();
	const operations = new Map<string, PendingOperation>();
	const completed = new Map<string, OperationResult>();
	const framer = new LineFramer();
	let next = 0;
	let conditionalAttach = false;
	let conditionalControl = false;
	let localCreateProfile = false;
	let attachmentGeneration = 0;
	let snapshot: Snapshot | undefined;
	let snapshotGeneration = 0;
	let replica: SessionManager | undefined;
	let live: LiveState | undefined;
	const client: TransportClient = {
		// Public connection identity only, never the authentication token.
		serverIdentity: JSON.stringify([
			connection.origin,
			connection.certificate ?? null,
			connection.instanceId ?? null,
		]),
		clientId,
		socket,
		get snapshot() {
			if (!snapshot) throw new Error("Session is not attached");
			return snapshot;
		},
		get replica() {
			if (!replica) throw new Error("Session is not attached");
			return replica;
		},
		get live() {
			if (!live) throw new Error("Session is not attached");
			return live;
		},
		set live(value) {
			live = value;
		},
		control: { controllerClientId: null, controlGeneration: 0 },
		pendingRequests: [],
		seq: 0,
		request<Result = unknown>(
			method: string,
			params: Record<string, unknown> = {},
		): Promise<Result> {
			return new Promise((resolve, reject) => {
				if ((method === "attach" && ((params.ifUnoccupied && !conditionalAttach) || (params.controlIfFree && !conditionalControl))) ||
					(method === "create" && params.profile !== undefined && !localCreateProfile)) {
					reject(
						Object.assign(new Error("DAEMON_RESTART_REQUIRED"), {
							code: "DAEMON_RESTART_REQUIRED",
						}),
					);
					return;
				}
				if (socket.destroyed) {
					reject(new Error("DISCONNECTED; mutation outcome may be uncertain; not replayed"));
					return;
				}
				const id = ++next;
				// The caller supplies the response contract for this local protocol method.
				pending.set(id, { resolve: (value) => resolve(value as Result), reject });
				socket.write(JSON.stringify({ id, method, params }) + "\n");
			});
		},
		onFrame(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async attach(sessionId, { control = false, ifUnoccupied = false, controlIfFree = false, profile, fileIdentity } = {}) {
			// Only detach operations when the successful snapshot is applied.
			const generation = snapshotGeneration;
			const ack = await this.request<AttachAck>("attach", {
				sessionId,
				// Old brokers must never interpret this request as an unconditional take.
				control: controlIfFree ? conditionalControl : control,
				controlIfFree: controlIfFree && conditionalControl,
				ifUnoccupied,
				profile,
				fileIdentity,
			});
			// HTTP acknowledgement and SSE snapshot travel independently.
			if (
				ack &&
				(!snapshot ||
					snapshotGeneration <= generation ||
					snapshot.sessionId !== ack.sessionId ||
					client.seq < ack.seq)
			) {
				await new Promise<void>((resolve, reject) => {
					if (socket.destroyed) {
						reject(Error("DISCONNECTED"));
						return;
					}
					const remove = this.onFrame((frame) => {
						if (frame.type === "disconnect") {
							remove();
							reject(Error("DISCONNECTED"));
						} else if (
							frame.type === "snapshot" &&
							frame.sessionId === ack.sessionId &&
							frame.seq >= ack.seq
						) {
							remove();
							resolve();
						}
					});
				});
			}
			if (
				!ack ||
				ack.sessionId !== sessionId ||
				!Number.isSafeInteger(ack.seq) ||
				!snapshot ||
				snapshotGeneration <= generation ||
				snapshot.sessionId !== ack.sessionId ||
				snapshot.seq !== ack.seq ||
				client.seq < ack.seq
			)
				throw new Error("INVALID_ATTACH_ACK; canonical snapshot does not match acknowledgement");
			return snapshot;
		},
		async takeControl() {
			const control = await this.request<ControlState>("takeControl");
			// HTTP can acknowledge before the corresponding SSE control frame.
			if (control.controlGeneration >= this.control.controlGeneration) this.control = control;
			return control;
		},
		async releaseControl() {
			const control = await this.request<ControlState>("releaseControl", {
				controlGeneration: this.control.controlGeneration,
			});
			if (control.controlGeneration >= this.control.controlGeneration) this.control = control;
			return control;
		},
		admit(command, args = []) {
			return this.request<AcceptedOperation>("mutate", {
				command,
				args,
				controlGeneration: this.control.controlGeneration,
			});
		},
		async mutate<Result = unknown>(command: string, args: unknown[] = []): Promise<Result> {
			const generation = attachmentGeneration;
			const accepted = await this.admit(command, args);
			if (generation !== attachmentGeneration) throw detachedError();
			return new Promise((resolve, reject) => {
				const finish = (operation: OperationResult) =>
					operation.error ? reject(new Error(operation.error)) : resolve(operation.value as Result);
				const result = completed.get(accepted.operationId);
				if (result) finish(result);
				else operations.set(accepted.operationId, { finish, reject });
			});
		},
		answer(requestId, value) {
			return this.request("answer", {
				requestId,
				value,
				controlGeneration: this.control.controlGeneration,
			});
		},
		close() {
			socket.end();
		},
	};
	function detachedError() {
		return new Error(
			"DETACHED; accepted operation continues on previous server session; not replayed",
		);
	}
	function detachOperations() {
		attachmentGeneration++;
		for (const operation of operations.values()) operation.reject(detachedError());
		operations.clear();
		completed.clear();
	}
	function settleOperation(operation: OperationResult) {
		if (operation.status === "running") return;
		completed.set(operation.operationId, operation);
		operations.get(operation.operationId)?.finish(operation);
		operations.delete(operation.operationId);
	}
	function apply(frame: ServerFrame) {
		if (frame.type === "snapshot" && snapshot && frame.sessionId !== snapshot.sessionId)
			detachOperations();
		if (frame.type === "operation" && frame.sessionId === snapshot?.sessionId)
			settleOperation(frame.operation);
		if (frame.type === "snapshot") {
			if (!frame.header) {
				socket.destroy(new Error("INVALID_SNAPSHOT; native session header is missing"));
				return;
			}
			snapshot = frame;
			snapshotGeneration++;
			client.seq = frame.seq;
			replica = SessionManager.inMemory(frame.cwd, {}, [frame.header, ...frame.entries]);
			live = frame.live;
			client.control = frame.control;
			client.pendingRequests = frame.pendingRequests;
			if (frame.leafId === null) replica.resetLeaf();
			else replica.branch(frame.leafId);
			// A relay swap may discard a queued completion frame. The canonical
			// snapshot is authoritative; reconcile terminal results without replay.
			for (const operation of frame.operations)
				if (operation.status === "completed" || operation.status === "failed")
					settleOperation(operation);
		} else if (frame.sessionId === snapshot?.sessionId && replica) {
			if (frame.seq !== client.seq + 1) {
				socket.destroy(new Error("SEQUENCE_GAP; reconnect for fresh snapshot"));
				return;
			}
			client.seq = frame.seq;
			if (frame.type === "append") {
				const internal = replica as unknown as ReplicaInternals;
				internal._appendEntry(frame.entry);
				if (frame.entry.type === "label") internal._buildIndex();
			}
			if (frame.type === "leaf") {
				if (frame.leafId === null) replica.resetLeaf();
				else replica.branch(frame.leafId);
			}
			if (frame.type === "live") live = frame.live;
			if (
				frame.type === "control" &&
				frame.control.controlGeneration >= client.control.controlGeneration
			)
				client.control = frame.control;
			if (frame.type === "interaction") client.pendingRequests.push(frame.request);
			if (frame.type === "interactionResolved")
				client.pendingRequests = client.pendingRequests.filter(
					(request) => request.id !== frame.requestId,
				);
		}
		for (const listener of listeners) {
			try {
				listener(frame);
			} catch (error) {
				console.error("frame listener:", error);
			}
		}
	}
	socket.setEncoding("utf8");
	socket.on("data", (data: string) => {
		for (const line of framer.push(data)) {
			let frame: Reply | ServerFrame;
			try {
				frame = JSON.parse(line) as Reply | ServerFrame;
			} catch (error) {
				socket.destroy(new Error(errorMessage(error)));
				return;
			}
			if ("replyTo" in frame) {
				const request = pending.get(frame.replyTo);
				pending.delete(frame.replyTo);
				if (frame.error)
					request?.reject(
						Object.assign(new Error(frame.error), {
							remoteRejected: true,
							code: frame.code,
							attachedClientCount: frame.attachedClientCount,
						}),
					);
				else request?.resolve(frame.result);
			} else apply(frame);
		}
	});
	socket.on("close", () => {
		for (const request of pending.values())
			request.reject(new Error("DISCONNECTED; mutation outcome may be uncertain; not replayed"));
		pending.clear();
		for (const operation of operations.values())
			operation.reject(
				new Error("DISCONNECTED; accepted operation continues on server; not replayed"),
			);
		operations.clear();
		for (const listener of listeners) listener({ type: "disconnect" });
	});
	socket.on("error", () => {});
	await socket.open();
	try {
		const identity = await client.request<{
			capabilities?: { conditionalAttach?: boolean; conditionalControl?: boolean; localCreateProfile?: boolean };
			protocol?: number;
			instanceId?: string;
			clientId?: string;
		}>("hello", { ...hello, clientId });
		if (broker && (identity?.protocol !== 1 || identity.instanceId !== hello.instanceId))
			throw Error("DAEMON_IDENTITY_MISMATCH");
		if (!identity.clientId) throw Error("CLIENT_IDENTITY_REQUIRED");
		client.clientId = identity.clientId;
		conditionalAttach = identity?.capabilities?.conditionalAttach === true;
		conditionalControl = identity?.capabilities?.conditionalControl === true;
		localCreateProfile = identity?.capabilities?.localCreateProfile === true;
		return client;
	} catch (error) {
		socket.destroy();
		throw error;
	}
}
