import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileOperations, FilePathGuard, FileProgress, FileStat, SearchPolicy } from "../../targets/files.ts";
import { sandboxedLocalSearch } from "../../targets/backends/local.ts";
import { DeniedError, type Allow } from "../src/fsops.ts";
import { nfc } from "../src/paths.ts";
import type { Scope } from "../src/policy.ts";
import { helperPath } from "./setup.ts";

export type ApprovalFootprint = { path: string; access: "read" | "write"; scopeIndices: number[] };
export type ApprovalEffect = {
	operation: "remove" | "rename" | "link" | "create" | "open-read" | "open-write" | "open-readwrite";
	source?: string;
	destination?: string;
	purpose?: "metadata-owner" | "content" | "set-size";
	footprint: ApprovalFootprint[];
};
export type Approval = { id: string; generation: number; path: string; access: "read" | "write" } & (
	{ reason: "access"; effect?: never } | { reason: "effect"; effect: ApprovalEffect }
);
export type ProviderProcess = {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	pid?: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	once(event: "error", listener: (error: Error) => void): unknown;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
};
export type MountDriver = {
	launch(socketPath: string): ProviderProcess;
	mount(socketPath: string, mountpoint: string, signal: AbortSignal): Promise<void>;
	stop(mountpoint: string, force?: boolean): Promise<void>;
};

type Pending = { promise: Promise<void>; resolve(): void; reject(error: Error): void };
type ProviderScope = Scope & { barrier?: true };
const sessionPrefix = "pifs-";
const maximumFrame = 1_048_576;
const scopeModes = new Set<Scope["mode"]>(["deny", "ask-ro", "ask-rw", "ro", "ro-ask-rw", "rw"]);
const validPath = (path: unknown): path is string => typeof path === "string" && (path === "/" || (path.startsWith("/") && path.slice(1).split("/").every(p => p !== "" && p !== "." && p !== ".."))) && !path.includes("\0");
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

function pending(timeoutMs: number, onTimeout: () => Error): Pending {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
	const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
	const settled = promise.finally(() => clearTimeout(timer));
	void settled.catch(() => {});
	return { promise: settled, resolve, reject };
}

async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			exited.then(() => true),
			new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
		]);
	} finally { clearTimeout(timer); }
}

function wireScopes(scopes: readonly Scope[]): Scope[] {
	return scopes.map(({ path, mode }) => {
		if (!validPath(path) || !scopeModes.has(mode)) throw new Error("Invalid pifs scope");
		return { path, mode };
	});
}

/** One session, one connection, no reconnect. Closing IPC revokes native authority. */
export class NativePiFSController {
	private provider?: ProviderProcess;
	private directory?: string;
	private socketPath?: string;
	private mountpoint?: string;
	private preparation?: Promise<void>;
	private mountAttempt?: Promise<void>;
	private started = false;
	private mounted = false;
	private closing = false;
	private faulted = false;
	private error?: Error;
	private generation = 0;
	private acknowledged = 0;
	private fingerprint = "";
	private scopes: ProviderScope[] = [];
	private pending = new Map<number, Pending>();
	private approvalIDs = new Set<string>();
	private prompts = new AbortController();
	private approvalQueue: Promise<void> = Promise.resolve();
	private lifetime = new AbortController();
	private hello = false;
	private initial?: Pending;
	private quiescence?: Pending;
	private exited?: Promise<void>;
	private diagnostics = "";
	private cleanup?: Promise<void>;

	constructor(private readonly driver: MountDriver, private readonly ask: (request: Approval, signal: AbortSignal) => Promise<boolean>, private readonly timeoutMs = 30_000) {}

