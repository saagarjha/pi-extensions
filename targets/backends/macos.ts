import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendCapabilities, CreateVmOptions, ExecResult, RunningTarget, SipState, StartOptions, TargetBackend, Vm } from "../api.ts";
import type { FileOperations } from "../files.ts";
import { SshTransport, runSshBytes, shellQuote, type SshTargetConfig } from "../transports/ssh.ts";

type HelperReply = { ok: boolean; error?: string; event?: "started" | "status" | "stopped"; state?: string; vms?: Array<{ id: string; name?: string }>; vm?: { id: string; name?: string }; endpoint?: { host: string; port: number; user: string } };
type MacMetadata = { id: string; name?: string; mac: string; baseDisk: string; sip: SipState };
type BputilPolicy = Record<string, unknown> & { vuid?: unknown; lpnh?: unknown; rpnh?: unknown; properly_paired?: unknown; os_paired_to_current?: unknown; security_mode?: unknown };
type AttachResult = { "system-entities"?: Array<{ "dev-entry"?: string; "content-hint"?: string }> };
type DiskInfo = { VolumeName?: string; MountPoint?: string; WritableVolume?: boolean };
const root = join(process.env.HOME ?? "", "Library", "Caches", "pi-macos-vms");
const source = join(dirname(fileURLToPath(import.meta.url)), "vm.swift");
const entitlement = join(dirname(fileURLToPath(import.meta.url)), "vm.entitlements");
const binary = join(root, "vm");
const localPolicyHelper = join(dirname(fileURLToPath(import.meta.url)), "localpolicy.rb");
const GUEST_PASSWORD = "pi-local";
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const HASH384 = /^[0-9A-F]{96}$/;
const BASE_ID = "pi-base";
const TCC_DB = "/Library/Application Support/com.apple.TCC/TCC.db";
const TCC_CLIENT = "/usr/libexec/sshd-keygen-wrapper";
const TCC_INSERT = `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier, flags) VALUES ('kTCCServiceScreenCapture', '${TCC_CLIENT}', 1, 2, 4, 1, 'UNUSED', 0);`;
const TCC_VERIFY = `SELECT auth_value FROM access WHERE service='kTCCServiceScreenCapture' AND client='${TCC_CLIENT}';`;

function safe(id: string): string { const value = id.toLowerCase(); if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(value) || value === "local" || value.startsWith("pi-")) throw new Error("VM names must match [a-z0-9][a-z0-9_.-]{0,62}"); return value; }
function random(): string { return Math.random().toString(36).slice(2, 10); }
function q(value: string): string { return shellQuote(value); }
function metadataPath(id: string): string { return join(root, "vms", id, "metadata.json"); }
function metadata(id: string): MacMetadata {
	const value = JSON.parse(readFileSync(metadataPath(id), "utf8")) as MacMetadata;
	if (value.id !== id || (value.sip !== "enabled" && value.sip !== "disabled")) throw new Error(`Invalid macOS VM metadata for ${id}; recreate it`);
	return value;
}
function writeSip(id: string, sip: SipState): void { writeFileSync(metadataPath(id), `${JSON.stringify({ ...metadata(id), sip }, null, 2)}\n`); }
type BootTarget = { id: string; disk: string; shadow?: string };
function vmBoot(info: MacMetadata): BootTarget { return { id: info.id, disk: info.baseDisk, shadow: join(root, "vms", info.id, "overlay.asif") }; }
function baseBoot(): BootTarget { return { id: BASE_ID, disk: join(root, "base", "disk.asif") }; }
const AUTOMOUNT_ROOT = "/Volumes/My Shared Files";
function macMounts(_id: string, mounts: StartOptions["mounts"]): NonNullable<StartOptions["mounts"]> {
	return (mounts ?? []).map((mount, index) => {
		const root = `${AUTOMOUNT_ROOT}/${index}`;
		return { ...mount, guestPath: !mount.permissionSession && statSync(mount.hostPath).isFile() ? `${root}/${basename(mount.hostPath)}` : root };
	});
}

