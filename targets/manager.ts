import { LinuxBackend } from "./backends/linux.ts";
import { LocalBackend } from "./backends/local.ts";
import { MacOSBackend } from "./backends/macos.ts";
import { RemoteBackend } from "./backends/remote.ts";
import type { CreateVmOptions, RunningTarget, StartOptions, Vm } from "./api.ts";
import { runSshBytes, shellQuote, type SshTargetConfig } from "./transports/ssh.ts";
import { followSshJob, launchSshJob, probeSshTarget, SshJobContinuesError, statusSshJob, stopSshJob, type RemoteSshJob, type RemoteSshStatus } from "./transports/remote-jobs.ts";
export type { RemoteSshJob, RemoteSshStatus, SshTargetConfig }; export { SshJobContinuesError };

/** Facade consumed by permissions; managed-local macOS SSH never becomes a remote target. */
export class TargetManager {
 private readonly linux = new LinuxBackend(); private readonly macos = new MacOSBackend(); private readonly local = new LocalBackend(); private readonly remotes = new Map<string, RemoteBackend>();
 private backend(id: string) { if (this.linux.getVm(id)) return this.linux; return this.macos; }
 localExecStream(command: string, opts: Parameters<LocalBackend["execStream"]>[1]) { return this.local.execStream(command, opts); }
 localTarget(id = "local"): RunningTarget { return { id, kind: "local", vm: null, mounts: [], network: false, exec: true }; }
 configureRemote(config: SshTargetConfig) { this.remotes.set(config.id, new RemoteBackend(config)); } removeRemote(id: string) { this.remotes.delete(id); }
 setRemoteConfigs(configs: Iterable<SshTargetConfig>) { this.remotes.clear(); for (const c of configs) this.configureRemote(c); }
 remoteConfig(id: string) { return this.remotes.get(id)?.config; } remoteTarget(id: string): RunningTarget { return { id, kind: "remote", vm: null, mounts: [], network: false, exec: true }; }
 resolveTarget(id: string): RunningTarget | undefined { if (id === "local") return this.localTarget(id); return this.linux.running().find(t => t.id === id) ?? this.macos.running().find(t => t.id === id) ?? (this.remotes.has(id) ? this.remoteTarget(id) : undefined); }
 async createVm(opts: CreateVmOptions = {}): Promise<Vm> { return opts.os === "macos" ? this.macos.createVm(opts) : this.linux.createVm(opts); }
 destroyVm(id: string) { return this.backend(id).destroyVm(id); }
 listVms(): Vm[] { return [...this.linux.listVms(), ...this.macos.listVms()]; }
 getVm(id: string): Vm | undefined { return this.macos.getVm(id) ?? this.linux.getVm(id); }
 start(id: string, opts: StartOptions) { return this.backend(id).start(id, opts); } stop(id: string) { return this.backend(id).stop(id); }
 isPublished(id: string) { return this.backend(id).isPublished(id); } publish(id: string, name: string) { return this.backend(id).publish(id, name); }
 vmExists(id: string, path: string) { return this.backend(id).vmExists(id, path); } vmReadFile(id: string, path: string) { return this.backend(id).vmReadFile(id, path); } vmWriteFile(id: string, path: string, content: string) { return this.backend(id).vmWriteFile(id, path, content); } vmStat(id: string, path: string) { return this.backend(id).vmStat(id, path); } vmReadDir(id: string, path: string) { return this.backend(id).vmReadDir(id, path); } vmWalk(id: string, path: string, limit: number) { return this.backend(id).vmWalk(id, path, limit); } vmMkdir(id: string, path: string) { return this.backend(id).vmMkdir(id, path); } vmWriteFileBytes(id: string, path: string, content: Buffer) { return this.backend(id).vmWriteFileBytes(id, path, content); } vmExecBytes(id: string, cmd: string, opts?: any) { return this.backend(id).vmExecBytes(id, cmd, opts); } vmGrep(id: string, path: string, pattern: string, limit: number) { return this.backend(id).vmGrep(id, path, pattern, limit); } execStream(id: string, cmd: string, opts: any) { return this.backend(id).execStream(id, cmd, opts); }
 shellQuote(value: string) { return shellQuote(value); } sshBytes(...args: Parameters<typeof runSshBytes>) { return runSshBytes(...args); } probeRemote(...args: Parameters<typeof probeSshTarget>) { return probeSshTarget(...args); } launchRemoteJob(...args: Parameters<typeof launchSshJob>) { return launchSshJob(...args); } followRemoteJob(...args: Parameters<typeof followSshJob>) { return followSshJob(...args); } remoteJobStatus(...args: Parameters<typeof statusSshJob>) { return statusSshJob(...args); } stopRemoteJob(...args: Parameters<typeof stopSshJob>) { return stopSshJob(...args); }
}