	async start(scopes: readonly Scope[]): Promise<void> {
		if (this.started || this.error) throw new Error("pifs controller cannot be reused");
		this.started = true;
		try {
			this.scopes = wireScopes(scopes);
			this.fingerprint = JSON.stringify(this.scopes);
			this.preparation = this.prepare();
			await this.preparation;
			if (this.error) throw this.error;
			this.initial = this.deadline("pifs provider/initial policy readiness timed out");
			this.attach(this.driver.launch(this.socketPath!));
			await this.initial.promise;
			await this.waitForPolicy();
			if (this.error) throw this.error;
			this.mountAttempt = this.driver.mount(this.socketPath!, this.mountpoint!, this.lifetime.signal);
			await this.mountAttempt;
			if (this.error) throw this.error;
			this.mounted = true;
			await this.waitForAck();
		} catch (error) {
			const failure = this.error ?? asError(error);
			this.fail(failure);
			try { await this.stop(); }
			catch (cleanup) { throw new Error(`${failure.message}; cleanup failed at ${this.mountpoint}: ${asError(cleanup).message}`); }
			throw failure;
		}
	}

	private async prepare(): Promise<void> {
		// Use canonical host paths for the NFS socket and mountpoint.
		// mkdtemp creates the session directory with private permissions.
		const temporaryRoot = await realpath(tmpdir());
		if (this.error) throw this.error;
		this.directory = await mkdtemp(join(temporaryRoot, sessionPrefix));
		this.mountpoint = join(this.directory, "view");
		this.socketPath = join(this.directory, "n");
		if (this.error) throw this.error;
		if (Buffer.byteLength(this.socketPath) >= 104 || /[,\r\n]/.test(this.socketPath)) {
			throw new Error("pifs session path cannot be represented by the native NFS Unix transport");
		}
		await mkdir(this.mountpoint, { mode: 0o700 });
		this.scopes = this.protectedScopes(this.scopes);
		this.fingerprint = JSON.stringify(this.scopes);
	}

	private deadline(message: string): Pending {
		return pending(this.timeoutMs, () => {
			const error = new Error(message);
			this.fail(error);
			return error;
		});
	}

	private protectedScopes(scopes: readonly Scope[]): ProviderScope[] {
		// The backing resource includes this controller and its own mount: never recurse into either.
		const normalized = wireScopes(scopes);
		if (!this.directory) return normalized;
		const directory = nfc(this.directory);
		return [{ path: directory, mode: "deny", barrier: true }, ...normalized.filter(scope => scope.path !== directory && !scope.path.startsWith(directory + "/"))];
	}