function run(executable: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], env }); let stdout = ""; let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
		child.once("error", reject); child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout || `${executable} exited (${code})`).trim())));
		child.stdin.end(input);
	});
}

/** Bootstrap a missing helper, but never recompile an installed helper from mutable source. */
let warnedStaleHelper = false;
async function ensureHelper(): Promise<void> {
	if (!existsSync(binary)) {
		mkdirSync(dirname(binary), { recursive: true });
		await run("xcrun", ["swiftc", "-parse-as-library", "-O", source, "-o", binary, "-framework", "Virtualization", "-framework", "DiskImageKit", "-framework", "Network"]);
		await run("codesign", ["--force", "--sign", "-", "--entitlements", entitlement, binary]);
		return;
	}
	if (!warnedStaleHelper && statSync(binary).mtimeMs < Math.max(statSync(source).mtimeMs, statSync(entitlement).mtimeMs)) {
		warnedStaleHelper = true;
		console.warn(`macOS VM helper is older than its source; using the installed helper at ${binary}. Delete it to allow a bootstrap rebuild.`);
	}
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
	private readonly closed: Promise<void>;
	private close!: () => void;
	constructor() {
		this.closed = new Promise((resolve) => { this.close = resolve; });
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
	private finish(error: Error): void { if (this.exited) return; this.exited = true; const waiter = this.waiter; this.waiter = undefined; waiter?.reject(error); this.close(); }
	request(payload: object, event: HelperReply["event"]): Promise<HelperReply> {
		if (this.exited) return Promise.reject(new Error("macOS VM service is not running"));
		if (this.waiter) return Promise.reject(new Error("macOS VM service already has a control request"));
		return new Promise((resolve, reject) => { this.waiter = { event, resolve, reject }; this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => { if (error) this.finish(error); }); });
	}
	async stop(): Promise<void> { if (!this.exited) { try { await this.request({ command: "stop" }, "stopped"); } finally { this.child.stdin.end(); } } await this.closed; }
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
async function plist<T>(data: string): Promise<T> {
	const result = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], data);
	return JSON.parse(result.stdout) as T;
}
async function patchPolicy(target: BootTarget, vuid: string, lpnh: string, onOutput?: (output: string) => void): Promise<void> {
	const deadline = Date.now() + 300_000;
	for (;;) {
		const mountPoint = mkdtempSync(join(tmpdir(), "pi-localpolicy-"));
		let outer: string | undefined;
		let volume: string | undefined;
		let retryReason: string | undefined;
		try {
			const result = await run("/usr/sbin/diskutil", ["image", "attach", "--plist", "--noMount", target.disk, ...(target.shadow ? ["--shadow", target.shadow] : [])]);
			const entities = (await plist<AttachResult>(result.stdout))["system-entities"] ?? [];
			outer = entities.find((entity) => entity["content-hint"] === "GUID_partition_scheme")?.["dev-entry"];
			if (!outer) throw new Error("Disk image attachment did not return a whole disk");
			const matches: string[] = [];
			for (const entity of entities) {
				const device = entity["dev-entry"];
				if (!device) continue;
				const result = await run("/usr/sbin/diskutil", ["info", "-plist", device]);
				if ((await plist<DiskInfo>(result.stdout)).VolumeName === "iSCPreboot") matches.push(device);
			}
			if (matches.length !== 1) throw new Error(`Disk image attachment returned ${matches.length} iSCPreboot volumes`);
			volume = matches[0]!;
			let mounted: DiskInfo | undefined;
			try {
				await run("/usr/sbin/diskutil", ["mount", "-mountOptions", "rw", "-mountPoint", mountPoint, volume]);
				const mountedInfo = await run("/usr/sbin/diskutil", ["info", "-plist", volume]);
				mounted = await plist<DiskInfo>(mountedInfo.stdout);
			} catch (error) {
				retryReason = error instanceof Error ? error.message : String(error);
			}
			if (mounted && !mounted.MountPoint) retryReason = "iSCPreboot did not remain mounted";
			else if (mounted && mounted.WritableVolume !== true) retryReason = "iSCPreboot mounted read-only";
			else if (mounted?.MountPoint) {
				const directory = join(mounted.MountPoint, vuid, "LocalPolicy");
				const files = readdirSync(directory);
				const main = files.filter((file) => file.endsWith(".img4") && !file.endsWith(".recovery.img4"));
				const recovery = files.filter((file) => file.endsWith(".recovery.img4"));
				if (main.length !== 1 || recovery.length !== 1) throw new Error(`Expected one main and recovery LocalPolicy; found ${main.length} and ${recovery.length}`);
				await run("/usr/bin/ruby", [localPolicyHelper, join(directory, main[0]!), join(directory, recovery[0]!), vuid, lpnh]);
				await run("/usr/sbin/diskutil", ["unmount", volume]); volume = undefined;
				await run("/usr/sbin/diskutil", ["eject", outer]); outer = undefined;
				return;
			}
		} finally {
			if (volume) await run("/usr/sbin/diskutil", ["unmount", volume]).catch(() => undefined);
			if (outer) await run("/usr/sbin/diskutil", ["eject", outer]).catch(() => undefined);
			rmSync(mountPoint, { recursive: true, force: true });
		}
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for writable iSCPreboot: ${retryReason ?? "unknown mount failure"}`);
		onOutput?.(`${retryReason ?? "Could not mount iSCPreboot writable"}; retrying\n`);
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}
async function runBputil(config: SshTargetConfig, sip: SipState): Promise<{ vuid: string; lpnh: string }> {
	const flags = sip === "disabled" ? "-l -n -c -a" : "-l -f";
	const changed = await runSshBytes(config, `/usr/bin/sudo -S -p '' /usr/bin/bputil ${flags} -u pi -p ${GUEST_PASSWORD}`, { stdin: `${GUEST_PASSWORD}\n`, timeoutMs: 360_000 });
	if (changed.exitCode !== 0) throw new Error((changed.stderr.toString() || changed.stdout.toString()).trim());
	const displayed = await runSshBytes(config, "/usr/bin/sudo -S -p '' /usr/bin/bputil -l -d -j", { stdin: `${GUEST_PASSWORD}\n`, timeoutMs: 120_000 });
	const text = displayed.stdout.toString(), start = text.indexOf("{");
	if (displayed.exitCode !== 0 || start < 0) throw new Error((displayed.stderr.toString() || "bputil validation failed").trim());
	const entries = Object.entries(JSON.parse(text.slice(start)) as Record<string, BputilPolicy>);
	if (entries.length !== 1) throw new Error("bputil returned an invalid policy");
	const [key, policy] = entries[0]!, vuid = key.toUpperCase();
	if (!UUID.test(vuid) || String(policy.vuid ?? "").toUpperCase() !== vuid || policy.properly_paired !== true || policy.os_paired_to_current !== true) throw new Error("bputil returned an invalid policy");
	const lpnh = String(policy.lpnh ?? "").toUpperCase(), rpnh = String(policy.rpnh ?? "").toUpperCase();
	if (!HASH384.test(lpnh) || !HASH384.test(rpnh)) throw new Error("bputil returned invalid policy hashes");
	const generation = policy.stng_exists === true && typeof policy.stng === "number" && Number.isSafeInteger(policy.stng) && policy.stng > 0;
	const disabled = policy.security_mode === "permissive" && policy.smb0 === true && policy.smb1 === true && policy.smb2 === false && policy.sip1 === false && policy.sip2 === true && policy.sip3 === true && generation;
	const enabled = policy.security_mode === "full" && policy.smb0 === false && policy.smb1 === false && policy.smb2 === false && policy.sip1 === false && policy.sip2 === false && policy.sip3 === false;
	if (!(sip === "disabled" ? disabled : enabled) || policy.sip0_exists !== false || policy.sip0 !== 0) throw new Error(`bputil did not produce the expected ${sip} policy`);
	return { vuid, lpnh };
}
async function shutDown(service: MacService, config: SshTargetConfig): Promise<void> {
	await runSshBytes(config, "/usr/bin/sudo -S -p '' /sbin/shutdown -h now", { stdin: `${GUEST_PASSWORD}\n`, timeoutMs: 30_000 }).catch(() => undefined);
	for (let i = 0; i < 180; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		if ((await service.request({ command: "status" }, "status")).state === "stopped") { await service.stop(); return; }
	}
	throw new Error("Timed out waiting for macOS to shut down");
}
async function verifySip(config: SshTargetConfig, sip: SipState): Promise<void> {
	const result = await runSshBytes(config, "/usr/bin/csrutil status");
	if (result.exitCode !== 0 || !result.stdout.toString().includes(`System Integrity Protection status: ${sip}.`)) throw new Error(`macOS reported the wrong SIP state: ${result.stdout.toString().trim()}`);
}

/** Managed local VZ guest. SSH control requires NAT, which also permits guest egress. */
export class MacOSBackend implements TargetBackend {
	readonly kind = "macos" as const;
	readonly transport = "ssh-local" as const;
	// VZNAT is required to reach the guest; it cannot enforce StartOptions.network=false.
	readonly enforces: BackendCapabilities = { isolation: true, mounts: true, network: false };
	private targets = new Map<string, RunningTarget>();
	private endpoints = new Map<string, SshTargetConfig>();
	private services = new Map<string, MacService>();
	private pendingRamMiB = new Map<string, number>();
	private config(id: string): SshTargetConfig { const config = this.endpoints.get(id); if (!config) throw new Error(`No SSH-ready macOS target ${id}`); return config; }
	async createVm(opts: CreateVmOptions = {}): Promise<Vm> {
		// Creation may download/install the base and boot it before start().
		if (opts.network !== true) throw new Error("macOS VM creation requires authorized network access.");
		if (opts.base) throw new Error("macOS VM base/fork creation is not implemented");
		const id = safe(opts.name ?? `scratch-${random()}`);
		const ramMiB = opts.options?.ramMiB;
		if (ramMiB !== undefined && (!Number.isInteger(ramMiB) || ramMiB < 1)) throw new Error("macOS ramMiB must be a positive integer");
		const stage = async (commandName: string, label: string, extra: object = {}) => { opts.onOutput?.(`${label}\n`); return command({ command: commandName, ...extra }); };
		const status = await stage("base-status", "Checking macOS base state");
		if (!status.vms?.some((vm) => vm.id === "base-ready")) {
			await stage("download-ipsw", "Downloading supported macOS IPSW"); await stage("create-base-storage", "Creating macOS base storage"); await stage("install-base", "Installing macOS base");
			await this.provisionBase(opts.onOutput); await stage("mark-base-installed", "Finalizing macOS base");
		}
		const reply = await stage("create-derivative", `Creating macOS VM ${id}`, { id, name: opts.name ? id : undefined });
		if (ramMiB !== undefined) this.pendingRamMiB.set(id, ramMiB);
		return { ...(reply.vm ?? { id, name: opts.name ? id : undefined }), kind: "macos", sip: "enabled" };
	}
	async destroyVm(id: string): Promise<void> { const safeID = safe(id); await this.stop(safeID).catch(() => undefined); await command({ command: "destroy", id: safeID }); this.pendingRamMiB.delete(safeID); this.targets.delete(safeID); this.endpoints.delete(safeID); }
	listVms(): Vm[] { const directory = join(root, "vms"); if (!existsSync(directory)) return []; return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => { try { if (!entry.isDirectory()) return []; const value = metadata(entry.name); return [{ id: value.id, name: value.name, kind: "macos" as const, sip: value.sip }]; } catch { return []; } }); }
	getVm(id: string): Vm | undefined { return this.listVms().find((vm) => vm.id === safe(id)); }
	async start(idValue: string, opts: StartOptions): Promise<RunningTarget> {
		// Fail before adopting a live target or performing private SIP boots.
		if (opts.network !== true) throw new Error("macOS VMs require authorized network access; network isolation is not supported.");
		const id = safe(idValue); const info = metadata(id); const sip = opts.sip ?? info.sip;
		if (this.targets.has(id)) { const target = this.targets.get(id)!; if (target.vm?.sip !== sip) throw new Error(`VM ${id} is already running with SIP ${target.vm?.sip}`); return target; }
		await ensureHelper(); const changed = sip !== info.sip; if (changed) await this.changeSip(vmBoot(info), sip, opts.onOutput); opts.onOutput?.("Starting normal macOS boot\n"); const service = new MacService();
		const mounts = macMounts(id, opts.mounts);
		const ramMiB = this.pendingRamMiB.get(id);
		try { const reply = await service.request({ command: "start", id, mounts, ramMiB }, "started"); this.pendingRamMiB.delete(id); if (!reply.endpoint) throw new Error("macOS VM service did not provide an endpoint"); const config = endpointConfig(id, reply.endpoint); await bootstrapSsh(config); // Do not expose exec until public-key SSH works.
			const probe = await runSshBytes(config, "true"); if (probe.exitCode !== 0) throw new Error((probe.stderr.toString() || "SSH key authentication failed").trim()); await verifySip(config, sip); if (changed) writeSip(id, sip); this.services.set(id, service); this.endpoints.set(id, config); const target: RunningTarget = { id, kind: "macos", vm: { id, name: info.name, kind: "macos", sip }, mounts, network: true, exec: true }; this.targets.set(id, target); return target;
		} catch (error) { await service.stop().catch(() => undefined); throw error; }
	}
	private async changeSip(target: BootTarget, sip: SipState, onOutput?: (output: string) => void): Promise<void> {
		onOutput?.("Starting private macOS boot for SIP provisioning\n");
		await this.privateBoot(target, onOutput, async (config, service) => {
			onOutput?.(`Running bputil to set SIP ${sip}\n`);
			const policy = await runBputil(config, sip);
			onOutput?.("Syncing boot-policy writes and waiting 10 seconds\n");
			const synced = await runSshBytes(config, "/bin/sync && /bin/sleep 10", { timeoutMs: 30_000 });
			if (synced.exitCode !== 0) throw new Error((synced.stderr.toString() || synced.stdout.toString() || "Could not sync boot-policy writes").trim());
			onOutput?.("Shutting down private macOS boot\n"); await shutDown(service, config);
			if (sip === "disabled") { onOutput?.("Updating LocalPolicy\n"); await patchPolicy(target, policy.vuid, policy.lpnh, onOutput); }
		});
	}
	private async privateBoot(target: BootTarget, onOutput: ((output: string) => void) | undefined, body: (config: SshTargetConfig, service: MacService) => Promise<void>): Promise<void> {
		const service = new MacService(); let handled = false;
		try {
			const reply = await service.request({ command: "start", id: target.id, mounts: [], ramMiB: this.pendingRamMiB.get(target.id) }, "started");
			if (!reply.endpoint) throw new Error("Private macOS boot did not provide an endpoint");
			const config = endpointConfig(`${target.id}-provision`, reply.endpoint); await bootstrapSsh(config);
			await body(config, service); handled = true;
		} finally { if (!handled) await service.stop().catch(() => undefined); }
	}
	private async provisionBase(onOutput?: (output: string) => void): Promise<void> {
		const target = baseBoot();
		await this.privateBoot(target, onOutput, async (config, service) => {
			onOutput?.("Provisioning base: passwordless sudo, display sleep and screen saver\n");
			const sudoers = q("printf '%s\\n' 'pi ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/pi && /bin/chmod 0440 /etc/sudoers.d/pi");
			const result = await runSshBytes(config, [
				`printf '%s\\n' ${q(GUEST_PASSWORD)} | /usr/bin/sudo -S -p '' /bin/sh -c ${sudoers}`,
				"/usr/bin/sudo -n /usr/bin/pmset -a displaysleep 0 sleep 0 disablesleep 1",
				"/usr/bin/defaults -currentHost write com.apple.screensaver idleTime -int 0",
				"/usr/bin/sudo -n /usr/bin/defaults write /Library/Preferences/com.apple.screensaver loginWindowIdleTime -int 0",
			].join(" && "), { timeoutMs: 180_000 });
			if (result.exitCode !== 0) throw new Error((result.stderr.toString() || result.stdout.toString() || "Base provisioning failed").trim());
			await shutDown(service, config);
		});
		await this.changeSip(target, "disabled", onOutput);
		await this.privateBoot(target, onOutput, async (config, service) => {
			onOutput?.("Provisioning base: granting screen recording to SSH sessions\n");
			const result = await runSshBytes(config, `/usr/bin/sudo -n /usr/bin/sqlite3 ${q(TCC_DB)} ${q(TCC_INSERT)} && /usr/bin/sudo -n /usr/bin/sqlite3 ${q(TCC_DB)} ${q(TCC_VERIFY)}`, { timeoutMs: 180_000 });
			if (result.exitCode !== 0) throw new Error((result.stderr.toString() || result.stdout.toString() || "Base provisioning failed").trim());
			if (result.stdout.toString().trim() !== "2") throw new Error(`Base provisioning could not grant screen recording (auth_value ${result.stdout.toString().trim() || "missing"})`);
			await shutDown(service, config);
		});
		await this.changeSip(target, "enabled", onOutput);
	}
	async stop(idValue: string): Promise<void> { const id = safe(idValue); const service = this.services.get(id); if (!service) { this.targets.delete(id); this.endpoints.delete(id); return; } try { await service.stop(); } finally { this.services.delete(id); this.targets.delete(id); this.endpoints.delete(id); } }
	running(): RunningTarget[] { return [...this.targets.values()]; }
	fileOperations(id: string): FileOperations { return new SshTransport(this.config(id)); }
	vmExecBytes(id: string, commandText: string, opts: { input?: Buffer; timeoutMs?: number; signal?: AbortSignal } = {}) { return runSshBytes(this.config(id), commandText, { stdin: opts.input, timeoutMs: opts.timeoutMs, signal: opts.signal }).then((result) => { if (result.exitCode !== 0) throw new Error((result.stderr.toString() || result.stdout.toString()).trim()); return result.stdout; }); }
	execStream(id: string, commandText: string, opts: { timeoutMs?: number; cwd?: string; signal?: AbortSignal; onData: (data: Buffer) => void }) { return runSshBytes(this.config(id), opts.cwd ? `cd ${q(opts.cwd)} && ${commandText}` : commandText, { timeoutMs: opts.timeoutMs, signal: opts.signal, onData: opts.onData }).then((result) => ({ exitCode: result.exitCode })); }
	async exec(id: string, commandText: string, opts: { timeoutMs?: number; cwd?: string; onOutput?: (output: { stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean }) => void } = {}): Promise<ExecResult> { const result = await runSshBytes(this.config(id), opts.cwd ? `cd ${q(opts.cwd)} && ${commandText}` : commandText, { timeoutMs: opts.timeoutMs }); return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode ?? 124, timedOut: result.exitCode === null }; }
	isPublished(_id: string): boolean { return false; }
	publish(_id: string, _name: string): string { throw new Error("Publishing macOS VMs is not implemented"); }
}
