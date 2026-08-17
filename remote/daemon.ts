import { writeSocket } from "./socket-writer.ts";
import type { AttachAck, SessionActivity } from "./protocol.ts";
import { DaemonHTTP } from "./daemon-http.ts";
import { readRemoteConfig } from "./daemon-config.ts";
import { LineFramer } from "./line-framer.ts";
import net from "node:net";
import { sessionHome } from "../shared/session-home.ts";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	realpathSync,
	statSync,
	readdirSync,
	unlinkSync,
	lstatSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonPaths, privateDirectory } from "./daemon-discovery.ts";
import type {
	DaemonDescriptor,
	DaemonFrame,
	LaunchProfile,
	ManagedRecord,
} from "./daemon-protocol.ts";
export type { DaemonDescriptor, LaunchProfile, LauncherProfile } from "./daemon-protocol.ts";

type Params = Record<string, unknown>;
type Description = { id: string; sessionId: string; sessionFile?: string; [key: string]: unknown };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The SDK discovers native histories; ordinary CLI workers alone own live sessions. */
class WorkerWire {
	private sequence = 0;
	private conditionalAttach = false;
	private conditionalControl = false;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	onFrame: (frame: Params, rawLine: string) => void = () => {};
	onClose: () => void = () => {};
	private constructor(readonly socket: net.Socket) {
		const framer = new LineFramer();
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const line of framer.push(chunk)) {
				try {
					const frame = JSON.parse(line);
					if (typeof frame.replyTo === "number") {
						const request = this.pending.get(frame.replyTo);
						this.pending.delete(frame.replyTo);
						if (frame.error)
							request?.reject(
								Object.assign(new Error(frame.error), {
									code: frame.code,
									attachedClientCount: frame.attachedClientCount,
								}),
							);
						else request?.resolve(frame.result);
					} else this.onFrame(frame, line);
				} catch {
					socket.destroy();
				}
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			for (const request of this.pending.values())
				request.reject(new Error("WORKER_DISCONNECTED; outcome uncertain; not replayed"));
			this.pending.clear();
			this.onClose();
		});
	}
	static async connect(record: ManagedRecord, clientId: string, clientSocket?: net.Socket) {
		if (clientSocket?.destroyed) throw new Error("CLIENT_DISCONNECTED_DURING_ATTACH");
		const socket = net.createConnection(record.socketPath);
		const wire = new WorkerWire(socket);
		const abort = () => socket.destroy(new Error("CLIENT_DISCONNECTED_DURING_ATTACH"));
		clientSocket?.once("close", abort);
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			const identity = await wire.request<{ capabilities?: { conditionalAttach?: boolean; conditionalControl?: boolean } }>(
				"hello",
				{
					clientId,
					token: record.workerToken,
					workerToken: record.workerToken,
				},
			);
			wire.conditionalAttach = identity?.capabilities?.conditionalAttach === true;
			wire.conditionalControl = identity?.capabilities?.conditionalControl === true;
			return wire;
		} catch (error) {
			wire.close();
			throw error;
		} finally {
			clientSocket?.off("close", abort);
		}
	}
	request<T = unknown>(method: string, params: Params = {}): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (method === "attach" && params.ifUnoccupied && !this.conditionalAttach)
				return reject(
					Object.assign(new Error("DAEMON_RESTART_REQUIRED"), { code: "DAEMON_RESTART_REQUIRED" }),
				);
			// A newer broker can outlive older workers: degrade only to Watch.
			if (method === "attach" && params.controlIfFree && !this.conditionalControl)
				params = { ...params, control: false, controlIfFree: false };
			if (this.socket.destroyed) return reject(new Error("WORKER_DISCONNECTED"));
			const id = ++this.sequence;
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			writeSocket(this.socket, JSON.stringify({ id, method, params }) + "\n");
		});
	}
	close() {
		this.socket.destroy();
	}
}