	private attach(provider: ProviderProcess): void {
		this.provider = provider;
		let exit!: () => void;
		this.exited = new Promise<void>(resolve => { exit = resolve; });
		const lost = (error: Error) => {
			this.quiescence?.reject(error);
			this.fail(error);
		};
		provider.once("error", error => {
			if (provider.pid === undefined) exit();
			lost(error);
		});
		provider.once("exit", (code, signal) => {
			exit();
			lost(new Error(`pifs provider exited (${signal ?? code})${this.diagnostics ? `: ${this.diagnostics.trim()}` : ""}`));
		});
		provider.stdin.on("error", lost);
		provider.stderr.on("error", lost);
		provider.stderr.on("data", (chunk: Buffer) => { this.diagnostics = (this.diagnostics + chunk.toString("utf8")).slice(-8192); });
		provider.stdout.on("error", lost);
		let frame = Buffer.alloc(0);
		let decoding = true;
		provider.stdout.on("end", () => lost(new Error(frame.length ? "pifs provider sent an incomplete frame" : "pifs provider disconnected")));
		provider.stdout.on("data", (chunk: Buffer) => {
			if (!decoding) return;
			try {
				frame = Buffer.concat([frame, chunk]);
				let end: number;
				while ((end = frame.indexOf(10)) >= 0) {
					if (end > maximumFrame) throw new Error("pifs frame too large");
					const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, end)));
					frame = frame.subarray(end + 1);
					this.receive(message);
				}
				if (frame.length > maximumFrame) throw new Error("pifs frame too large");
			} catch (error) {
				decoding = false;
				frame = Buffer.alloc(0);
				lost(asError(error));
			}
		});
	}

	private receive(value: unknown): void {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pifs frame");
		const message = value as Record<string, unknown>;
		if (this.closing) {
			if (message.type === "quiesced") this.quiescence?.resolve();
			else if (message.type === "approval" && typeof message.id === "string" && typeof message.generation === "number") {
				this.write({ type: "decision", id: message.id, generation: message.generation, allow: false });
			}
			return;
		}
		if (!this.hello) {
			if (message.type !== "hello" || message.version !== 1 || typeof message.mount !== "string" || !message.mount) {
				throw new Error("Unsupported pifs hello");
			}
			this.hello = true;
			void this.publish().then(() => this.initial?.resolve(), error => this.fail(asError(error)));
			return;
		}
		if (message.type === "policyAck") {
			if (typeof message.generation !== "number" || !Number.isSafeInteger(message.generation)) throw new Error("Invalid pifs policy generation");
			const waiting = this.pending.get(message.generation);
			if (!waiting || message.generation !== this.acknowledged + 1) throw new Error("pifs policy acknowledgement failed");
			this.pending.delete(message.generation);
			this.acknowledged = message.generation;
			waiting.resolve();
			return;
		}
		if (message.type !== "approval" || typeof message.id !== "string" || !message.id || !validPath(message.path)
			|| typeof message.generation !== "number" || !Number.isSafeInteger(message.generation)
			|| (message.access !== "read" && message.access !== "write") || (message.reason !== "access" && message.reason !== "effect")) {
			throw new Error("Invalid pifs approval frame");
		}
		const base: Pick<Approval, "id" | "generation" | "path" | "access"> = { id: message.id, generation: message.generation, path: message.path, access: message.access };
		if (base.generation !== this.generation || this.acknowledged !== this.generation) {
			this.send({ type: "decision", id: base.id, generation: base.generation, allow: false });
			return;
		}
		if (Object.keys(message).some(key => !["type", "id", "generation", "path", "access", "reason", "scopeIndices", "effect"].includes(key))) throw new Error("Unknown pifs approval field");
		const matchScopes = (path: string, indices: unknown, required = false): Scope[] => {
			if (indices !== undefined || required) {
				if (!Array.isArray(indices) || indices.length === 0 || indices.length > this.scopes.length
					|| indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= this.scopes.length)
					|| new Set(indices).size !== indices.length) throw new Error("Invalid pifs approval scopes");
				const matched = indices.map(index => this.scopes[index]!);
				const depth = matched[0]!.path.split("/").filter(Boolean).length;
				if (depth > path.split("/").filter(Boolean).length
					|| matched.some(scope => scope.path.split("/").filter(Boolean).length !== depth)) throw new Error("Invalid pifs approval scope depth");
				return matched;
			}
			const policyPath = nfc(path);
			const candidates = this.scopes.filter(scope => {
				const prefix = nfc(scope.path);
				return prefix === "/" || policyPath === prefix || policyPath.startsWith(prefix + "/");
			});
			const depth = Math.max(-1, ...candidates.map(scope => scope.path.split("/").filter(Boolean).length));
			return candidates.filter(scope => scope.path.split("/").filter(Boolean).length === depth);
		};
		const asks = (scope: Scope, access: "read" | "write") => scope.mode === "ask-rw" || (scope.mode === "ask-ro" && access === "read") || (scope.mode === "ro-ask-rw" && access === "write");
		const denies = (scope: Scope, access: "read" | "write") => scope.mode === "deny" || (access === "write" && (scope.mode === "ro" || scope.mode === "ask-ro"));
		const matched = matchScopes(base.path, message.scopeIndices, message.reason === "effect");
		let mayAsk = matched.some(scope => asks(scope, base.access)) && !matched.some(scope => denies(scope, base.access));
		let request: Approval;
		if (message.reason === "effect") {
			if (!message.effect || typeof message.effect !== "object" || Array.isArray(message.effect)) throw new Error("Invalid pifs approval effect");
			const effect = message.effect as Record<string, unknown>;
			if (Object.keys(effect).some(key => !["operation", "source", "destination", "purpose", "footprint"].includes(key))) throw new Error("Unknown pifs approval effect field");
			const operations = ["remove", "rename", "link", "create", "open-read", "open-write", "open-readwrite"];
			if (typeof effect.operation !== "string" || !operations.includes(effect.operation)
				|| !Array.isArray(effect.footprint) || effect.footprint.length === 0) throw new Error("Invalid pifs approval operation");
			const opens = effect.operation.startsWith("open-");
			const needsSource = effect.operation !== "create";
			const needsDestination = ["create", "rename", "link"].includes(effect.operation);
			if ((needsSource ? !validPath(effect.source) : effect.source !== undefined)
				|| (needsDestination ? !validPath(effect.destination) : effect.destination !== undefined)
				|| (opens ? typeof effect.purpose !== "string" || !["metadata-owner", "content", "set-size"].includes(effect.purpose) : effect.purpose !== undefined)
				|| (effect.purpose === "metadata-owner" && effect.operation !== "open-read")
				|| (effect.purpose === "set-size" && effect.operation === "open-read")) throw new Error("Invalid pifs approval selectors");
			const footprint: ApprovalFootprint[] = effect.footprint.map(value => {
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pifs approval footprint");
				const item = value as Record<string, unknown>;
				if (Object.keys(item).some(key => !["path", "access", "scopeIndices"].includes(key))) throw new Error("Unknown pifs approval footprint field");
				if (!validPath(item.path) || (item.access !== "read" && item.access !== "write")) throw new Error("Invalid pifs approval footprint");
				const scopes = matchScopes(item.path, item.scopeIndices, true);
				if (scopes.some(scope => denies(scope, item.access as "read" | "write"))) mayAsk = false;
				return { path: item.path, access: item.access, scopeIndices: [...item.scopeIndices as number[]] };
			});
			const covers = (path: unknown, access: "read" | "write") => footprint.some(item => item.path === path && item.access === access);
			if ((needsSource && !covers(effect.source, opens && effect.operation === "open-read" ? "read" : "write"))
				|| (needsDestination && !covers(effect.destination, "write"))
				|| (effect.operation === "open-readwrite" && !covers(effect.source, "read"))
				|| !footprint.some(item => item.path === base.path && item.access === base.access
					&& item.scopeIndices.length === (message.scopeIndices as number[]).length
					&& item.scopeIndices.every(index => (message.scopeIndices as number[]).includes(index)))) throw new Error("Incomplete pifs approval footprint");
			request = { ...base, reason: "effect", effect: { operation: effect.operation as ApprovalEffect["operation"],
				source: effect.source as string | undefined, destination: effect.destination as string | undefined,
				purpose: effect.purpose as ApprovalEffect["purpose"], footprint } };
		} else {
			if (message.effect !== undefined) throw new Error("Unexpected pifs approval effect");
			request = { ...base, reason: "access" };
		}
		if (!mayAsk) {
			this.send({ type: "decision", id: request.id, generation: request.generation, allow: false });
			return;
		}
		const key = `${request.generation}:${request.id}`;
		if (this.approvalIDs.has(key)) throw new Error("Duplicate pifs approval request");
		this.approvalIDs.add(key);
		const signal = this.prompts.signal;
		this.approvalQueue = this.approvalQueue.then(async () => {
			try {
				if (this.error || signal.aborted || request.generation !== this.generation) return;
				const allow = await this.ask(request, signal).catch(() => false);
				if (!this.error && !signal.aborted && request.generation === this.generation) {
					this.send({ type: "decision", id: request.id, generation: request.generation, allow: allow === true });
				}
			} finally { this.approvalIDs.delete(key); }
		}).catch(error => this.fail(asError(error)));
	}

	private write(message: unknown): void {
		const input = this.provider?.stdin;
		if (!input || input.destroyed || input.writableEnded) throw new Error("pifs is not connected");
		const frame = JSON.stringify(message) + "\n";
		if (Buffer.byteLength(frame) > maximumFrame) throw new Error("pifs policy frame too large");
		input.write(frame, error => { if (error) this.fail(error); });
	}

	private send(message: unknown): void {
		if (this.error) throw this.error;
		this.write(message);
	}

	private publish(): Promise<void> {
		if (this.error) return Promise.reject(this.error);
		if (!Number.isSafeInteger(this.generation + 1)) throw new Error("pifs policy generation exhausted");
		this.prompts.abort();
		this.prompts = new AbortController();
		this.approvalIDs.clear();
		const generation = ++this.generation;
		const waiting = this.deadline("pifs policy acknowledgement timed out");
		this.pending.set(generation, waiting);
		try { this.send({ type: "policy", generation, scopes: this.scopes }); }
		catch (error) { this.fail(asError(error)); }
		return waiting.promise;
	}

	/** Called synchronously on every permission change: admission blocks before the async ack. */
	update(scopes: readonly Scope[]): Promise<void> {
		if (this.error) return Promise.reject(this.error);
		let next: Scope[];
		try { next = this.protectedScopes(scopes); }
		catch (error) { this.fail(asError(error)); return Promise.reject(this.error); }
		const fingerprint = JSON.stringify(next);
		if (fingerprint === this.fingerprint) return this.hello ? this.waitForPolicy() : Promise.resolve();
		this.scopes = next;
		this.fingerprint = fingerprint;
		return this.hello ? this.publish() : Promise.resolve();
	}

	private async waitForPolicy(): Promise<void> {
		if (this.error) throw this.error;
		while (this.pending.size) {
			await Promise.all([...this.pending.values()].map(waiting => waiting.promise));
		}
		if (this.error) throw this.error;
		if (!this.hello || this.acknowledged !== this.generation || !this.generation) throw new Error("pifs policy is not ready");
	}

	async waitForAck(): Promise<void> {
		await this.waitForPolicy();
		this.assertReady();
	}

	assertReady(): void {
		if (this.error) throw this.error;
		if (!this.mounted || !this.hello || this.acknowledged !== this.generation || !this.generation) {
			throw new Error("pifs policy/mount is not ready");
		}
	}

	path(hostPath: string): string {
		this.assertReady();
		if (!validPath(hostPath)) throw new Error("Invalid pifs host path");
		return this.mountpoint! + (hostPath === "/" ? "" : hostPath);
	}

	hostPath(path: string): string {
		if (path === this.mountpoint) return "/";
		return this.mountpoint && path.startsWith(this.mountpoint + "/") ? path.slice(this.mountpoint.length) : path;
	}

	private closeAdmission(error: Error): void {
		this.error ??= error;
		this.prompts.abort();
		this.lifetime.abort();
		for (const waiting of this.pending.values()) waiting.reject(this.error);
		this.pending.clear();
		this.approvalIDs.clear();
		this.initial?.reject(this.error);
	}

	private fail(error: Error): void {
		this.faulted = true;
		if (this.error) return;
		this.closeAdmission(error);
		this.provider?.stdin.end();
		if (this.mounted) {
			void this.stop().catch(cleanup => { this.error = new Error(`${error.message}; pifs cleanup failed: ${asError(cleanup).message}`); });
		}
	}

	stop(): Promise<void> {
		this.cleanup ??= this.stopOwned().catch(error => {
			this.cleanup = undefined;
			throw error;
		});
		return this.cleanup;
	}

	private async stopOwned(): Promise<void> {
		const failed = this.error !== undefined;
		let force = failed;
		this.closing = true;
		this.closeAdmission(new Error("pifs session stopped"));
		await this.preparation?.catch(() => {});
		if (!this.directory) return;
		if (!failed && this.hello && this.running()) {
			this.quiescence = pending(Math.min(this.timeoutMs, 5000), () => new Error("pifs provider did not quiesce"));
			try {
				this.write({ type: "quiesce" });
				await this.quiescence.promise;
			} catch (error) {
				force = true;
				this.quiescence.reject(asError(error));
				this.provider?.stdin.end();
			} finally { this.quiescence = undefined; }
		} else this.provider?.stdin.end();
		await this.mountAttempt?.catch(() => {});
		// Never recursively remove a possibly mounted host-root view.
		try { await this.driver.stop(this.mountpoint!, force || this.faulted || !this.running()); }
		catch (error) {
			// Revocation is not process cleanup: native stdin EOF only clears its
			// authority; the helper's main loop otherwise lives forever. Keep the
			// failed mount owned for a forced retry, but do not abandon its helper.
			this.provider?.stdin.end();
			try { await this.terminateProvider(); }
			catch (termination) { throw new AggregateError([error, termination], "pifs unmount and provider termination failed"); }
			throw error;
		}
		this.mounted = false;
		await this.terminateProvider();
		await unlink(this.socketPath!).catch(error => { if (error.code !== "ENOENT") throw error; });
		await rmdir(this.mountpoint!).catch(error => { if (error.code !== "ENOENT") throw error; });
		await rmdir(this.directory).catch(error => { if (error.code !== "ENOENT") throw error; });
	}

	private running(): boolean {
		return !!this.provider && this.provider.pid !== undefined && this.provider.exitCode === null && this.provider.signalCode === null;
	}

	private async terminateProvider(): Promise<void> {
		const provider = this.provider;
		if (!provider || !this.exited) return;
		provider.stdin.end();
		if (this.running()) provider.kill("SIGTERM");
		if (!await waitForExit(this.exited, 5000)) {
			provider.kill("SIGKILL");
			if (!await waitForExit(this.exited, 5000)) throw new Error("pifs provider did not exit after unmount");
		}
		provider.stdin.destroy();
		provider.stdout.destroy();
		provider.stderr.destroy();
	}
}

