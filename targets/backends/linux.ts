import { spawn, spawnSync } from "node:child_process";
import type { RunningTarget, Vm } from "../api.ts";
import type { BackendCapabilities, CreateVmOptions, ExecResult, StartOptions, TargetBackend } from "../api.ts";

const LABEL = "works.earendil.pi";
const DEFAULT_IMAGE = "ubuntu:latest";

function rand(): string {
	return Math.random().toString(36).slice(2, 10);
}

function safePart(s: string): string {
	if (s.startsWith("pi-run-")) throw new Error("Use the public target id, not the Docker container name");
	if (s.startsWith("pi-")) throw new Error("Use the public VM id without the pi- prefix");
	const out = s.toLowerCase();
	if (out === "local") throw new Error('VM name "local" is reserved');
	if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(out)) throw new Error("VM names must match [a-z0-9][a-z0-9_.-]{0,62}");
	return out;
}

function vmId(s: string): string {
	return `pi-${safePart(s)}`;
}

function docker(args: string[]): string {
	const r = spawnSync("docker", args, { encoding: "utf8" });
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error((r.stderr || r.stdout || `docker ${args.join(" ")} failed`).trim());
	return r.stdout.trim();
}

function dockerAsync(args: string[], onOutput?: (output: string) => void): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stdout = appendBounded(stdout, chunk, { maxChars: 50_000, maxLines: 500 }).text;
			onOutput?.(text);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderr = appendBounded(stderr, chunk, { maxChars: 50_000, maxLines: 500 }).text;
			onOutput?.(text);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve(stdout.trim());
			else reject(new Error((stderr || stdout || `docker ${args.join(" ")} failed`).trim()));
		});
	});
}

function dockerOk(args: string[]): boolean {
	const r = spawnSync("docker", args, { encoding: "utf8" });
	return !r.error && r.status === 0;
}

function containerFor(id: string): string {
	return `pi-run-${safePart(id)}`;
}

function builderFor(id: string): string {
	return `pi-build-${safePart(id)}-${rand()}`;
}

function guestPath(hostPath: string): string {
	return `/mnt/pi/${hostPath.split("/").filter(Boolean).join("/")}`;
}

function label(imageOrContainer: string, key: string): string {
	const out = docker(["inspect", imageOrContainer, "--format", `{{ index .Config.Labels \"${key}\" }}`]);
	return out === "<no value>" ? "" : out;
}

function assertPiResource(name: string): void {
	if (label(name, LABEL) !== "true") throw new Error("target is not a managed Docker resource");
}

function requireContainer(targetId: string): string {
	const container = containerFor(targetId);
	if (!dockerOk(["container", "inspect", container])) throw new Error(`No running target ${targetId}`);
	assertPiResource(container);
	return container;
}

function shQuote(s: string): string {
	return `'${s.replaceAll("'", `'"'"'`)}'`;
}

function dockerExecBytes(targetId: string, script: string, input?: Buffer): Buffer {
	const container = requireContainer(targetId);
	const r = spawnSync("docker", ["exec", "-i", container, "bash", "-lc", script], { input, encoding: "buffer" });
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error((r.stderr?.toString("utf8") || r.stdout?.toString("utf8") || `docker exec ${targetId} failed`).trim());
	return r.stdout ?? Buffer.alloc(0);
}

