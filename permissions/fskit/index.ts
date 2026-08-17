import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FileOperations, FilePathGuard, FileProgress, FileStat, SearchPolicy } from "../../targets/files.ts";
import { sandboxedLocalSearch } from "../../targets/backends/local.ts";
import { DeniedError, type Allow } from "../src/fsops.ts";
import { nfc } from "../src/paths.ts";
import type { Scope } from "../src/policy.ts";

export type Approval = { id: string; generation: number; path: string; access: "read" | "write" };
export type MountDriver = {
	start(resource: string, mountpoint: string, socketPath: string, signal: AbortSignal): Promise<void>;
	stop(mountpoint: string): Promise<void>;
};
const validPath = (path: unknown): path is string => typeof path === "string" && (path === "/" || (path.startsWith("/") && path.slice(1).split("/").every(p => p !== "" && p !== "." && p !== ".."))) && !path.includes("\0");
const modes = new Set(["deny", "ask-ro", "ask-rw", "ro", "ro-ask-rw", "rw"]);
export function wireScopes(scopes: readonly Scope[]): Scope[] {
	const seen = new Set<string>();
	return scopes.flatMap(({ path, mode }) => {
		if (!validPath(path) || !modes.has(mode)) throw new Error("Invalid FSKit scope");
		if (seen.has(path)) return [];
		seen.add(path); return [{ path, mode }];
	});
}

/** One session, one connection, no reconnect. Closing IPC revokes native authority. */
export class FSKitController {
	private server?: Server;
	private socket?: Socket;
	private directory?: string;
	private mountpoint?: string;
	private error?: Error;
	private generation = 0;
	private acknowledged = 0;
	private fingerprint = "";
	private scopes: Scope[] = [];
	private pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	private prompts = new AbortController();
	private approvalQueue: Promise<void> = Promise.resolve();
	private lifetime = new AbortController();
	private hello = false;
	private initialResolve?: () => void;
	private initialReject?: (error: Error) => void;
	private cleanup?: Promise<void>;
	constructor(private readonly driver: MountDriver, private readonly ask: (request: Approval, signal: AbortSignal) => Promise<boolean>, private readonly timeoutMs = 30_000) {}