/** Compare the native longest-prefix policy, including built-ins, not grant syntax. */
export function effectivePiFSScopes(scopes: readonly Scope[]): Scope[] {
	return wireScopes(scopes).sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
}

type PiFSOwnership = { sessionId: string };
type OwnedPiFS = {
	controller: NativePiFSController;
	owners: Set<PiFSController>;
	key: string;
	retiring: boolean;
	starting: Promise<void>;
	policyReady: Promise<void>;
};
type PiFSOwners = { entries: Set<OwnedPiFS>; sessions: Map<string, PiFSController> };
function piFSOwners(): PiFSOwners {
	const global = globalThis as typeof globalThis & { __piFSOwners?: PiFSOwners };
	return global.__piFSOwners ??= { entries: new Set(), sessions: new Map() };
}
async function retirePiFS(entry: OwnedPiFS): Promise<void> {
	if (entry.owners.size) return;
	entry.retiring = true;
	// One bounded retry matters on actual quit, when there is no next acquire.
	// The first failed unmount terminates the helper; the retry is forced.
	// If both fail, retain ownership for an explicit retry or the next reload.
	try { await entry.controller.stop(); }
	catch (first) {
		try { await entry.controller.stop(); }
		catch (retry) { throw new AggregateError([first, retry], "pifs cleanup failed after one forced retry"); }
	}
	piFSOwners().entries.delete(entry);
}
export async function retryPiFSCleanup(): Promise<void> {
	const results = await Promise.allSettled([...piFSOwners().entries].filter(entry => !entry.owners.size).map(retirePiFS));
	const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
	if (errors.length) throw new AggregateError(errors, "Previous pifs mounts could not be cleaned up; refusing to create more mounts");
}

