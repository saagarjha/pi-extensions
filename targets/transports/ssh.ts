import { searchScript, spawnSearch, type SearchPlan } from "../search.ts";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { FileOperations, FileProgress, FileStat } from "../files.ts";

export type SshTargetConfig = { id: string; destination: string; port?: number };

const FILE_TIMEOUT_MS = 300_000;
const MAX_STDERR_BYTES = 64 * 1024;

export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function sshArgs(target: SshTargetConfig, remoteCommand: string): string[] {
	const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
	if (target.port !== undefined) args.push("-p", String(target.port));
	args.push(target.destination, remoteCommand);
	return args;
}

export function runSshBytes(target: SshTargetConfig, remoteCommand: string, opts: { stdin?: string | Buffer; signal?: AbortSignal; onData?: (chunk: Buffer) => void; timeoutMs?: number } = {}): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", sshArgs(target, remoteCommand), { stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			opts.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => child.kill("SIGKILL");
		child.stdout?.on("data", (chunk: Buffer) => { stdout.push(chunk); opts.onData?.(chunk); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr.push(chunk); });
		child.once("error", (err) => settle(() => reject(err)));
		child.once("close", (code) => settle(() => resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code })));
		if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) timeout = setTimeout(onAbort, opts.timeoutMs);
	});
}

