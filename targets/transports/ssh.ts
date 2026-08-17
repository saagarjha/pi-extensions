import { spawn } from "node:child_process";

export type SshTargetConfig = { id: string; destination: string; port?: number }; 

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