/**
 * Root-owned native mount with retryable cleanup. Children use the same controller
 * through the permission owner; no child mount or policy lease is created.
 */
export class PiFSController {
	private scopes: Scope[] = [];
	private key = "[]";
	private entry?: OwnedPiFS;
	private started = false;
	private closed = false;
	private moving?: Promise<void>;
	private failure?: Error;
	private cleanup?: Promise<void>;

	constructor(
		private readonly driver: MountDriver,
		private readonly ask: (request: Approval, signal: AbortSignal) => Promise<boolean>,
		private readonly timeoutMs = 30_000,
		private readonly ownership?: PiFSOwnership,
	) {}

	async start(scopes: readonly Scope[]): Promise<void> {
		if (this.started || this.closed) throw new Error("pifs controller cannot be reused");
		this.started = true;
		this.setScopes(scopes);
		if (this.ownership) {
			const previous = piFSOwners().sessions.get(this.ownership.sessionId);
			if (previous && previous !== this) throw new Error("Previous pifs session still owns its mount");
			piFSOwners().sessions.set(this.ownership.sessionId, this);
		}
		try { await this.move(); }
		catch (error) {
			try { await this.stop(); }
			catch (cleanup) { throw new AggregateError([error, cleanup], "pifs startup and cleanup failed"); }
			throw error;
		}
	}