	async start(scopes: readonly Scope[]): Promise<void> {
		if (this.directory || this.error) throw new Error("FSKit controller cannot be reused");
		// Use canonical host paths for the control socket and mountpoint.
		// mkdtemp creates the session directory with private permissions.
		const temporaryRoot = await realpath(tmpdir());
		this.directory = await mkdtemp(join(temporaryRoot, "pi-fs-"));
		this.mountpoint = join(this.directory, "view");
		const socketPath = join(this.directory, "s");
		try {
			if (Buffer.byteLength(socketPath) >= 104) throw new Error("FSKit controller socket path exceeds Darwin sockaddr_un limit");
			await mkdir(this.mountpoint, { mode: 0o700 });
			this.scopes = this.protectedScopes(scopes);
			this.fingerprint = JSON.stringify(this.scopes);
			const ready = new Promise<void>((resolve, reject) => { this.initialResolve = resolve; this.initialReject = reject; });
			// Attach a rejection handler immediately while mount startup is pending.
			void ready.catch(() => {});
			this.server = createServer(socket => this.accept(socket));
			this.server.on("error", error => this.fail(error));
			await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(socketPath, () => { this.server!.removeListener("error", reject); resolve(); }); });
			await chmod(socketPath, 0o600);
			const timer = setTimeout(() => this.fail(new Error("FSKit mount/initial policy readiness timed out")), this.timeoutMs);
			try {
				await Promise.all([this.driver.start(`pi-fs://${basename(this.directory)}`, this.mountpoint, socketPath, this.lifetime.signal), ready]);
				this.assertReady();
			} finally { clearTimeout(timer); }
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			try { await this.stop(); }
			catch (cleanup) { throw new Error(`${this.error!.message}; cleanup failed at ${this.mountpoint}: ${cleanup instanceof Error ? cleanup.message : cleanup}`); }
			throw this.error;
		}
	}
	private protectedScopes(scopes: readonly Scope[]): Scope[] {
		// The backing resource includes this controller and its own mount: never recurse into either.
		return wireScopes([{ path: this.directory!, mode: "deny" }, ...scopes.filter(scope => scope.path !== this.directory && !scope.path.startsWith(this.directory + "/"))]);
	}
	private accept(socket: Socket) {
		if (this.socket || this.error) { socket.destroy(); return; }
		this.socket = socket;
		let frame = Buffer.alloc(0);
		socket.on("error", error => this.fail(error));
		socket.on("close", () => this.fail(new Error("FSKit controller disconnected")));
		socket.on("data", (chunk: Buffer) => {
			try {
				frame = Buffer.concat([frame, chunk]);
				let end: number;
				while ((end = frame.indexOf(10)) >= 0) {
					if (end > 1_048_576) throw new Error("FSKit frame too large");
					const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, end)));
					frame = frame.subarray(end + 1);
					this.receive(message);
				}
				if (frame.length > 1_048_576) throw new Error("FSKit frame too large");
			} catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
		});
	}
	private receive(message: any) {
		if (!message || typeof message !== "object") throw new Error("Invalid FSKit frame");
		if (!this.hello) {
			if (message.type !== "hello" || message.version !== 1 || typeof message.mount !== "string") throw new Error("Unsupported FSKit hello");
			this.hello = true;
			void this.publish().then(() => this.initialResolve?.(), error => this.fail(error));
			return;
		}
		if (message.type === "policyAck") {
			const pending = this.pending.get(message.generation);
			if (!pending || message.generation !== this.acknowledged + 1) throw new Error("FSKit policy acknowledgement failed");
			clearTimeout(pending.timer); this.pending.delete(message.generation);
			this.acknowledged = message.generation; pending.resolve(); return;
		}
		if (message.type !== "approval" || typeof message.id !== "string" || !validPath(message.path) || !Number.isSafeInteger(message.generation) || !["read", "write"].includes(message.access) || message.reason !== "access") throw new Error("Invalid FSKit approval frame");
		const request = message as Approval;
		const signal = this.prompts.signal;
		const scope = this.scopes.filter(scope => scope.path === "/" || request.path === scope.path || request.path.startsWith(scope.path + "/")).sort((a, b) => b.path.length - a.path.length)[0];
		const mayAsk = scope?.mode === "ask-rw" || (scope?.mode === "ask-ro" && request.access === "read") || (scope?.mode === "ro-ask-rw" && request.access === "write");
		if (!mayAsk || request.generation !== this.generation || this.acknowledged !== this.generation) {
			this.send({ type: "decision", id: request.id, generation: request.generation, allow: false }); return;
		}
		this.approvalQueue = this.approvalQueue.then(async () => {
			if (this.error || signal.aborted || request.generation !== this.generation) return;
			const allow = await this.ask(request, signal).catch(() => false);
			if (!this.error && !signal.aborted && request.generation === this.generation) this.send({ type: "decision", id: request.id, generation: request.generation, allow: allow === true });
		}).catch(error => this.fail(error));
	}
	private send(message: unknown) {
		if (this.error) throw this.error;
		if (!this.socket || this.socket.destroyed) throw new Error("FSKit is not connected");
		const frame = JSON.stringify(message) + "\n";
		if (Buffer.byteLength(frame) > 1_048_576) throw new Error("FSKit policy frame too large");
		this.socket.write(frame, error => { if (error) this.fail(error); });
	}
	private publish(): Promise<void> {
		this.prompts.abort(); this.prompts = new AbortController();
		const generation = ++this.generation;
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => this.fail(new Error("FSKit policy acknowledgement timed out")), this.timeoutMs);
			this.pending.set(generation, { resolve, reject, timer });
			try { this.send({ type: "policy", generation, scopes: this.scopes }); }
			catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
		});
	}
	/** Called synchronously on every permission change: admission blocks before the async ack. */
	update(scopes: readonly Scope[]): Promise<void> {
		if (this.error) return Promise.reject(this.error);
		let next: Scope[];
		try { next = this.protectedScopes(scopes); } catch (error) { this.fail(error as Error); return Promise.reject(this.error); }
		const fingerprint = JSON.stringify(next);
		if (fingerprint === this.fingerprint) return this.waitForAck();
		this.scopes = next; this.fingerprint = fingerprint;
		return this.publish();
	}
	async waitForAck(): Promise<void> {
		if (this.error) throw this.error;
		if (this.pending.size) await Promise.all([...this.pending.values()].map(p => new Promise<void>((resolve, reject) => {
			const oldResolve = p.resolve, oldReject = p.reject;
			p.resolve = () => { oldResolve(); resolve(); }; p.reject = error => { oldReject(error); reject(error); };
		})));
		this.assertReady();
	}
	assertReady() {
		if (this.error) throw this.error;
		if (!this.hello || this.acknowledged !== this.generation || !this.generation) throw new Error("FSKit policy is not acknowledged");
	}
	path(hostPath: string): string {
		this.assertReady();
		if (!validPath(hostPath)) throw new Error("Invalid FSKit host path");
		return this.mountpoint! + (hostPath === "/" ? "" : hostPath);
	}
	hostPath(path: string): string {
		if (path === this.mountpoint) return "/";
		return this.mountpoint && path.startsWith(this.mountpoint + "/") ? path.slice(this.mountpoint.length) : path;
	}
	private fail(error: Error) {
		if (this.error) return;
		this.error = error; this.prompts.abort(); this.lifetime.abort();
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.pending.clear(); this.initialReject?.(error); this.socket?.destroy(); this.server?.close();
	}
	stop(): Promise<void> {
		return this.cleanup ??= (async () => {
			this.fail(new Error("FSKit session stopped"));
			if (!this.directory) return;
			// Never recursively remove a possibly mounted host-root view.
			await this.driver.stop(this.mountpoint!);
			await unlink(join(this.directory, "s")).catch(error => { if (error.code !== "ENOENT") throw error; });
			await rmdir(this.mountpoint!);
			await rmdir(this.directory);
		})();
	}
}