export function runSsh(target: SshTargetConfig, remoteCommand: string, opts: { stdin?: string; signal?: AbortSignal; onData?: (chunk: Buffer) => void; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return runSshBytes(target, remoteCommand, opts).then((res) => ({ stdout: res.stdout.toString(), stderr: res.stderr.toString(), exitCode: res.exitCode }));
}

function fileError(stderr: Buffer, code: number | null): Error {
	return new Error((stderr.toString() || `SSH file operation exited ${code ?? "without a status"}`).trim());
}

function inactivityTimer(onTimeout: () => void) {
	let timer = setTimeout(onTimeout, FILE_TIMEOUT_MS);
	return {
		touch() { clearTimeout(timer); timer = setTimeout(onTimeout, FILE_TIMEOUT_MS); },
		stop() { clearTimeout(timer); },
	};
}

/** SSH transport, including streaming file primitives used by targets. */
export class SshTransport implements FileOperations {
	constructor(readonly config: SshTargetConfig) {}

	searchPlan(path: string): SearchPlan {
		return { roots: [{ path, exclude: [] }], spawn: (tool, commands, signal) => {
			// Resolve only in the target's controlled environment; never probe the host.
			const script = searchScript(tool, commands, tool);
			const command = `cd / && exec /usr/bin/env -i PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin HOME=/var/empty LANG=en_US.UTF-8 /bin/sh -c ${shellQuote(script)}`;
			return spawnSearch("ssh", sshArgs(this.config, command), { cwd: "/" }, signal);
		} };
	}

	async exists(path: string, signal?: AbortSignal): Promise<boolean> {
		const result = await runSshBytes(this.config, `if test -e ${shellQuote(path)} || test -L ${shellQuote(path)}; then printf y; else printf n; fi`, { signal, timeoutMs: FILE_TIMEOUT_MS });
		if (result.exitCode !== 0) throw fileError(result.stderr, result.exitCode);
		return result.stdout.toString("ascii") === "y";
	}

	async size(path: string, signal?: AbortSignal): Promise<number> {
		const result = await runSshBytes(this.config, `wc -c < ${shellQuote(path)}`, { signal, timeoutMs: FILE_TIMEOUT_MS });
		if (result.exitCode !== 0) throw fileError(result.stderr, result.exitCode);
		const size = Number(result.stdout.toString("ascii").trim());
		if (!Number.isSafeInteger(size) || size < 0) throw new Error(`SSH returned an invalid file size for ${path}`);
		return size;
	}

	async stat(path: string, signal?: AbortSignal): Promise<FileStat> {
		// Deliberately use test -d before test -e: SSH targets treat a symlink to a
		// directory as a directory, matching the historic macOS SSH adapter.
		const result = await runSshBytes(this.config, `if test -d ${shellQuote(path)}; then printf d; elif test -e ${shellQuote(path)}; then printf f; else exit 1; fi`, { signal, timeoutMs: FILE_TIMEOUT_MS });
		if (result.exitCode !== 0) throw fileError(result.stderr, result.exitCode);
		const type = result.stdout.equals(Buffer.from("d")) ? "directory" : "file";
		return { type, isDirectory: () => type === "directory" };
	}

	async lstat(path: string, signal?: AbortSignal): Promise<FileStat> {
		const q = shellQuote(path);
		const result = await runSshBytes(this.config, `if test -L ${q}; then printf l; elif test -d ${q}; then printf d; elif test -f ${q}; then printf f; elif test -e ${q}; then printf o; else exit 1; fi`, { signal, timeoutMs: FILE_TIMEOUT_MS });
		if (result.exitCode !== 0) throw fileError(result.stderr, result.exitCode);
		const marker = result.stdout.toString("ascii");
		const type = marker === "l" ? "symlink" : marker === "d" ? "directory" : marker === "f" ? "file" : "other";
		return { type, isDirectory: () => type === "directory" };
	}

	async mkdir(path: string, signal?: AbortSignal): Promise<void> {
		const result = await runSshBytes(this.config, `mkdir -- ${shellQuote(path)}`, { signal, timeoutMs: FILE_TIMEOUT_MS });
		if (result.exitCode !== 0) throw fileError(result.stderr, result.exitCode);
	}

	async readdir(path: string, signal?: AbortSignal): Promise<string[]> {
		// NUL framing preserves names containing whitespace and newlines. Sorting is
		// local because BSD and GNU sort differ in their NUL-delimited options.
		const result = await runSshBytes(this.config, `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -print0`, { signal, timeoutMs: FILE_TIMEOUT_MS });
		if (result.exitCode !== 0) throw fileError(result.stderr, result.exitCode);
		const names: string[] = [];
		for (const entry of result.stdout.toString("utf8").split("\0")) {
			if (!entry) continue;
			const slash = entry.lastIndexOf("/");
			names.push(entry.slice(slash + 1));
		}
		return names.sort();
	}

	async *openRead(path: string, signal?: AbortSignal): AsyncIterable<Buffer> {
		if (signal?.aborted) throw new Error("aborted");
		const child = spawn("ssh", sshArgs(this.config, `cat -- ${shellQuote(path)}`), { stdio: ["ignore", "pipe", "pipe"] });
		const stderr: Buffer[] = [];
		let stderrBytes = 0;
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderrBytes >= MAX_STDERR_BYTES) return;
			const kept = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
			stderr.push(kept); stderrBytes += kept.length;
		});
		const closed = once(child, "close");
		const abort = () => child.kill("SIGKILL");
		const inactivity = inactivityTimer(abort);
		child.stdout.on("data", () => inactivity.touch());
		if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
		try {
			for await (const chunk of child.stdout) yield Buffer.from(chunk);
			const [code] = await closed as [number | null];
			if (signal?.aborted) throw new Error("aborted");
			if (code !== 0) throw fileError(Buffer.concat(stderr), code);
		} finally {
			inactivity.stop();
			signal?.removeEventListener("abort", abort);
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	}

	async write(path: string, chunks: AsyncIterable<Buffer>, signal?: AbortSignal, onProgress?: FileProgress): Promise<void> {
		if (signal?.aborted) throw new Error("aborted");
		const slash = path.lastIndexOf("/");
		const parent = slash < 0 ? "." : slash === 0 ? "/" : path.slice(0, slash);
		const child = spawn("ssh", sshArgs(this.config, `mkdir -p -- ${shellQuote(parent)} && cat > ${shellQuote(path)}`), { stdio: ["pipe", "ignore", "pipe"] });
		const stderr: Buffer[] = [];
		let stderrBytes = 0;
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderrBytes >= MAX_STDERR_BYTES) return;
			const kept = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
			stderr.push(kept); stderrBytes += kept.length;
		});
		const closed = once(child, "close");
		const abort = () => child.kill("SIGKILL");
		const inactivity = inactivityTimer(abort);
		if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
		try {
			let transferred = 0;
			for await (const chunk of chunks) {
				if (signal?.aborted) throw new Error("aborted");
				if (!child.stdin.write(chunk)) await once(child.stdin, "drain");
				transferred += chunk.length;
				onProgress?.(transferred);
				inactivity.touch();
			}
			child.stdin.end();
			const [code] = await closed as [number | null];
			if (signal?.aborted) throw new Error("aborted");
			if (code !== 0) throw fileError(Buffer.concat(stderr), code);
		} finally {
			inactivity.stop();
			signal?.removeEventListener("abort", abort);
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	}
}