	private setScopes(scopes: readonly Scope[]): void {
		this.scopes = effectivePiFSScopes(scopes);
		this.key = JSON.stringify(this.scopes);
	}


	update(scopes: readonly Scope[]): Promise<void> {
		if (this.closed) return Promise.reject(new Error("pifs session stopped"));
		try { this.setScopes(scopes); }
		catch (error) {
			this.failure = asError(error);
			if (this.entry) {
				this.entry.retiring = true;
				this.entry.policyReady = this.entry.controller.update([]);
				void this.entry.policyReady.catch(() => {});
			}
			return Promise.reject(error);
		}
		const entry = this.entry;
		if (entry && !entry.retiring) {
			if (entry.key !== this.key) {
				entry.key = this.key;
				entry.policyReady = entry.controller.update(this.scopes);
				void entry.policyReady.catch(() => {});
			}
		}
		if (!this.started) return Promise.resolve();
		if (this.moving) return this.moving;
		if (!entry || entry.retiring) return this.move();
		return entry.policyReady;
	}

	private move(): Promise<void> {
		if (this.moving) return this.moving;
		const operation = this.reconcile();
		this.moving = operation.then(() => { this.moving = undefined; }, error => {
			this.moving = undefined;
			this.failure = asError(error);
			throw error;
		});
		void this.moving.catch(() => {});
		return this.moving;
	}
	private async release(): Promise<void> {
		const entry = this.entry;
		this.entry = undefined;
		if (!entry) return;
		entry.owners.delete(this);
		await retirePiFS(entry);
	}
	private async reconcile(): Promise<void> {
		while (!this.closed && !this.failure) {
			const entry = this.entry;
			if (entry && !entry.retiring) {
				// Updates can arrive before hello/mount readiness.
				// Policy updates must never overwrite this distinct startup barrier.
				await entry.starting;
				await entry.policyReady;
				await entry.controller.waitForAck();
				if (entry !== this.entry || entry.retiring || entry.key !== this.key) continue;
				return;
			}
			if (entry?.retiring) await entry.policyReady.catch(() => {});
			await this.release();
			await retryPiFSCleanup();
			if (this.closed || this.failure) return;
			const controller = new NativePiFSController(this.driver, (request, signal) =>
				this.closed ? Promise.resolve(false) : this.ask(request, signal), this.timeoutMs);
			const own: OwnedPiFS = { controller, owners: new Set([this]), key: this.key, retiring: false, starting: Promise.resolve(), policyReady: Promise.resolve() };
			this.entry = own;
			piFSOwners().entries.add(own);
			own.starting = controller.start(this.scopes);
			await own.starting;
			// Permission changes during startup publish synchronously via update().
		}
	}