function run(executable: string, args: string[], signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], signal, timeout: 30_000, killSignal: "SIGKILL" });
		let error = "";
		child.stderr.on("data", chunk => { error = (error + chunk).slice(-8192); });
		child.once("error", reject);
		child.once("close", code => code === 0 ? resolve() : reject(new Error(`${executable} failed (${code}): ${error}`)));
	});
}
export function mountArguments(resource: string, mountpoint: string, socket: string): string[] {
	if (!/^pi-fs:\/\/pi-fs-[A-Za-z0-9]+$/.test(resource) || !validPath(socket) || socket.includes(",")) throw new Error("Invalid FSKit mount resource/socket");
	// Force FSKit, with a session identity rather than a backing path resource.
	// Darwin mount.c mangle(): '-s=value' passes the two activation arguments '-s', 'value'.
	return ["-F", "-t", "permissionfs", "-o", `-s=${socket}`, resource, mountpoint];
}
async function isMounted(path: string): Promise<boolean> {
	return (await stat(path)).dev !== (await stat(dirname(path))).dev;
}
/** No install, registration, signing, or privilege escalation here. */
export class NativeMountDriver implements MountDriver {
	async start(resource: string, mountpoint: string, socket: string, signal: AbortSignal): Promise<void> {
		if (process.platform !== "darwin") throw new Error("FSKit requires macOS 27 and an enabled pi-fs extension");
		await run("/sbin/mount", mountArguments(resource, mountpoint, socket), signal);
		if (!await isMounted(mountpoint)) throw new Error("FSKit mount command returned without mounting the proxy");
	}
	async stop(mountpoint: string): Promise<void> {
		// IPC has already closed. Do not stat a revoked FSKit vnode before unmount:
		// that request can fail EACCES even though the mount is still present.
		try { await run("/sbin/umount", [mountpoint]); }
		catch (error) { if (await isMounted(mountpoint)) throw error; }
		if (await isMounted(mountpoint)) throw new Error(`FSKit mount remains active: ${mountpoint}`);
	}
}

