import { spawn } from "node:child_process";

export type DirectStreamOptions = {
	cwd?: string;
	timeoutMs?: number;
	timeoutLabel?: string;
	signal?: AbortSignal;
	onData: (data: Buffer) => void;
};

/** Execute a command directly on the machine hosting the local backend. */
export function runDirect(command: string, args: string[], opts: { cwd?: string; stdin?: string | Buffer; signal?: AbortSignal } = {}): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: opts.cwd, stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = []; const stderr: Buffer[] = [];
		const abort = () => child.kill("SIGKILL");
		child.stdout?.on("data", (c: Buffer) => stdout.push(c)); child.stderr?.on("data", (c: Buffer) => stderr.push(c));
		child.once("error", reject); child.once("close", (exitCode) => { opts.signal?.removeEventListener("abort", abort); resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode }); });
		if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
		if (opts.signal) { if (opts.signal.aborted) abort(); else opts.signal.addEventListener("abort", abort, { once: true }); }
	});
}

/** Streaming command execution used by the local target. */
export function runDirectStream(command: string, opts: DirectStreamOptions): Promise<{ exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-lc", command], { cwd: opts.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
		let timedOut = false;
		let settled = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		const onAbort = () => child.kill("SIGKILL");
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			opts.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		child.stdout?.on("data", opts.onData);
		child.stderr?.on("data", opts.onData);
		child.once("error", (err) => settle(() => reject(err)));
		child.once("close", (code) => settle(() => {
			if (opts.signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${opts.timeoutLabel ?? Math.ceil((opts.timeoutMs ?? 0) / 1000)}`));
			else resolve({ exitCode: code });
		}));
		if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener("abort", onAbort, { once: true }); }
		if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) timeoutHandle = setTimeout(() => { timedOut = true; onAbort(); }, opts.timeoutMs);
	});
}