	assertReady(): void {
		if (this.closed) throw new Error("pifs session stopped");
		if (this.failure) throw this.failure;
		if (this.moving || !this.entry || this.entry.retiring || this.entry.key !== this.key) throw new Error("pifs ownership/policy transition is not ready");
		this.entry.controller.assertReady();
	}
	async waitForAck(): Promise<void> {
		if (this.moving) await this.moving;
		await this.entry?.controller.waitForAck();
		this.assertReady();
	}
	path(hostPath: string): string { this.assertReady(); return this.entry!.controller.path(hostPath); }
	hostPath(path: string): string { return this.entry?.controller.hostPath(path) ?? path; }
	get mountIdentity(): string { return this.path("/"); }

	stop(): Promise<void> {
		this.closed = true;
		if (this.ownership && piFSOwners().sessions.get(this.ownership.sessionId) === this) piFSOwners().sessions.delete(this.ownership.sessionId);
		if (this.cleanup) return this.cleanup;
		// Revoke/release now, not after startup: native stop must be able to abort
		// a mount attempt or provider handshake that move() is still awaiting.
		const releasing = this.release();
		void releasing.catch(() => {});
		return this.cleanup = (async () => {
			await this.moving?.catch(() => {});
			await releasing;
			await retryPiFSCleanup();
		})().catch(error => { this.cleanup = undefined; throw error; });
	}
}

