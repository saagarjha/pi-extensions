import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { LineFramer } from "./line-framer.ts";
import {
	newToken,
	tokenHash,
	RemoteCredentials,
	readRemoteConfig,
	type RemoteConfig,
} from "./daemon-config.ts";
import type { DaemonDescriptor, LaunchProfile } from "./daemon-protocol.ts";

type Frame = Record<string, unknown>;
interface Credential {
	clientId: string;
	hash: string;
	label: string;
	remote: boolean;
}
/** One internal connection per credential-bound logical client, never per HTTP socket.
 * Losing SSE releases presence; already-dispatched worker operations continue independently. */
class LogicalClient {
	private socket: net.Socket;
	private sequence = 0;
	private pending = new Map<number, (frame: Frame) => void>();
	private streams = new Set<ServerResponse>();
	private output: string[] = [];
	private draining = false;
	private dead = false;
	private activeStream?: ServerResponse;
	private idleTimer?: ReturnType<typeof setTimeout>;
	get closed() {
		return this.dead;
	}
	readonly ready: Promise<Frame>;
	constructor(
		descriptor: DaemonDescriptor,
		readonly credential: Credential,
		logicalId: string,
	) {
		this.idleTimer = setTimeout(() => this.close(), 30000);
		this.idleTimer.unref();
		this.socket = net.createConnection(descriptor.socketPath);
		const framer = new LineFramer();
		this.socket.setEncoding("utf8");
		this.socket.on("data", (chunk: string) => {
			try {
				for (const line of framer.push(chunk)) {
					// Replies originate in daemon.send with replyTo first. Events are already serialized
					// worker frames: forwarding raw avoids re-serializing potentially huge snapshots.
					if (/^\s*\{\s*"replyTo"\s*:/.test(line)) {
						const frame = JSON.parse(line);
						const resolve = this.pending.get(frame.replyTo);
						this.pending.delete(frame.replyTo);
						resolve?.(frame);
					} else this.event(line);
				}
			} catch {
				this.close();
			}
		});
		this.socket.on("error", () => this.close());
		this.socket.on("close", () => this.close());
		this.ready = new Promise<void>((resolve, reject) => {
			this.socket.once("connect", resolve);
			this.socket.once("error", reject);
		})
			.then(() =>
				this.call("hello", {
					token: descriptor.token,
					instanceId: descriptor.instanceId,
					clientId: createHash("sha256")
						.update(credential.clientId + ":" + logicalId)
						.digest("hex"),
				}),
			)
			.then((frame) => {
				if (frame.error) throw new Error(String(frame.error));
				return frame.result as Frame;
			});
		void this.ready.catch(() => this.close());
	}
	call(method: string, params: Frame): Promise<Frame> {
		if (this.dead)
			return Promise.reject(new Error("DAEMON_DISCONNECTED; outcome uncertain; not replayed"));
		const id = ++this.sequence;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.socket.write(JSON.stringify({ id, method, params }) + "\n");
		});
	}
	private event(rawLine: string) {
		if (!this.activeStream) return;
		this.output.push("data: ", rawLine, "\n\n");
		this.flush();
	}
	private flush() {
		const stream = this.activeStream;
		if (!stream || this.draining) return;
		while (this.output.length) {
			const chunk = this.output.shift()!;
			if (!stream.write(chunk)) {
				this.draining = true;
				this.socket.pause();
				stream.once("drain", () => {
					if (this.activeStream !== stream || this.dead) return;
					this.draining = false;
					this.flush();
					if (!this.draining) this.socket.resume();
				});
				return;
			}
		}
	}
	subscribe(res: ServerResponse) {
		if (this.dead) throw new Error("DAEMON_DISCONNECTED");
		clearTimeout(this.idleTimer);
		const previous = this.activeStream;
		this.activeStream = res;
		this.output = [];
		this.draining = false;
		this.socket.resume();
		previous?.end();
		res.on("close", () => {
			if (this.activeStream === res) this.close();
		});
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			"x-accel-buffering": "no",
			connection: "keep-alive",
		});
		res.write(": connected\n\n");
		this.streams.add(res);
		const heartbeat = setInterval(() => {
			if (!this.draining && !this.output.length) {
				this.output.push(": heartbeat\n\n");
				this.flush();
			}
		}, 15000);
		heartbeat.unref();
		res.on("close", () => {
			clearInterval(heartbeat);
			this.streams.delete(res);
		});
	}
	close() {
		if (this.dead) return;
		this.dead = true;
		clearTimeout(this.idleTimer);
		this.socket.destroy();
		for (const resolve of this.pending.values())
			resolve({
				error: "DAEMON_DISCONNECTED; outcome uncertain; not replayed",
				code: "OUTCOME_UNCERTAIN",
			});
		this.pending.clear();
		for (const res of this.streams) res.end();
		this.streams.clear();
	}
}

