import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { LocalBackend } from "./backends/local.ts";
import { LocalTargetAccess, SshTargetAccess, VmTargetAccess, type TargetAccess, type TargetAuthority } from "./access.ts";
import { RemoteBackend } from "./backends/remote.ts";
import { targetRegistry, withVmLifecycle, withVmLifecycleSync, type TargetRegistry } from "./registry.ts";
import type { CreateVmOptions, RunningTarget, StartOptions, Vm } from "./api.ts";
import type { FileOperations } from "./files.ts";
import type { CopyEndpoint } from "./copy.ts";
import { runSshBytes, shellQuote, type SshTargetConfig } from "./transports/ssh.ts";
import { followSshJob, launchSshJob, probeSshTarget, SshJobContinuesError, statusSshJob, stopSshJob, type RemoteSshJob, type RemoteSshStatus } from "./transports/remote-jobs.ts";
export type { RemoteSshJob, RemoteSshStatus, SshTargetConfig }; export { SshJobContinuesError };
export type { CopyEndpoint } from "./copy.ts";

type ManagedBackend = TargetRegistry["linux"] | TargetRegistry["macos"];

/** Facade consumed by permissions; managed-local macOS SSH never becomes a remote target. */
export class TargetManager {
 private readonly registry = targetRegistry();
 private readonly linux = this.registry.linux; private readonly macos = this.registry.macos; private readonly local = new LocalBackend(); private readonly remotes = new Map<string, RemoteBackend>();
 // Cleanup owns boots, not VM ids or borrowed targets from another session.
 private readonly ownedBoots = new Map<RunningTarget, ManagedBackend>();
 private readonly pendingLifecycle = new Set<Promise<unknown>>();
 private closing = false;
 private quiescence?: Promise<void>;
 private backend(id: string) { return this.registry.backendForVm(id) ?? this.macos; }
 private mutate<T>(ids: readonly string[], selectBackend: () => ManagedBackend, operation: (backend: ManagedBackend) => Promise<T>): Promise<T> {
  if (this.closing) return Promise.reject(new Error("Target manager is quiescing; VM lifecycle operations are closed"));
  const backend = selectBackend();
  const pending = withVmLifecycle(ids.map((id) => `${backend.kind}:${id}`), () => operation(backend));
  this.pendingLifecycle.add(pending);
  void pending.then(() => this.pendingLifecycle.delete(pending), () => this.pendingLifecycle.delete(pending));
  return pending;
 }
 /** Fence new lifecycle mutations before other session work starts draining. */
 closeAdmission(): void { this.closing = true; }
 /** Close admission, join accepted mutations, then stop only this session's boots. */
 quiesce(): Promise<void> {
  this.closeAdmission();
  if (!this.quiescence) this.quiescence = this.stopOwnedBoots();
  return this.quiescence;
 }
 private async stopOwnedBoots(): Promise<void> {
  await Promise.allSettled([...this.pendingLifecycle]);
  const failures: Error[] = [];
  for (const [target, backend] of this.ownedBoots) {
   try {
    // Check the original backend: the other OS may have a VM with the same id.
    // Bypass public admission, but serialize the identity check with other managers.
    await withVmLifecycle([`${backend.kind}:${target.id}`], async () => {
     if (backend.running().find((current) => current.id === target.id) === target) {
      await backend.stop(target.id);
     }
     this.ownedBoots.delete(target);
    });
   } catch (error) {
    // Retain failed ownership/backend state for an explicit recovery attempt.
    failures.push(new Error(`${backend.kind} VM ${target.id}: ${String(error)}`, { cause: error }));
   }
  }
  if (failures.length) throw new AggregateError(failures, `Failed to quiesce session VMs: ${failures.map((error) => error.message).join("; ")}`);
 }
 localExecStream(command: string, opts: Parameters<LocalBackend["execStream"]>[1]) { return this.local.execStream(command, opts); }
 localTarget(id = "local"): RunningTarget { return { id, kind: "local", vm: null, mounts: [], network: false, exec: true }; }
 configureRemote(config: SshTargetConfig) { this.remotes.set(config.id, new RemoteBackend(config)); } removeRemote(id: string) { this.remotes.delete(id); }
 setRemoteConfigs(configs: Iterable<SshTargetConfig>) { this.remotes.clear(); for (const c of configs) this.configureRemote(c); }
 remoteConfig(id: string) { return this.remotes.get(id)?.config; } remoteTarget(id: string): RunningTarget { return { id, kind: "remote", vm: null, mounts: [], network: false, exec: true }; }
 resolveTarget(id: string): RunningTarget | undefined { if (id === "local") return this.localTarget(id); return this.registry.resolveManagedTarget(id) ?? (this.remotes.has(id) ? this.remoteTarget(id) : undefined); }
 async createVm(opts: CreateVmOptions = {}): Promise<Vm> {
  return this.mutate([...(opts.name ? [opts.name] : []), ...(opts.base ? [opts.base] : [])], () => opts.os === "macos" ? this.macos : this.linux, (backend) => backend.createVm(opts));
 }
 destroyVm(id: string) {
  return this.mutate([id], () => this.backend(id), async (backend) => {
   const target = backend.running().find((current) => current.id === id.toLowerCase());
   await backend.destroyVm(id);
   if (target) this.ownedBoots.delete(target);
  });
 }
 listVms(): Vm[] { return [...this.linux.listVms(), ...this.macos.listVms()]; }
 getVm(id: string): Vm | undefined { return this.macos.getVm(id) ?? this.linux.getVm(id); }
 start(id: string, opts: StartOptions) {
  return this.mutate([id], () => this.backend(id), async (backend) => {
   const previous = backend.running().find((current) => current.id === id.toLowerCase());
   const target = await backend.start(id, opts);
   if (target !== previous) this.ownedBoots.set(target, backend);
   return target;
  });
 }
 stop(id: string) {
  return this.mutate([id], () => this.backend(id), async (backend) => {
   const target = backend.running().find((current) => current.id === id.toLowerCase());
   await backend.stop(id);
   if (target) this.ownedBoots.delete(target);
  });
 }
 isPublished(id: string) { return this.backend(id).isPublished(id); }
 publish(id: string, name: string) {
  if (this.closing) throw new Error("Target manager is quiescing; VM lifecycle operations are closed");
  const backend = this.backend(id);
  return withVmLifecycleSync([id, name].map((value) => `${backend.kind}:${value}`), () => backend.publish(id, name));
 }
 access(id: string, authority: TargetAuthority): TargetAccess {
  authority.current();
  const target = authority.target(id);
  if (!target) throw new Error(`Permission denied: no target named ${id}. Use capabilities for current access.`);
  const Access = target.kind === "local" ? LocalTargetAccess : target.kind === "remote" ? SshTargetAccess : VmTargetAccess;
  return new Access(id, authority, target => this.rawFileOperations(target));
 }
 copyEndpoint(target: RunningTarget): CopyEndpoint {
  return { id: target.id, local: target.kind === "local", spawn: (command, signal) => {
   signal?.throwIfAborted();
   let child: ChildProcessWithoutNullStreams;
   if (target.kind === "local") child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd: "/", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TMPDIR: tmpdir() }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
   else if (target.kind === "remote") {
    const remote = this.remotes.get(target.id);
    if (!remote) throw new Error(`Unknown remote target: ${target.id}`);
    child = remote.spawnCopy(command);
   } else child = this.backend(target.id).spawnCopy(target.id, command);
   const kill = child.kill.bind(child);
   let closed = false;
   child.kill = (signal = "SIGTERM") => {
    if (closed) return false;
    try { if (child.pid) process.kill(-child.pid, signal); } catch {}
    return kill(signal);
   };
   const abort = () => child.kill("SIGKILL");
   child.once("close", () => { closed = true; signal?.removeEventListener("abort", abort); });
   if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
   return child;
  } };
 }
 private rawFileOperations(target: RunningTarget): FileOperations {
  if (target.kind === "remote") { const remote = this.remotes.get(target.id); if (!remote) throw new Error(`Unknown remote target: ${target.id}`); return remote; }
  if (target.kind === "local") return this.local;
  return this.backend(target.id).fileOperations(target.id);
 }
 vmExecBytes(id: string, cmd: string, opts?: any) { return this.backend(id).vmExecBytes(id, cmd, opts); } execStream(id: string, cmd: string, opts: any) { return this.backend(id).execStream(id, cmd, opts); }
 shellQuote(value: string) { return shellQuote(value); } sshBytes(...args: Parameters<typeof runSshBytes>) { return runSshBytes(...args); } probeRemote(config: SshTargetConfig, signal?: AbortSignal) { return probeSshTarget(config, signal); } launchRemoteJob(...args: Parameters<typeof launchSshJob>) { return launchSshJob(...args); } followRemoteJob(...args: Parameters<typeof followSshJob>) { return followSshJob(...args); } remoteJobStatus(...args: Parameters<typeof statusSshJob>) { return statusSshJob(...args); } stopRemoteJob(...args: Parameters<typeof stopSshJob>) { return stopSshJob(...args); }
}