function validateProfile(input: unknown): LaunchProfile {
	const supplied = input as Partial<LaunchProfile>;
	if (!supplied || typeof supplied !== "object") throw new Error("INVALID_LAUNCH_PROFILE");
	const p = {
		...supplied,
		executable: supplied.executable || process.execPath,
		cliPath: supplied.cliPath || process.argv[1],
		args: supplied.args || [],
		env: supplied.env || {},
	} as LaunchProfile;
	if (
		!p ||
		![p.agentDir, p.executable, p.cliPath].every(
			(v) => typeof v === "string" && isAbsolute(v),
		) ||
		!Array.isArray(p.args) ||
		!p.args.every((arg) => typeof arg === "string") ||
		!p.env ||
		typeof p.env !== "object"
	)
		throw new Error("INVALID_LAUNCH_PROFILE");
	const valueFlags = new Set([
		"--extension",
		"-e",
		"--skill",
		"--prompt-template",
		"--theme",
		"--use-theme",
		"--provider",
		"--model",
		"--thinking",
		"--models",
		"--tools",
		"-t",
		"--exclude-tools",
		"-xt",
		"--system-prompt",
		"--append-system-prompt",
		"--api-key",
		"--tui",
	]);
	const booleanFlags = new Set([
		"--no-extensions",
		"-ne",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-tools",
		"-nt",
		"--no-builtin-tools",
		"-nbt",
		"--verbose",
		"--offline",
	]);
	for (let index = 0; index < p.args.length; index++) {
		const arg = p.args[index]!;
		if (booleanFlags.has(arg)) continue;
		if (valueFlags.has(arg) && index + 1 < p.args.length && !p.args[index + 1]!.startsWith("-")) {
			index++;
			continue;
		}
		throw new Error("UNSUPPORTED_LAUNCH_ARGUMENT: " + arg);
	}
	return {
		executable: p.executable,
		cliPath: p.cliPath,
		agentDir: realpathSync(p.agentDir),
		args: [...p.args],
		env: { ...p.env },
	};
}

/** SDK resolves the normal directory; constructing a manager does not persist a history. */
function nativeDirectory(profile: LaunchProfile): string {
	return withAgentDir(profile.agentDir, () => SessionManager.create(sessionHome()).getSessionDir());
}
function withAgentDir<T>(agentDir: string, fn: () => T): T {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}
async function discoverNative(profile: LaunchProfile) {
	// The SDK captures its HOME session directory before its first await.
	const sessions = await withAgentDir(profile.agentDir, () =>
		SessionManager.list(sessionHome()),
	);
	return sessions.flatMap((info) => {
		try {
			const sessionFile = realpathSync(info.path);
			const stat = statSync(sessionFile);
			if (!stat.isFile()) return [];
			return [{ ...info, sessionFile, fileIdentity: `${stat.dev}:${stat.ino}` }];
		} catch {
			return [];
		}
	});
}
/** All native sessions use the daemon host's home as the SDK storage convention. */
function findNativeForAttach(profile: LaunchProfile, params: Params) {
	const { sessionId, fileIdentity: expectedIdentity } = params;
	if (typeof sessionId !== "string" || !sessionId)
		throw new Error("INVALID_SESSION_ID");
	if (expectedIdentity !== undefined && typeof expectedIdentity !== "string")
		throw new Error("INVALID_SESSION_FILE_IDENTITY");
	const file = withAgentDir(profile.agentDir, () => SessionManager.findById(sessionHome(), sessionId));
	if (!file) throw new Error("UNKNOWN_NATIVE_SESSION");
	const sessionFile = realpathSync(file);
	const stat = statSync(sessionFile);
	if (!stat.isFile()) throw new Error("UNKNOWN_NATIVE_SESSION");
	const fileIdentity = `${stat.dev}:${stat.ino}`;
	if (expectedIdentity !== undefined && expectedIdentity !== fileIdentity)
		throw new Error("SESSION_FILE_IDENTITY_CHANGED");
	return { id: sessionId, sessionFile, fileIdentity };
}
/** The ordinary CLI opens history once and confirms the expected native identity. */
function validateResumedDescription(record: ManagedRecord, description: Description) {
	if (record.sessionId !== undefined && description.id !== record.sessionId)
		throw new Error("SESSION_NATIVE_ID_CHANGED");
}
function withoutInitialSelection(profile: LaunchProfile): LaunchProfile {
	const args: string[] = [];
	for (let i = 0; i < profile.args.length; i++) {
		const arg = profile.args[i]!;
		if (["--provider", "--model", "--thinking"].includes(arg)) {
			i++;
			continue;
		}
		args.push(arg);
	}
	return { ...profile, args };
}

