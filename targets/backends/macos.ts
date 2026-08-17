import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendCapabilities, CreateVmOptions, ExecResult, RunningTarget, StartOptions, TargetBackend, Vm } from "../api.ts";
import { runSshBytes, shellQuote, type SshTargetConfig } from "../transports/ssh.ts";

type HelperReply = { ok: boolean; error?: string; event?: "started" | "status" | "stopped"; state?: string; vms?: Array<{ id: string; name?: string }>; vm?: { id: string; name?: string }; endpoint?: { host: string; port: number; user: string } };
const root = join(process.env.HOME ?? "", "Library", "Caches", "pi-macos-vms");
const source = join(dirname(fileURLToPath(import.meta.url)), "vm.swift");
const entitlement = join(dirname(fileURLToPath(import.meta.url)), "vm.entitlements");
const binary = join(root, "vm");

function safe(id: string): string { const value = id.toLowerCase(); if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(value) || value === "local" || value.startsWith("pi-")) throw new Error("VM names must match [a-z0-9][a-z0-9_.-]{0,62}"); return value; }
function random(): string { return Math.random().toString(36).slice(2, 10); }
function q(value: string): string { return shellQuote(value); }
function parent(path: string): string { const i = path.lastIndexOf("/"); return i <= 0 ? "/" : path.slice(0, i); }
function nul(data: Buffer): string[] { return data.toString().split("\0").filter(Boolean); }

function run(executable: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], env }); let stdout = ""; let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
		child.once("error", reject); child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout || `${executable} exited (${code})`).trim())));
		child.stdin.end(input);
	});
}

/** Builds only asynchronously: image download/install/build never run on Pi's event loop. */
async function ensureHelper(): Promise<void> {
	if (existsSync(binary)) return;
	mkdirSync(dirname(binary), { recursive: true });
	await run("xcrun", ["swiftc", "-parse-as-library", "-O", source, "-o", binary, "-framework", "Virtualization", "-framework", "DiskImageKit", "-framework", "Network"]);
	await run("codesign", ["--force", "--sign", "-", "--entitlements", entitlement, binary]);
}
async function command(request: object): Promise<HelperReply> {
	await ensureHelper();
	const result = await run(binary, [], JSON.stringify(request));
	let reply: HelperReply; try { reply = JSON.parse(result.stdout); } catch { throw new Error(`macOS VM helper returned invalid JSON: ${(result.stderr || result.stdout).trim()}`); }
	if (!reply.ok) throw new Error(reply.error ?? "macOS VM helper failed"); return reply;
}

/** One helper owns one live VZVirtualMachine and accepts newline-delimited JSON controls. */
class MacService {
	private readonly child: ChildProcessWithoutNullStreams;
	private buffer = "";
	private waiter?: { event: HelperReply["event"]; resolve: (reply: HelperReply) => void; reject: (error: Error) => void };
	private exited = false;
	constructor() {
		this.child = spawn(binary, ["--serve"], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk.toString()));
		this.child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk).slice(-16_000); });
		this.child.once("error", (error) => this.finish(error));
		this.child.once("close", (code) => this.finish(new Error((stderr || `macOS VM service exited (${code})`).trim())));
	}
	private receive(text: string): void {
		this.buffer += text;
		for (;;) { const newline = this.buffer.indexOf("\n"); if (newline < 0) return; const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); if (!line) continue;
			let reply: HelperReply; try { reply = JSON.parse(line); } catch { this.finish(new Error("macOS VM service returned invalid JSON")); return; }
			if (this.waiter && (!this.waiter.event || reply.event === this.waiter.event)) { const waiter = this.waiter; this.waiter = undefined; reply.ok ? waiter.resolve(reply) : waiter.reject(new Error(reply.error ?? "macOS VM service failed")); }
		}
	}
	private finish(error: Error): void { if (this.exited) return; this.exited = true; const waiter = this.waiter; this.waiter = undefined; waiter?.reject(error); }
	request(payload: object, event: HelperReply["event"]): Promise<HelperReply> {
		if (this.exited) return Promise.reject(new Error("macOS VM service is not running"));
		if (this.waiter) return Promise.reject(new Error("macOS VM service already has a control request"));
		return new Promise((resolve, reject) => { this.waiter = { event, resolve, reject }; this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => { if (error) this.finish(error); }); });
	}
	async stop(): Promise<void> { try { await this.request({ command: "stop" }, "stopped"); } finally { this.child.stdin.end(); } }
}