function run(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], signal, timeout: 30_000, killSignal: "SIGKILL" });
		let output = "";
		let error = "";
		let failure: Error | undefined;
		let overflowed = false;
		const failed = (error: Error) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		child.stdout.on("data", (chunk: Buffer) => {
			if (overflowed) return;
			output += chunk.toString("utf8");
			if (output.length > maximumFrame) {
				overflowed = true;
				failed(new Error(`${executable} output exceeded the limit`));
			}
		});
		child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString("utf8")).slice(-8192); });
		child.stdout.once("error", failed);
		child.stderr.once("error", failed);
		child.once("error", error => { failure ??= error; });
		child.once("close", (code, signal) => {
			if (failure) reject(failure);
			else if (code === 0) resolve(output);
			else reject(new Error(`${executable} failed (${signal ?? code}): ${error}`));
		});
	});
}

async function isMounted(path: string): Promise<boolean> {
	return (await run("/sbin/mount", [])).split("\n").some(line => line.includes(` on ${path} (`));
}

/** No install, registration, signing, or privilege escalation here. */
export class NativeMountDriver implements MountDriver {
	constructor(private readonly executable = helperPath) {}

	launch(socketPath: string): ProviderProcess {
		if (process.platform !== "darwin") throw new Error("pifs requires macOS");
		return spawn(this.executable, ["--socket", socketPath], { stdio: "pipe" });
	}

	async mount(socketPath: string, mountpoint: string, signal: AbortSignal): Promise<void> {
		const options = [
			// Abort and detach an unresponsive mount, including stuck CLOSE/writeback.
			// The dead timeout starts after NFS declares the server unresponsive.
			"vers=4.0", "proto=ticotsord", `port=${socketPath}`, "hard", "deadtimeout=5", "nocallback",
			"noresvport", "nodev", "nosuid", "nobrowse", "retrycnt=0",
		];
		await run("/sbin/mount_nfs", ["-o", options.join(","), "<>:/", mountpoint], signal);
		if (!await isMounted(mountpoint)) throw new Error("pifs mount command returned without mounting the proxy");
	}

	async stop(mountpoint: string, force = false): Promise<void> {
		if (!await isMounted(mountpoint)) return;
		try { await run("/sbin/umount", force ? ["-f", mountpoint] : [mountpoint]); }
		catch (error) {
			if (!await isMounted(mountpoint)) return;
			if (force) throw error;
			try { await run("/sbin/umount", ["-f", mountpoint]); }
			catch (forced) { throw new AggregateError([error, forced], `Could not unmount pifs at ${mountpoint}`); }
		}
		if (await isMounted(mountpoint)) throw new Error(`pifs mount remains active: ${mountpoint}`);
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
export function normalizeProxyPath(proxy: Pick<PiFSController, "path" | "hostPath">, path: string, cwd: string, intent: Intent, allow: Allow): string {
	return proxy.path(normalizeHostPath(proxy.hostPath(path), cwd, intent, allow));
}

function metadata(info: NonNullable<Awaited<ReturnType<typeof stat>>>): FileStat {
	return { type: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", isDirectory: () => info.isDirectory() };
}
/** Never perform synchronous IO on the proxy: native IO can wait for our UI/IPC loop. */
export class ProxyFiles implements FileOperations {
	constructor(private readonly controller: PiFSController) {}
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
		// so the provider can request per-native-access approval rather than pruning them.
		return sandboxedLocalSearch(path, {
			scopes: [
				...(policy?.scopes ?? []).map(scope => ({ ...scope, path: this.controller.path(scope.path), access: scope.access === "ask" ? "allow" as const : scope.access })),
				{ path: this.controller.path("/"), access: "allow" },
			],
			assertFresh: () => { this.check(); policy?.assertFresh(); },
		});
	}
}