export async function serveDaemon(): Promise<void> {
	const paths = daemonPaths();
	privateDirectory(paths.directory);
	const guard = net.createServer((socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		guard.once("error", (error) =>
			reject(new Error("DAEMON_SINGLETON_UNAVAILABLE: " + message(error))),
		);
		guard.listen({ host: "127.0.0.1", port: paths.port, exclusive: true }, resolve);
	});
	let server: net.Server | undefined;
	let httpAPI: DaemonHTTP | undefined;
	let stopping = false;
	let requestStop: () => void = () => {};
	const shutdown = new Promise<void>((resolve) => {
		requestStop = resolve;
	});
	// Inherited listening file descriptions hold the kernel lock until every writer exits.
	const guardFD = (guard as unknown as { _handle?: { fd?: number } })._handle?.fd;
	if (typeof guardFD !== "number" || guardFD < 0) throw new Error("SINGLETON_FD_UNAVAILABLE");
	const clients = new Set<net.Socket>();
	const records = new Map<string, ManagedRecord>();
	// Bounded by connected clients and already-running native owners only.
	const activitySubscribers = new Map<net.Socket, { subscriptionId: string; profile: LaunchProfile }>();
	const activities = new Map<string, SessionActivity>();
	function visibleActivity(record: ManagedRecord, subscription: { profile: LaunchProfile }) {
		return record.agentDir === subscription.profile.agentDir;
	}
	function publishActivity(record: ManagedRecord, activity: SessionActivity, baseline = false) {
		activities.set(record.ownerId, activity);
		for (const [socket, subscription] of activitySubscribers) {
			if (!socket.destroyed && visibleActivity(record, subscription))
				writeSocket(socket, JSON.stringify({ type: "sessionActivity", subscriptionId: subscription.subscriptionId, activity, ...(baseline ? { baseline: true } : {}) }) + "\n");
		}
	}
	function removeActivity(record: ManagedRecord) {
		const activity = activities.get(record.ownerId);
		if (activity) publishActivity(record, { ...activity, revision: activity.revision + 1, working: null, removed: true });
		activities.delete(record.ownerId);
	}
	const running = new Map<
		string,
		{ child: ChildProcess; profile: LaunchProfile; wire?: WorkerWire }
	>();
	let serial: Promise<unknown> = Promise.resolve();
	function exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const next = serial.then(fn);
		serial = next.catch(() => {});
		return next;
	}
	function claim(record: ManagedRecord, file: string) {
		const canonicalFile = realpathSync(file);
		const stat = statSync(canonicalFile);
		if (!stat.isFile()) throw new Error("SESSION_NOT_REGULAR_FILE");
		const fileIdentity = `${stat.dev}:${stat.ino}`;
		if (
			record.canonicalFile &&
			(record.canonicalFile !== canonicalFile || record.fileIdentity !== fileIdentity)
		)
			throw new Error("SESSION_FILE_IDENTITY_CHANGED");
		for (const other of records.values()) {
			if (
				other.ownerId !== record.ownerId &&
				(other.canonicalFile === canonicalFile || other.fileIdentity === fileIdentity)
			)
				throw new Error("SESSION_ALREADY_CLAIMED: " + other.ownerId);
		}
		Object.assign(record, { sessionFile: canonicalFile, canonicalFile, fileIdentity });
	}
	function find(id: unknown) {
		const record = [...records.values()].find((r) => r.ownerId === id || r.sessionId === id);
		if (!record) throw new Error("UNKNOWN_MANAGED_SESSION");
		if (record.status !== "ready" || !running.get(record.ownerId)?.wire)
			throw new Error("SESSION_NOT_READY: " + record.status);
		return record;
	}
	async function launch(
		profile: LaunchProfile,
		source?: ManagedRecord,
		leafId?: unknown,
		resume?: ManagedRecord,
		forkWire?: WorkerWire,
		controlGeneration?: unknown,
	) {
		if (stopping) throw new Error("DAEMON_STOPPING");
		if (resume) profile = withoutInitialSelection(profile);
		const sessionDirectory = nativeDirectory(profile);
		const ownerId = resume?.ownerId || randomUUID();

		const record: ManagedRecord = resume || {
			ownerId,
			status: "launching",
			socketPath: "",
			workerToken: "",
			agentDir: profile.agentDir,
		};
		Object.assign(record, {
			status: "launching",
			socketPath: join(paths.directory, ownerId + ".sock"),
			workerToken: randomUUID(),
		});
		records.set(ownerId, record);
		try {
			if (source) {
				const sourceWire = forkWire;
				if (!sourceWire) throw new Error("SOURCE_WORKER_UNAVAILABLE");
				const fork = await sourceWire.request<{
					sessionFile: string;
					model?: { provider: string; modelId: string };
					thinkingLevel?: string;
				}>("prepareFork", {
					leafId,
					sessionDirectory,
					controlGeneration,
				});
				claim(record, fork.sessionFile);
				const args: string[] = [];
				for (let i = 0; i < profile.args.length; i++) {
					const arg = profile.args[i]!;
					if (["--provider", "--model", "--thinking"].includes(arg)) {
						i++;
						continue;
					}
					if (/^--(?:provider|model|thinking)=/.test(arg)) continue;
					args.push(arg);
				}
				if (fork.model) args.push("--provider", fork.model.provider, "--model", fork.model.modelId);
				if (fork.thinkingLevel) args.push("--thinking", fork.thinkingLevel);
				profile = { ...profile, args };
			}
			if (stopping) throw new Error("DAEMON_STOPPING");
			if (record.sessionFile) {
				claim(record, record.sessionFile);
			}
			const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
			const hasWorkerExtension = profile.args.some(
				(arg, index) =>
					(arg === "--extension" || arg === "-e") && profile.args[index + 1] === extensionPath,
			);
			const extensionArgs = hasWorkerExtension ? [] : ["--extension", extensionPath];
			const args = [
				profile.cliPath,
				"--mode",
				"rpc",
				...profile.args,
				...extensionArgs,
				"--session-dir",
				sessionDirectory,
				"--session-link-worker",
				record.workerToken,
				"--session-link-socket",
				record.socketPath,
			];
			if (record.sessionFile) args.push("--session", record.sessionFile);
			const child = spawn(profile.executable, args, {
				cwd: sessionHome(),
				env: {
					...profile.env,
					PI_CODING_AGENT_DIR: profile.agentDir,
					PI_SESSION_LINK_SOCKET: record.socketPath,
					PI_SESSION_LINK_GUARD_FD: "3",
				},
				stdio: ["pipe", "ignore", "ignore", guardFD],
			});
			const runtime = { child, profile, wire: undefined as WorkerWire | undefined };
			running.set(ownerId, runtime);
			let exited = false;
			let launchError: Error | undefined;
			child.once("error", (error) => {
				launchError = error;
			});
			child.once("exit", () => {
				exited = true;
				runtime.wire?.close();
				// A retired child's delayed exit must not retire its replacement.
				if (running.get(ownerId) !== runtime) return;
				removeActivity(record);
				running.delete(ownerId);
				try {
					unlinkSync(record.socketPath);
				} catch {}
				if (record.status !== "quarantined") record.status = "stopped";
			});
			record.pid = child.pid;
			for (let attempt = 0; !existsSync(record.socketPath); attempt++) {
				if (exited || launchError) throw launchError || new Error("WORKER_EXITED_DURING_START");
				if (attempt >= 600 || stopping) throw new Error("WORKER_START_TIMEOUT");
				await pause(100);
			}
			runtime.wire = await WorkerWire.connect(record, "daemon-supervisor-" + ownerId);
			const descriptions = await runtime.wire.request<Description[]>("list");
			const description = descriptions[0];
			if (!description?.id || descriptions.length !== 1) throw new Error("INVALID_WORKER_ROOTS");
			if (resume) validateResumedDescription(record, description);
			for (const other of records.values())
				if (other.ownerId !== ownerId && other.sessionId === description.id)
					throw new Error("DUPLICATE_NATIVE_SESSION_ID");
			if (description.sessionFile) {
				record.sessionFile = description.sessionFile;
				if (existsSync(description.sessionFile)) claim(record, description.sessionFile);
			}
			record.sessionId = description.id;
			record.status = "ready";
			const activityWire = runtime.wire;
			const isCurrentActivityWire = () => running.get(ownerId) === runtime && runtime.wire === activityWire;
			activityWire.onClose = () => {
				if (isCurrentActivityWire()) removeActivity(record);
			};
			activityWire.onFrame = (frame) => {
				if (!isCurrentActivityWire() || activityWire.socket.destroyed || frame.type !== "ownerActivity") return;
				const activity = frame.activity as SessionActivity;
				const previous = activities.get(ownerId);
				if (activity.sessionId !== record.sessionId || (previous && activity.ownerIncarnation === previous.ownerIncarnation && activity.revision <= previous.revision)) return;
				publishActivity(record, activity, !previous || previous.ownerIncarnation !== activity.ownerIncarnation);
			};
			const initialActivity = await activityWire.request<SessionActivity>("observeActivity");
			const latestActivity = activities.get(ownerId);
			if (isCurrentActivityWire() && !activityWire.socket.destroyed && (!latestActivity || latestActivity.revision < initialActivity.revision))
				publishActivity(record, initialActivity, !latestActivity);
			return { ...description, ownerId, status: record.status, agentDir: record.agentDir };
		} catch (error) {
			if (record.status !== "stopped") record.status = "quarantined";
			running.get(ownerId)?.child.kill("SIGTERM");
			throw error;
		}
	}
	try {
		// Only the acquired kernel singleton proves no previous worker can still write.
		for (const name of readdirSync(paths.directory)) {
			const file = join(paths.directory, name);
			const stat = lstatSync(file);
			if (stat.uid !== paths.uid || !stat.isSocket())
				throw new Error("UNSAFE_RUNTIME_ENTRY: " + file);
			unlinkSync(file);
		}
		const descriptor: DaemonDescriptor = {
			protocol: 1,
			instanceId: randomUUID(),
			pid: process.pid,
			uid: paths.uid,
			token: randomUUID(),
			socketPath: paths.socketPath,
			origin: "",
		};
		const remoteConfigPath =
			process.env.PI_SESSION_LINK_REMOTE_CONFIG ||
			join(getAgentDir(), "session-link", "remote-config.json");
		const remoteProfile = process.env.PI_SESSION_LINK_LAUNCH_PROFILE
			? validateProfile(JSON.parse(process.env.PI_SESSION_LINK_LAUNCH_PROFILE))
			: validateProfile({
					agentDir: getAgentDir(),
					executable: process.execPath,
					cliPath: process.argv[1],
					args: [],
					env: { ...process.env },
				});
		httpAPI = new DaemonHTTP(
			descriptor,
			existsSync(remoteConfigPath) ? readRemoteConfig(remoteConfigPath) : undefined,
			remoteProfile,
		);
		server = net.createServer((socket) => {
			clients.add(socket);
			const framer = new LineFramer();
			let clientId: string | undefined;
			let relay: WorkerWire | undefined;
			let attached: ManagedRecord | undefined;
			let chain: Promise<unknown> = Promise.resolve();
			const send = (frame: unknown) => {
				if (!socket.destroyed) writeSocket(socket, JSON.stringify(frame) + "\n");
			};
			async function attach(record: ManagedRecord, control: boolean, ifUnoccupied = false, controlIfFree = false) {
				const candidate = await WorkerWire.connect(record, clientId!, socket);

				if (socket.destroyed) {
					candidate.close();
					throw new Error("CLIENT_DISCONNECTED_DURING_ATTACH");
				}
				let snapshotReceived = false;
				candidate.onFrame = (frame, rawLine) => {
					if (!snapshotReceived) {
						if (frame.type !== "snapshot") return;
						// Same-session reattachment temporarily has two worker wires.
						// Switch their output at the snapshot boundary to avoid duplicate sequences.
						if (relay) relay.onFrame = () => {};
						snapshotReceived = true;
					}
					if (!socket.destroyed) {
						writeSocket(socket, rawLine);
						writeSocket(socket, "\n");
					}
				};
				try {
					const ack = await candidate.request<AttachAck>("attach", {
						sessionId: record.sessionId,
						control,
						ifUnoccupied,
						controlIfFree,
					});
					if (relay) {
						relay.onClose = () => {};
						relay.close();
					}
					attached = record;
					relay = candidate;
					relay.onClose = () => socket.destroy();
					return ack;
				} catch (error) {
					candidate.close();
					throw error;
				}
			}
			async function request(frame: DaemonFrame) {
				const p = frame.params || {};
				if (frame.method === "discover") {
					if (stopping) throw Error("DAEMON_STOPPING");
					return httpAPI!.discover();
				}
				// This private Unix socket is local OS-user authority, never reachable through HTTP.
				if (frame.method === "exportCredential")
					return httpAPI!.exportCredential(String(p.label ?? ""));
				if (frame.method === "revokeCredential") return httpAPI!.revoke(String(p.clientId ?? ""));
				if (frame.method === "listCredentials") return httpAPI!.listCredentials();
				if (frame.method === "configureRemote")
					return exclusive(() => httpAPI!.configureRemote(String(p.configPath ?? "")));
				if (frame.method === "stop") {
					stopping = true;
					setImmediate(requestStop);
					return { stopping: true };
				}
				if (frame.method === "hello") {
					if (
						clientId ||
						p.token !== descriptor.token ||
						(p.instanceId ?? p.daemonInstanceId) !== descriptor.instanceId
					)
						throw new Error("DAEMON_AUTHENTICATION_FAILED");
					clientId = typeof p.clientId === "string" ? p.clientId : randomUUID();
					return {
						protocol: 1,
						clientId,
						instanceId: descriptor.instanceId,
						capabilities: { conditionalAttach: true, conditionalControl: true, localCreateProfile: true, sessionActivity: true },
					};
				}
				if (!clientId) throw new Error("HELLO_FIRST");
				if (frame.method === "subscribeActivity") {
					const profile = validateProfile(p.profile);
					const subscription = { subscriptionId: randomUUID(), profile };
					// Observer registration and baseline capture are atomic (no await).
					activitySubscribers.set(socket, subscription);
					return { subscriptionId: subscription.subscriptionId, activities: [...activities].flatMap(([ownerId, activity]) => {
						const record = records.get(ownerId);
						return record && visibleActivity(record, subscription) ? [activity] : [];
					}) };
				}
				if (frame.method === "list") {
					return exclusive(async () => {
						const profile = p.profile === undefined ? undefined : validateProfile(p.profile);
						const native = profile ? await discoverNative(profile) : [];
						const inactive = {
							attachedClientCount: 0,
							header: null,
							leafId: null,
							streaming: false,
							pendingRequests: 0,
							control: { controllerClientId: null, controlGeneration: 0 },
						};
						const result: Params[] = [];
						for (const record of records.values()) {
							if (profile && record.agentDir !== profile.agentDir)
								continue;
							const wire = running.get(record.ownerId)?.wire;
							const description =
								record.status === "ready" && wire
									? (await wire.request<Description[]>("list", { excludeClientId: clientId }))[0]
									: undefined;
							const file = description?.sessionFile || record.sessionFile;
							const persisted = !!file && existsSync(file);
							if (persisted) claim(record, file);
							// Native persistence is lazy. A live managed root is still discoverable
							// before its first history write; keep it only in the in-memory registry.
							if (!persisted && !description) continue;
							const info = native.find((n) => n.fileIdentity === record.fileIdentity);
							// Inactive records must still belong to the native picker. Live records
							// were already filtered against this agentDir above.
							if (profile && !info && !description) continue;
							result.push({
								...inactive,
								...info,
								...description,
								id: record.sessionId || record.ownerId,
								sessionId: record.sessionId || record.ownerId,
								ownerId: record.ownerId,
								status: record.status,
								sessionFile: record.sessionFile,
								fileIdentity: record.fileIdentity,
								cwd: sessionHome(),
								agentDir: record.agentDir,
							});
						}
						for (const info of native) {
							if (result.some((r) => r.fileIdentity === info.fileIdentity)) continue;
							result.push({
								...inactive,
								...info,
								sessionId: info.id,
								status: "available",
								agentDir: profile!.agentDir,
							});
						}
						return result;
					});
				}
				if (frame.method === "create") {
					// Initial local creation uses its authenticated client profile, not the
					// first daemon starter. Attached /new still inherits the native owner.
					const inherited = attached && running.get(attached.ownerId)?.profile;
					let profile: LaunchProfile;
					if (inherited && relay) {
						const live = await relay.request<{
							model?: { provider: string; id: string };
							thinking?: string;
						}>("get");
						const replaced = new Set<string>();
						if (live.model) {
							replaced.add("--provider");
							replaced.add("--model");
						}
						if (live.thinking) replaced.add("--thinking");
						const args: string[] = [];
						for (let index = 0; index < inherited.args.length; index++) {
							const arg = inherited.args[index]!;
							if (replaced.has(arg)) {
								index++;
								continue;
							}
							if ([...replaced].some((flag) => arg.startsWith(flag + "="))) continue;
							args.push(arg);
						}
						if (live.model) args.push("--provider", live.model.provider, "--model", live.model.id);
						if (live.thinking) args.push("--thinking", live.thinking);
						profile = { ...inherited, args };
					} else profile = p.profile === undefined ? remoteProfile : validateProfile(p.profile);
					return exclusive(() => launch(profile));
				}
				if (frame.method === "attach") {
					const record = await exclusive(async () => {
						const profile = p.profile === undefined ? undefined : validateProfile(p.profile);
						let record = [...records.values()].find(
							(r) => r.ownerId === p.sessionId || r.sessionId === p.sessionId,
						);
						if (!record) {
							if (!profile) throw new Error("LAUNCH_PROFILE_REQUIRED");
							const info = await findNativeForAttach(profile, p);
							record = [...records.values()].find(
								(r) => r.canonicalFile === info.sessionFile || r.fileIdentity === info.fileIdentity,
							);
							if (record?.sessionId !== undefined && record.sessionId !== info.id)
								throw new Error("SESSION_NATIVE_ID_CHANGED");
							if (record) record.sessionId = info.id;
							if (!record) {
								const ownerId = randomUUID();
								record = {
									ownerId,
									sessionId: info.id,
									status: "stopped",
									socketPath: "",
									workerToken: "",
									agentDir: profile.agentDir,
								};
								claim(record, info.sessionFile);
								// Claim stays in memory while the inherited kernel lock fences writers.
							}
						}
						if (profile && record.agentDir !== profile.agentDir)
							throw new Error("SESSION_PROFILE_CONFLICT");
						if (p.fileIdentity !== undefined && record.fileIdentity !== p.fileIdentity)
							throw new Error("SESSION_FILE_IDENTITY_CHANGED");
						if (record.status === "stopped") {
							if (!profile) throw new Error("LAUNCH_PROFILE_REQUIRED");
							if (!record.sessionFile || !existsSync(record.sessionFile))
								throw new Error("STOPPED_SESSION_NOT_PERSISTED");

							await launch(profile, undefined, undefined, record);
						}
						if (record.sessionFile && existsSync(record.sessionFile))
							claim(record, record.sessionFile);
						return find(record.ownerId);
					});
					return attach(record, !!p.control, !!p.ifUnoccupied, !!p.controlIfFree);
				}
				if (frame.method === "fork") {
					if (!attached) throw new Error("ATTACH_FIRST");
					const source = find(attached.ownerId);
					const profile = running.get(source.ownerId)!.profile;
					const sourceRelay = relay;
					const result = await exclusive(() =>
						launch(profile, source, p.leafId, undefined, sourceRelay, p.controlGeneration),
					);
					return attach(find(result.ownerId), true);
				}
				if (!relay) throw new Error("ATTACH_FIRST");
				if (frame.method === "prepareFork") throw new Error("DAEMON_INTERNAL_ONLY");
				return relay.request(frame.method, p);
			}
			socket.setEncoding("utf8");
			socket.on("data", (data: string) => {
				for (const line of framer.push(data)) {
					let frame: DaemonFrame;
					try {
						frame = JSON.parse(line);
						if (
							!frame ||
							typeof frame.id !== "number" ||
							typeof frame.method !== "string" ||
							(frame.params !== undefined && (!frame.params || typeof frame.params !== "object"))
						)
							throw new Error("INVALID_FRAME");
					} catch {
						socket.destroy();
						return;
					}
					chain = chain.then(async () => {
						try {
							send({ replyTo: frame.id, result: await request(frame) });
						} catch (error) {
							send({
								replyTo: frame.id,
								error: message(error),
								...(error instanceof Error && "code" in error
									? {
											code: error.code,
											attachedClientCount: (error as Error & { attachedClientCount?: number })
												.attachedClientCount,
										}
									: {}),
							});
						}
					});
				}
			});
			socket.on("error", () => {});
			socket.on("close", () => {
				clients.delete(socket);
				activitySubscribers.delete(socket);
				relay?.close();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(descriptor.socketPath, resolve);
		});
		chmodSync(descriptor.socketPath, 0o600);
		await httpAPI.start();
		descriptor.origin = httpAPI.origin;

		console.error(
			JSON.stringify({ sessionLinkDaemonReady: true, ...descriptor, token: "[private]" }),
		);
		process.on("SIGTERM", requestStop);
		process.on("SIGINT", requestStop);
		try {
			await shutdown;
		} finally {
			process.off("SIGTERM", requestStop);
			process.off("SIGINT", requestStop);
		}
	} finally {
		stopping = true;
		await httpAPI?.close();
		for (const socket of clients) socket.destroy();
		await Promise.all(
			[...running.values()].map(async (runtime) => {
				runtime.wire?.close();
				const exited = new Promise<void>((resolve) => runtime.child.once("exit", () => resolve()));
				runtime.child.kill("SIGTERM");
				await Promise.race([exited, pause(3000)]);
			}),
		);
		// Surviving workers retain the inherited lock even after this daemon exits.
		if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
		await new Promise<void>((resolve) => guard.close(() => resolve()));
	}
}