function endpointConfig(id: string, endpoint: NonNullable<HelperReply["endpoint"]>): SshTargetConfig { return { id, destination: `${endpoint.user}@${endpoint.host}`, port: endpoint.port }; }
async function bootstrapSsh(config: SshTargetConfig): Promise<void> {
	const askpass = join(tmpdir(), `pi-macos-askpass-${process.pid}`);
	writeFileSync(askpass, "#!/bin/sh\nprintf '%s\\n' 'pi-local'\n", { mode: 0o700 }); chmodSync(askpass, 0o700);
	const args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1", "-p", String(config.port), config.destination];
	const deadline = Date.now() + 300_000;
	try { for (;;) { try { await run("ssh-copy-id", args, undefined, { ...process.env, DISPLAY: "pi", SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" }); return; } catch (error) { if (Date.now() >= deadline) throw new Error(`Timed out copying the host SSH key: ${error instanceof Error ? error.message : String(error)}`); await new Promise((resolve) => setTimeout(resolve, 1000)); } } }
	finally { rmSync(askpass, { force: true }); }
}

/** Managed local VZ guest. NAT is used solely for the SSH control transport. */
export class MacOSBackend implements TargetBackend {
	readonly kind = "macos" as const;
	readonly transport = "ssh-local" as const;
	// VZNAT is required to reach the guest; it cannot enforce StartOptions.network=false.
	readonly enforces: BackendCapabilities = { isolation: true, mounts: false, network: false };
	private targets = new Map<string, RunningTarget>();
	private endpoints = new Map<string, SshTargetConfig>();
	private services = new Map<string, MacService>();
	private config(id: string): SshTargetConfig { const config = this.endpoints.get(id); if (!config) throw new Error(`No SSH-ready macOS target ${id}`); return config; }
	private sync(id: string, commandText: string, input?: Buffer): Buffer { const config = this.config(id); const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(config.port), config.destination, commandText]; const result = spawnSync("ssh", args, { input, encoding: "buffer" }); if (result.error || result.status !== 0) throw new Error((result.stderr?.toString() || result.stdout?.toString() || result.error?.message || "local VM ssh failed").trim()); return result.stdout ?? Buffer.alloc(0); }
	async createVm(opts: CreateVmOptions = {}): Promise<Vm> {
		if (opts.base) throw new Error("macOS VM base/fork creation is not implemented");
		const id = safe(opts.name ?? `scratch-${random()}`); const stage = async (commandName: string, label: string, extra: object = {}) => { opts.onOutput?.(`${label}\n`); return command({ command: commandName, ...extra }); };
		const status = await stage("base-status", "Checking macOS base state");
		if (!status.vms?.some((vm) => vm.id === "base-ready")) { await stage("download-ipsw", "Downloading supported macOS IPSW"); await stage("create-base-storage", "Creating macOS base storage"); await stage("install-base", "Installing macOS base"); }
		const reply = await stage("create-derivative", `Creating macOS VM ${id}`, { id, name: opts.name ? id : undefined }); return { ...(reply.vm ?? { id, name: opts.name ? id : undefined }), kind: "macos" };
	}
	async destroyVm(id: string): Promise<void> { await this.stop(id).catch(() => undefined); await command({ command: "destroy", id: safe(id) }); this.targets.delete(id); this.endpoints.delete(id); }
	listVms(): Vm[] { const directory = join(root, "vms"); if (!existsSync(directory)) return []; return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => { try { if (!entry.isDirectory()) return []; const value = JSON.parse(readFileSync(join(directory, entry.name, "metadata.json"), "utf8")) as { id: string; name?: string }; return [{ id: value.id, name: value.name, kind: "macos" as const }]; } catch { return []; } }); }
	getVm(id: string): Vm | undefined { return this.listVms().find((vm) => vm.id === safe(id)); }
	async start(idValue: string, opts: StartOptions): Promise<RunningTarget> {
		const id = safe(idValue); if (this.targets.has(id)) return this.targets.get(id)!; await ensureHelper(); const service = new MacService();
		try { const reply = await service.request({ command: "start", id }, "started"); if (!reply.endpoint) throw new Error("macOS VM service did not provide an endpoint"); const config = endpointConfig(id, reply.endpoint); await bootstrapSsh(config); // Do not expose exec until public-key SSH works.
			const probe = await runSshBytes(config, "true"); if (probe.exitCode !== 0) throw new Error((probe.stderr.toString() || "SSH key authentication failed").trim()); this.services.set(id, service); this.endpoints.set(id, config); const target: RunningTarget = { id, kind: "macos", vm: this.getVm(id) ?? { id, kind: "macos" }, mounts: opts.mounts, network: true, exec: true }; this.targets.set(id, target); return target;
		} catch (error) { await service.stop().catch(() => undefined); throw error; }
	}
	async stop(idValue: string): Promise<void> { const id = safe(idValue); const service = this.services.get(id); if (!service) { this.targets.delete(id); this.endpoints.delete(id); return; } try { await service.stop(); } finally { this.services.delete(id); this.targets.delete(id); this.endpoints.delete(id); } }
	running(): RunningTarget[] { return [...this.targets.values()]; }
	vmExists(id: string, path: string): boolean { try { this.sync(id, `test -e ${q(path)}`); return true; } catch { return false; } }
	vmStat(id: string, path: string) { const value = this.sync(id, `if test -d ${q(path)}; then printf d; elif test -e ${q(path)}; then printf f; else exit 1; fi`).toString(); return { isDirectory: () => value === "d" }; }
	vmReadDir(id: string, path: string): string[] { return nul(this.sync(id, `find ${q(path)} -mindepth 1 -maxdepth 1 -print0 | xargs -0 -n1 basename | sort -z`)); }
	vmReadFile(id: string, path: string): Buffer { return this.sync(id, `cat -- ${q(path)}`); }
	vmWriteFile(id: string, path: string, content: string): void { this.sync(id, `mkdir -p -- ${q(parent(path))}; cat > ${q(path)}`, Buffer.from(content)); }
	vmMkdir(id: string, path: string): void { this.sync(id, `mkdir -p -- ${q(path)}`); }
	vmWriteFileBytes(id: string, path: string, content: Buffer): void { this.sync(id, `mkdir -p -- ${q(parent(path))}; cat > ${q(path)}`, content); }
	vmWalk(id: string, path: string, limit: number) { return nul(this.sync(id, `find ${q(path)} -mindepth 1 -print0 | head -z -n ${Math.max(1, limit)}`)).map((value) => ({ path: value, isDir: false })); }
	vmGrep(id: string, path: string, pattern: string, limit: number): string[] { return this.sync(id, `grep -nIH -E -- ${q(pattern)} ${q(path)} | head -n ${Math.max(1, limit)}`).toString().split("\n").filter(Boolean); }
	vmExecBytes(id: string, commandText: string, opts: { input?: Buffer; timeoutMs?: number; signal?: AbortSignal } = {}) { return runSshBytes(this.config(id), commandText, { stdin: opts.input, timeoutMs: opts.timeoutMs, signal: opts.signal }).then((result) => { if (result.exitCode !== 0) throw new Error((result.stderr.toString() || result.stdout.toString()).trim()); return result.stdout; }); }
	execStream(id: string, commandText: string, opts: { timeoutMs?: number; cwd?: string; signal?: AbortSignal; onData: (data: Buffer) => void }) { return runSshBytes(this.config(id), opts.cwd ? `cd ${q(opts.cwd)} && ${commandText}` : commandText, { timeoutMs: opts.timeoutMs, signal: opts.signal, onData: opts.onData }).then((result) => ({ exitCode: result.exitCode })); }
	async exec(id: string, commandText: string, opts: { timeoutMs?: number; cwd?: string; onOutput?: (output: { stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean }) => void } = {}): Promise<ExecResult> { const result = await runSshBytes(this.config(id), opts.cwd ? `cd ${q(opts.cwd)} && ${commandText}` : commandText, { timeoutMs: opts.timeoutMs }); return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode ?? 124, timedOut: result.exitCode === null }; }
	isPublished(_id: string): boolean { return false; }
	publish(_id: string, _name: string): string { throw new Error("Publishing macOS VMs is not implemented"); }
}