function dockerExecBytesAsync(targetId: string, script: string, opts: { input?: Buffer; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
	const container = requireContainer(targetId);
	return new Promise((resolve, reject) => {
		const child = spawn("docker", ["exec", "-i", container, "bash", "-lc", script], { stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		let timedOut = false;
		let timeout: NodeJS.Timeout | undefined;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			opts.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => child.kill("SIGKILL");
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", (err) => settle(() => reject(err)));
		child.once("close", (code) => settle(() => {
			if (opts.signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`docker exec ${targetId} timed out`));
			else if (code === 0) resolve(Buffer.concat(stdout));
			else reject(new Error((Buffer.concat(stderr).toString("utf8") || Buffer.concat(stdout).toString("utf8") || `docker exec ${targetId} failed`).trim()));
		}));
		if (opts.input !== undefined) child.stdin?.end(opts.input);
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) timeout = setTimeout(() => { timedOut = true; onAbort(); }, opts.timeoutMs);
	});
}

function dirnamePosix(path: string): string {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "/" : path.slice(0, i);
}

function splitNul(buf: Buffer): string[] {
	return buf
		.toString("utf8")
		.split("\0")
		.filter(Boolean);
}

function appendBounded(
	current: string,
	chunk: Buffer,
	options: { maxChars?: number; maxLines?: number } = {},
): { text: string; truncated: boolean } {
	const maxChars = options.maxChars ?? 20_000;
	const maxLines = options.maxLines ?? 200;
	let next = current + chunk.toString("utf8");
	let truncated = false;

	if (next.length > maxChars) {
		next = next.slice(-maxChars);
		truncated = true;
	}

	const lines = next.split("\n");
	if (lines.length > maxLines) {
		next = lines.slice(-maxLines).join("\n");
		truncated = true;
	}

	return { text: next, truncated };
}

function truncationNotice(label: "stdout" | "stderr"): string {
	return `[${label} truncated: showing last captured lines]\n`;
}

export class LinuxBackend implements TargetBackend {
	readonly kind = "linux" as const;
	readonly transport = "direct" as const;
	readonly enforces: BackendCapabilities = { isolation: true, mounts: true, network: true };
	private targets = new Map<string, RunningTarget>();
	private vms = new Map<string, Vm>();

	private imageForBase(base: string): string {
		const id = safePart(base);
		const image = vmId(id);
		if (dockerOk(["image", "inspect", image]) && label(image, LABEL) === "true") return image;
		throw new Error(`base VM ${id} does not exist`);
	}

	private vmFromImage(image: string): Vm | undefined {
		try {
			if (label(image, LABEL) !== "true" || label(image, `${LABEL}.kind`) !== "vm") return undefined;
			const rawId = label(image, `${LABEL}.id`);
			if (!rawId) return undefined;
			const id = safePart(rawId);
			const name = label(image, `${LABEL}.name`);
			return name ? { id, name: safePart(name) } : { id };
		} catch {
			return undefined;
		}
	}

	async createVm(opts: CreateVmOptions = {}): Promise<Vm> {
		const id = safePart(opts.name ?? `scratch-${rand()}`);
		const image = vmId(id);
		if (dockerOk(["image", "inspect", image])) throw new Error(`VM ${id} already exists`);
		const vm: Vm = opts.name ? { id, name: safePart(opts.name) } : { id };
		const base = opts.base ? this.imageForBase(opts.base) : DEFAULT_IMAGE;
		const setupContainer = builderFor(id);

		opts.onOutput?.(`Preparing VM ${id}\n`);
		await dockerAsync([
			"run",
			"-d",
			"--name",
			setupContainer,
			"--label",
			`${LABEL}=true`,
			"--label",
			`${LABEL}.kind=builder`,
			"--label",
			`${LABEL}.id=${id}`,
			"--network",
			opts.network ? "bridge" : "none",
			base,
			"sleep",
			"infinity",
		], opts.onOutput);
		try {
			opts.onOutput?.(`\nSaving VM ${id}\n`);
			await dockerAsync([
				"commit",
				"--change",
				`LABEL ${LABEL}=true`,
				"--change",
				`LABEL ${LABEL}.kind=vm`,
				"--change",
				`LABEL ${LABEL}.id=${id}`,
				"--change",
				`LABEL ${LABEL}.name=${vm.name ?? ""}`,
				"--change",
				`LABEL ${LABEL}.published=false`,
				"--change",
				`LABEL ${LABEL}.createdAt=${new Date().toISOString()}`,
				setupContainer,
				image,
			], opts.onOutput);
		} finally {
			assertPiResource(setupContainer);
			opts.onOutput?.(`\nCleaning up VM ${id}\n`);
			await dockerAsync(["rm", "-f", setupContainer], opts.onOutput);
		}

		opts.onOutput?.(`Created stopped VM ${id}\n`);
		this.vms.set(id, vm);
		return vm;
	}

	destroyVm(id0: string): Promise<void> {
		const id = safePart(id0);
		const image = vmId(id);
		const targetId = containerFor(id);
		if (dockerOk(["container", "inspect", targetId])) {
			assertPiResource(targetId);
			throw new Error(`VM ${id} is running; stop it before destroying it`);
		}
		if (!dockerOk(["image", "inspect", image])) throw new Error(`VM ${id} does not exist`);
		assertPiResource(image);
		docker(["image", "rm", "-f", image]);
		this.targets.delete(id);
		this.vms.delete(id);
		return Promise.resolve();
	}

	listVms(): Vm[] {
		try {
			const ids = docker(["image", "ls", "--format", "{{.Repository}}", "--filter", `label=${LABEL}=true`, "--filter", `label=${LABEL}.kind=vm`])
				.split("\n")
				.filter(Boolean);
			return ids.map((id) => this.vmFromImage(id)).filter((v): v is Vm => v !== undefined);
		} catch {
			return [...this.vms.values()];
		}
	}

	getVm(id0: string): Vm | undefined {
		const id = safePart(id0);
		return this.vms.get(id) ?? this.vmFromImage(vmId(id));
	}

	start(id0: string, opts: StartOptions): Promise<RunningTarget> {
		const id = safePart(id0);
		const image = vmId(id);
		if (!dockerOk(["image", "inspect", image])) throw new Error(`VM ${id} does not exist`);
		assertPiResource(image);
		const targetId = containerFor(id);
		if (dockerOk(["container", "inspect", targetId])) {
			assertPiResource(targetId);
			throw new Error(`VM ${id} is already running; stop it first`);
		}
		const args = [
			"run",
			"-d",
			"--name",
			targetId,
			"--label",
			`${LABEL}=true`,
			"--label",
			`${LABEL}.kind=target`,
			"--label",
			`${LABEL}.id=${id}`,
			"--network",
			opts.network ? "bridge" : "none",
		];
		for (const m of opts.mounts) {
			args.push("--mount", `type=bind,src=${m.hostPath},dst=${guestPath(m.hostPath)}${m.mode === "ro" ? ",readonly" : ""}`);
		}
		args.push(image, "sleep", "infinity");
		docker(args);
		const target: RunningTarget = {
			id,
			kind: "linux",
			vm: this.getVm(id) ?? { id },
			mounts: opts.mounts.map((m) => ({ ...m, guestPath: guestPath(m.hostPath) })),
			network: opts.network ?? false,
			exec: true,
		};
		this.targets.set(id, target);
		return Promise.resolve(target);
	}

	stop(targetId: string): Promise<void> {
		const container = requireContainer(targetId);
		const id = safePart(label(container, `${LABEL}.id`) || targetId);
		const vm = this.getVm(id) ?? { id };
		docker([
			"commit",
			"--change",
			`LABEL ${LABEL}=true`,
			"--change",
			`LABEL ${LABEL}.kind=vm`,
			"--change",
			`LABEL ${LABEL}.id=${id}`,
			"--change",
			`LABEL ${LABEL}.name=${vm.name ?? ""}`,
			"--change",
			`LABEL ${LABEL}.published=${this.isPublished(id) ? "true" : "false"}`,
			"--change",
			`LABEL ${LABEL}.updatedAt=${new Date().toISOString()}`,
			container,
			vmId(id),
		]);
		docker(["rm", "-f", container]);
		this.targets.delete(id);
		this.vms.set(id, vm);
		return Promise.resolve();
	}

	running(): RunningTarget[] {
		return [...this.targets.values()];
	}

	vmExecBytes(targetId: string, script: string, opts: { input?: Buffer; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
		return dockerExecBytesAsync(targetId, script, opts);
	}

	vmExists(targetId: string, path: string): boolean {
		try {
			dockerExecBytes(targetId, `test -e ${shQuote(path)}`);
			return true;
		} catch {
			return false;
		}
	}

	vmStat(targetId: string, path: string): { isDirectory: () => boolean } {
		const out = dockerExecBytes(targetId, `if test -L ${shQuote(path)}; then printf l; elif test -d ${shQuote(path)}; then printf d; elif test -e ${shQuote(path)}; then printf f; else exit 1; fi`).toString("utf8");
		return { isDirectory: () => out === "d" };
	}

	vmIsSymlink(targetId: string, path: string): boolean {
		try {
			dockerExecBytes(targetId, `test -L ${shQuote(path)}`);
			return true;
		} catch {
			return false;
		}
	}

	vmIsFile(targetId: string, path: string): boolean {
		try {
			dockerExecBytes(targetId, `test -f ${shQuote(path)}`);
			return true;
		} catch {
			return false;
		}
	}

	vmReadDir(targetId: string, path: string): string[] {
		const script = `find ${shQuote(path)} -mindepth 1 -maxdepth 1 -printf '%f\\0' | sort -z`;
		return splitNul(dockerExecBytes(targetId, script));
	}

	vmReadFile(targetId: string, path: string): Buffer {
		return dockerExecBytes(targetId, `cat -- ${shQuote(path)}`);
	}

	vmReadFileBytes(targetId: string, path: string, maxBytes: number): Buffer {
		return dockerExecBytes(targetId, `head -c ${Math.max(1, maxBytes)} -- ${shQuote(path)}`);
	}

	vmWriteFile(targetId: string, path: string, content: string): void {
		dockerExecBytes(targetId, `mkdir -p -- ${shQuote(dirnamePosix(path))} && cat > ${shQuote(path)}`, Buffer.from(content));
	}

	vmWriteFileBytes(targetId: string, path: string, content: Buffer): void {
		dockerExecBytes(targetId, `mkdir -p -- ${shQuote(dirnamePosix(path))} && cat > ${shQuote(path)}`, content);
	}

	vmMkdir(targetId: string, path: string): void {
		dockerExecBytes(targetId, `mkdir -p -- ${shQuote(path)}`);
	}

	vmMkdirOne(targetId: string, path: string): void {
		dockerExecBytes(targetId, `mkdir -- ${shQuote(path)}`);
	}

	vmWalk(targetId: string, path: string, limit: number): { path: string; isDir: boolean }[] {
		const q = shQuote(path);
		const n = Math.max(1, limit);
		const script = `if test -d ${q}; then find ${q} -mindepth 1 -printf '%y %p\\0' | head -z -n ${n}; elif test -e ${q}; then printf 'f %s\\0' ${q}; else exit 1; fi`;
		return splitNul(dockerExecBytes(targetId, script)).map((entry) => ({ path: entry.slice(2), isDir: entry[0] === "d" }));
	}

	vmGrep(targetId: string, path: string, pattern: string, limit: number): string[] {
		const qPath = shQuote(path);
		const qPattern = shQuote(pattern);
		const n = Math.max(1, limit);
		const maxBytes = 256 * 1024;
		const script = `if test -d ${qPath}; then find ${qPath} -type f -exec grep -nIH -E -- ${qPattern} {} + 2>/dev/null; elif test -f ${qPath}; then grep -nIH -E -- ${qPattern} ${qPath} 2>/dev/null; else exit 1; fi | head -n ${n + 1} | head -c ${maxBytes + 1}`;
		const out = dockerExecBytes(targetId, script);
		const byteTruncated = out.length > maxBytes;
		const lines = out.subarray(0, maxBytes).toString("utf8").split("\n").filter(Boolean);
		const lineTruncated = lines.length > n;
		const shown = lines.slice(0, n);
		if (lineTruncated) shown.push(`[grep truncated: showing first ${n} matches; narrow the path or pattern for more]`);
		else if (byteTruncated) shown.push(`[grep truncated: output exceeded ${maxBytes} bytes; narrow the path or pattern for more]`);
		return shown;
	}

	execStream(
		targetId: string,
		command: string,
		opts: { timeoutMs?: number; timeoutLabel?: string; cwd?: string; signal?: AbortSignal; onData: (data: Buffer) => void },
	): Promise<{ exitCode: number | null }> {
		const container = requireContainer(targetId);
		const args = ["exec"];
		if (opts.cwd) args.push("-w", opts.cwd);
		args.push(container, "bash", "-lc", command);

		return new Promise((resolve, reject) => {
			const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
			let timedOut = false;
			let settled = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				opts.signal?.removeEventListener("abort", onAbort);
				fn();
			};
			const onAbort = () => child.kill("SIGKILL");

			child.stdout?.on("data", opts.onData);
			child.stderr?.on("data", opts.onData);
			child.once("error", (err) => settle(() => reject(err)));
			child.once("close", (code) => {
				settle(() => {
					if (opts.signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${opts.timeoutLabel ?? Math.ceil((opts.timeoutMs ?? 0) / 1000)}`));
					else resolve({ exitCode: code });
				});
			});

			if (opts.signal) {
				if (opts.signal.aborted) onAbort();
				else opts.signal.addEventListener("abort", onAbort, { once: true });
			}
			const timeoutMs = opts.timeoutMs;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeoutMs);
			}
		});
	}

	exec(
		targetId: string,
		command: string,
		opts: {
			timeoutMs?: number;
			cwd?: string;
			onOutput?: (output: { stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean }) => void;
		} = {},
	): Promise<ExecResult> {
		const container = requireContainer(targetId);
		const args = ["exec"];
		if (opts.cwd) args.push("-w", opts.cwd);
		args.push(container, "bash", "-lc", command);

		return new Promise((resolve) => {
			const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let stdoutTruncated = false;
			let stderrTruncated = false;
			let timedOut = false;
			let settled = false;
			let dirty = false;
			let lastUpdateAt = 0;
			let updateHandle: NodeJS.Timeout | undefined;
			let timeoutHandle: NodeJS.Timeout | undefined;

			const emitUpdate = () => {
				if (!dirty || !opts.onOutput) return;
				dirty = false;
				lastUpdateAt = Date.now();
				opts.onOutput({ stdout, stderr, stdoutTruncated, stderrTruncated });
			};
			const scheduleUpdate = () => {
				if (!opts.onOutput) return;
				dirty = true;
				const delay = 250 - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					if (updateHandle) clearTimeout(updateHandle);
					updateHandle = undefined;
					emitUpdate();
					return;
				}
				updateHandle ??= setTimeout(() => {
					updateHandle = undefined;
					emitUpdate();
				}, delay);
			};

			const settle = (result: ExecResult) => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (updateHandle) clearTimeout(updateHandle);
				emitUpdate();
				resolve(result);
			};

			child.stdout?.on("data", (chunk: Buffer) => {
				const next = appendBounded(stdout, chunk);
				stdout = next.text;
				stdoutTruncated ||= next.truncated;
				scheduleUpdate();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				const next = appendBounded(stderr, chunk);
				stderr = next.text;
				stderrTruncated ||= next.truncated;
				scheduleUpdate();
			});
			child.once("error", (err) => {
				settle({ stdout: "", stderr: String(err), exitCode: 124, timedOut: false });
			});
			child.once("close", (code) => {
				settle({
					stdout: `${stdoutTruncated ? truncationNotice("stdout") : ""}${stdout}`,
					stderr: `${stderrTruncated ? truncationNotice("stderr") : ""}${stderr}`,
					exitCode: timedOut ? 124 : (code ?? 124),
					timedOut,
				});
			});

			const timeoutMs = opts.timeoutMs ?? 60_000;
			if (timeoutMs > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeoutMs);
			}
		});
	}

	isPublished(id0: string): boolean {
		try {
			const id = safePart(id0);
			const image = vmId(id);
			return label(image, LABEL) === "true" && label(image, `${LABEL}.published`) === "true";
		} catch {
			return false;
		}
	}

	publish(targetId: string, name: string): string {
		const container = requireContainer(targetId);
		const id = safePart(name);
		const image = vmId(id);
		const sourceId = safePart(label(container, `${LABEL}.id`) || targetId);
		if (dockerOk(["image", "inspect", image]) && id !== sourceId) throw new Error(`VM ${id} already exists`);
		docker([
			"commit",
			"--change",
			`LABEL ${LABEL}=true`,
			"--change",
			`LABEL ${LABEL}.kind=vm`,
			"--change",
			`LABEL ${LABEL}.id=${id}`,
			"--change",
			`LABEL ${LABEL}.name=${safePart(name)}`,
			"--change",
			`LABEL ${LABEL}.published=true`,
			"--change",
			`LABEL ${LABEL}.createdAt=${new Date().toISOString()}`,
			container,
			image,
		]);
		return id;
	}
}