type Intent = Parameters<FilePathGuard>[1];
const real = (path: string) => nfc(realpathSync.native(path));
const child = (parent: string, name: string) => `${parent === "/" ? "" : parent}/${name}`;
export function normalizeHostPath(path: string, cwd: string, intent: Intent, allow: Allow = () => true): string {
	const expanded = path.startsWith("~") ? path.replace(/^~/, homedir()) : path;
	// Use native realpath before lexical collapse: symlink/../name is not the
	// same as dropping those components first. Node's JS realpath collapses them.
	const absolute = nfc(isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`);
	let canonical: string;
	try { canonical = real(absolute); }
	catch (error) {
		if (intent === "existing" || !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		const parentPath = dirname(absolute);
		const parent = intent === "create" && (error as NodeJS.ErrnoException).code === "ENOENT" && parentPath !== absolute
			? normalizeHostPath(parentPath, "/", "create", allow)
			: real(parentPath);
		if (!allow(parent)) throw new DeniedError(parent);
		const name = nfc(basename(absolute));
		canonical = name === "." ? parent : name === ".." ? dirname(parent) : child(parent, name);
	}
	if (!allow(canonical)) throw new DeniedError(canonical);
	// lstat retains the final directory entry; its parent is still canonical.
	const name = nfc(basename(absolute));
	return intent === "entry" && name && name !== "." && name !== ".." ? child(real(dirname(absolute)), name) : canonical;
}

/** Resolve in the host namespace first, then translate once into the mounted view. */
export function normalizeProxyPath(proxy: Pick<FSKitController, "path" | "hostPath">, path: string, cwd: string, intent: Intent, allow: Allow): string {
	return proxy.path(normalizeHostPath(proxy.hostPath(path), cwd, intent, allow));
}

function metadata(info: NonNullable<Awaited<ReturnType<typeof stat>>>): FileStat {
	return { type: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", isDirectory: () => info.isDirectory() };
}
/** Never perform synchronous IO on the proxy: native IO can wait for our UI/IPC loop. */
export class ProxyFiles implements FileOperations {
	constructor(private readonly controller: FSKitController) {}
	private check(signal?: AbortSignal) { signal?.throwIfAborted(); this.controller.assertReady(); }
	async exists(path: string, signal?: AbortSignal) {
		this.check(signal);
		try { await lstat(path); return true; } catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
			throw error;
		}
	}
	async size(path: string, signal?: AbortSignal) { this.check(signal); return (await stat(path)).size; }
	async stat(path: string, signal?: AbortSignal) { this.check(signal); return metadata(await stat(path)); }
	async lstat(path: string, signal?: AbortSignal) { this.check(signal); return metadata(await lstat(path)); }
	async mkdir(path: string, signal?: AbortSignal) { this.check(signal); await mkdir(path); }
	async readdir(path: string, signal?: AbortSignal) { this.check(signal); return (await readdir(path)).sort(); }
	async *openRead(path: string, signal?: AbortSignal) {
		this.check(signal);
		for await (const bytes of createReadStream(path, { signal })) yield Buffer.from(bytes);
	}
	async write(path: string, chunks: AsyncIterable<Buffer>, signal?: AbortSignal, onProgress?: FileProgress) {
		this.check(signal);
		let transferred = 0;
		async function* counted() {
			for await (const chunk of chunks) { signal?.throwIfAborted(); transferred += chunk.length; onProgress?.(transferred); yield chunk; }
		}
		await pipeline(counted(), createWriteStream(path), { signal });
	}
	searchPlan(path: string, policy?: SearchPolicy) {
		this.check();
		// Root normalization/mapping happened in the path guard. Preserve explicit
		// search exclusions in the mounted namespace. Ask regions remain reachable
		// so FSKit can request per-native-access approval rather than pruning them.
		return sandboxedLocalSearch(path, {
			scopes: [
				...(policy?.scopes ?? []).map(scope => ({ ...scope, path: this.controller.path(scope.path), access: scope.access === "ask" ? "allow" as const : scope.access })),
				{ path: this.controller.path("/"), access: "allow" },
			],
			assertFresh: () => { this.check(); policy?.assertFresh(); },
		});
	}
}