export class DaemonHTTP {
	private local = http.createServer((req, res) => {
		void this.handle(req, res, false);
	});
	private remote?: https.Server;
	private ssh?: ChildProcess;
	private sshTimer?: ReturnType<typeof setTimeout>;
	private stopped = false;
	private configuring: Promise<unknown> = Promise.resolve();
	private credentials = new Map<string, Credential>();
	private clients = new Map<string, LogicalClient>();
	private profiles = new Map<string, { credentialHash: string; profile: unknown }>();
	private store?: RemoteCredentials;
	origin = "";
	constructor(
		private descriptor: DaemonDescriptor,
		private config?: RemoteConfig,
		private remoteProfile?: LaunchProfile,
	) {}
	private listen(server: http.Server | https.Server, port: number) {
		return new Promise<number>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => {
				server.off("error", reject);
				resolve((server.address() as net.AddressInfo).port);
			});
		});
	}
	async start() {
		this.origin = `http://127.0.0.1:${await this.listen(this.local, 0)}`;
		if (this.config) await this.startRemote(this.config);
	}
	configureRemote(configPath: string) {
		const next = this.configuring.then(() => this.applyRemoteConfig(configPath));
		this.configuring = next.catch(() => {});
		return next;
	}
	private async applyRemoteConfig(configPath: string) {
		if (this.stopped) throw new Error("DAEMON_STOPPING");
		const config = readRemoteConfig(configPath);
		if (this.config) {
			if (JSON.stringify(config) === JSON.stringify(this.config))
				return { configured: true, unchanged: true };
			return {
				configured: false,
				restartRequired: true,
				error: "REMOTE_RECONFIGURATION_REQUIRES_EXPLICIT_STOP_START",
			};
		}
		await this.startRemote(config);
		return { configured: true };
	}
	private async startRemote(config: RemoteConfig) {
		const store = new RemoteCredentials(config);
		const remote = https.createServer(
			{ cert: store.cert, key: store.key, minVersion: "TLSv1.2" },
			(req, res) => {
				void this.handle(req, res, true);
			},
		);
		let port: number;
		try {
			port = await this.listen(remote, config.listenPort);
		} catch (error) {
			remote.close();
			throw error;
		}
		if (this.stopped) {
			await new Promise<void>((resolve) => remote.close(() => resolve()));
			throw new Error("DAEMON_STOPPING");
		}
		this.config = config;
		this.store = store;
		this.remote = remote;
		for (const c of store.credentials.values())
			this.credentials.set(c.hash, { ...c, remote: true });
		const connect = () => {
			if (this.stopped) return;
			// TLS terminates here. The relay only forwards TCP; no enrollment endpoint exists.
			this.ssh = spawn(
				"ssh",
				[
					"-N",
					"-T",
					"-o",
					"BatchMode=yes",
					"-o",
					"ExitOnForwardFailure=yes",
					"-o",
					"ServerAliveInterval=30",
					"-o",
					"ServerAliveCountMax=3",
					"-R",
					`127.0.0.1:${this.config!.relayPort}:127.0.0.1:${port}`,
					this.config!.sshDestination,
				],
				{ stdio: "ignore" },
			);
			let scheduled = false;
			const retry = () => {
				if (scheduled || this.stopped) return;
				scheduled = true;
				this.sshTimer = setTimeout(connect, 5000);
				this.sshTimer.unref();
			};
			this.ssh.once("error", retry);
			this.ssh.once("exit", retry);
		};
		connect();
	}
	discover(): DaemonDescriptor {
		const token = newToken(),
			hash = tokenHash(token);
		this.credentials.set(hash, { hash, clientId: randomUUID(), label: "local", remote: false });
		return { ...this.descriptor, origin: this.origin, token };
	}
	exportCredential(label: string) {
		if (!this.store || !this.config) throw new Error("REMOTE_NOT_CONFIGURED");
		if (!label) throw new Error("INVALID_CLIENT_LABEL");
		if ([...this.store.credentials.values()].some((c) => c.label === label))
			throw new Error("CLIENT_LABEL_ALREADY_EXISTS");
		const token = newToken(),
			hash = tokenHash(token),
			clientId = randomUUID();
		const record = { hash, clientId, label };
		this.store.credentials.set(hash, record);
		try {
			this.store.save();
		} catch (error) {
			this.store.credentials.delete(hash);
			throw error;
		}
		this.credentials.set(hash, { ...record, remote: true });
		return {
			clientId,
			bundle: Buffer.from(
				JSON.stringify({
					version: 1,
					origin: this.config.origin,
					certificate: this.store.cert,
					token,
				}),
			).toString("base64"),
		};
	}
	listCredentials() {
		return [...this.credentials.values()]
			.filter((c) => c.remote)
			.map(({ clientId, label }) => ({ clientId, label }));
	}
	revoke(clientId: string) {
		const credential = [...this.credentials.values()].find((c) => c.clientId === clientId);
		if (!credential) throw new Error("UNKNOWN_CLIENT");
		if (credential.remote) {
			this.store!.credentials.delete(credential.hash);
			try {
				this.store!.save();
			} catch (error) {
				this.store!.credentials.set(credential.hash, credential);
				throw error;
			}
		}
		this.credentials.delete(credential.hash);
		for (const [id, profile] of this.profiles)
			if (profile.credentialHash === credential.hash) this.profiles.delete(id);
		for (const [key, client] of this.clients)
			if (client.credential.hash === credential.hash) {
				client.close();
				this.clients.delete(key);
			}
		return { revoked: true };
	}
	private async handle(req: IncomingMessage, res: ServerResponse, remote: boolean) {
		const json = (status: number, value: unknown) => {
			if (!res.destroyed) {
				res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
				res.end(JSON.stringify(value));
			}
		};
		try {
			// No browser-origin authority and no cookie auth: all endpoints require a bearer.
			if (req.headers.origin) return json(403, { error: "BROWSER_ORIGIN_NOT_ALLOWED" });
			const authorization = req.headers.authorization;
			const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
			const credential = token && this.credentials.get(tokenHash(token));
			if (!credential || credential.remote !== remote) return json(401, { error: "UNAUTHORIZED" });
			const logicalId = req.headers["x-pi-client"];
			if (
				typeof logicalId !== "string" ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(logicalId)
			)
				return json(400, { error: "LOGICAL_CLIENT_UUID_REQUIRED" });
			const url = new URL(req.url ?? "/", "http://localhost");
			const path = url.pathname;
			if (!["/v1/hello", "/v1/events", "/v1/rpc", "/v1/state"].includes(path))
				return json(404, { error: "NOT_FOUND" });
			for (const [key, value] of this.clients) if (value.closed) this.clients.delete(key);
			const key = credential.hash + ":" + logicalId.toLowerCase();
			let client = this.clients.get(key);
			if (!client) {
				client = new LogicalClient(this.descriptor, credential, logicalId.toLowerCase());
				this.clients.set(key, client);
			}
			const hello = await client.ready;
			if (!this.credentials.has(credential.hash)) return json(401, { error: "CREDENTIAL_REVOKED" });
			if (path === "/v1/hello" && req.method === "GET") return json(200, hello);
			if (path === "/v1/events" && req.method === "GET") {
				// Events are live only, not a durable log. Establish SSE before attach; on
				// reconnect explicitly reattach for an authoritative fresh worker snapshot.
				client.subscribe(res);
				return;
			}
			if (path === "/v1/state" && req.method === "GET") {
				const method = url.searchParams.get("method");
				if (
					!method ||
					!["list", "subscribeActivity", "get", "snapshot", "operation", "serviceRead"].includes(
						method,
					)
				)
					return json(400, { error: "INVALID_READ_METHOD" });
				const params = JSON.parse(url.searchParams.get("params") ?? "{}");
				if (!params || typeof params !== "object" || Array.isArray(params))
					return json(400, { error: "INVALID_PARAMS" });
				if (Object.hasOwn(params, "profile"))
					return json(400, { error: "PROFILE_REQUIRES_POST_REGISTRATION" });
				const result = await client.call(method, this.parameters(method, params, credential));
				json(200, { ...result, replyTo: 0 });
				return;
			}
			if (path !== "/v1/rpc" || req.method !== "POST")
				return json(405, { error: "METHOD_NOT_ALLOWED" });
			if (!req.headers["content-type"]?.startsWith("application/json"))
				return json(415, { error: "JSON_REQUIRED" });
			let body = "";
			req.setEncoding("utf8");
			for await (const chunk of req) body += chunk;
			const frame = JSON.parse(body);
			if (
				!frame ||
				!Number.isSafeInteger(frame.id) ||
				typeof frame.method !== "string" ||
				(frame.params !== undefined &&
					(!frame.params || typeof frame.params !== "object" || Array.isArray(frame.params)))
			)
				return json(400, { error: "INVALID_FRAME" });
			if (
				[
					"hello",
					"discover",
					"exportCredential",
					"revokeCredential",
					"listCredentials",
					"configureRemote",
					"stop",
					"prepareFork",
				].includes(frame.method)
			)
				return json(403, { replyTo: frame.id, error: "DAEMON_INTERNAL_ONLY" });
			if (!this.credentials.has(credential.hash)) return json(401, { error: "CREDENTIAL_REVOKED" });
			if (frame.method === "registerProfile") {
				if (remote) return json(403, { error: "LOCAL_ONLY" });
				const profileId = randomUUID();
				this.profiles.set(profileId, {
					credentialHash: credential.hash,
					profile: frame.params?.profile,
				});
				return json(200, { replyTo: frame.id, result: { profileId } });
			}
			const result = await client.call(
				frame.method,
				this.parameters(frame.method, frame.params ?? {}, credential),
			);
			json(200, { ...result, replyTo: frame.id });
		} catch (error) {
			if (!res.headersSent)
				json(400, { error: error instanceof Error ? error.message : String(error) });
			else res.destroy();
		}
	}
	private parameters(method: string, params: Frame, credential: Credential): Frame {
		if (!["list", "attach", "subscribeActivity", "create"].includes(method)) return params;
		if (credential.remote) {
			if (params.profile !== undefined || params.profileId !== undefined)
				throw new Error("REMOTE_PROFILE_IS_SERVER_OWNED");
			if (!this.remoteProfile) throw new Error("REMOTE_PROFILE_UNAVAILABLE");
			return { ...params, profile: this.remoteProfile };
		}
		if (method === "create" && params.profile !== undefined)
			throw new Error("PROFILE_REQUIRES_POST_REGISTRATION");
		if (params.profileId !== undefined) {
			const entry = this.profiles.get(String(params.profileId));
			if (!entry || entry.credentialHash !== credential.hash) throw new Error("UNKNOWN_PROFILE");
			const { profileId: _, ...rest } = params;
			return { ...rest, profile: entry.profile };
		}
		return params;
	}
	async close() {
		this.stopped = true;
		clearTimeout(this.sshTimer);
		await this.configuring;
		const ssh = this.ssh;
		const sshExited =
			ssh?.pid && ssh.exitCode === null && ssh.signalCode === null
				? new Promise<void>((resolve) => {
						const force = setTimeout(() => ssh.kill("SIGKILL"), 3000);
						ssh.once("exit", () => {
							clearTimeout(force);
							resolve();
						});
						ssh.kill("SIGTERM");
					})
				: Promise.resolve();
		for (const client of this.clients.values()) client.close();
		await Promise.all(
			[this.local, this.remote]
				.filter((s): s is http.Server | https.Server => !!s)
				.map(
					(server) =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
							server.closeAllConnections();
						}),
				),
		);
		await sshExited;
	}
}
