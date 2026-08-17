import type { BackendCapabilities } from "../api.ts";
import type { FileOperations, FileProgress, FileStat } from "../files.ts";
import { SshTransport, type SshTargetConfig } from "../transports/ssh.ts";
/** Configured external SSH target. It intentionally does not claim local guarantees. */
export class RemoteBackend implements FileOperations {
 readonly kind = "remote" as const;
 readonly enforces: BackendCapabilities = { isolation: false, mounts: false, network: false };
 readonly transport: SshTransport;
 constructor(readonly config: SshTargetConfig) { this.transport = new SshTransport(config); }
 searchPlan(path: string) { return this.transport.searchPlan(path); }
 async exists(path: string, signal?: AbortSignal) { return this.transport.exists(path, signal); }
 size(path: string, signal?: AbortSignal) { return this.transport.size(path, signal); }
 stat(path: string, signal?: AbortSignal) { return this.transport.stat(path, signal); }
 lstat(path: string, signal?: AbortSignal): Promise<FileStat> { return this.transport.lstat(path, signal); }
 mkdir(path: string, signal?: AbortSignal): Promise<void> { return this.transport.mkdir(path, signal); }
 readdir(path: string, signal?: AbortSignal) { return this.transport.readdir(path, signal); }
 openRead(path: string, signal?: AbortSignal) { return this.transport.openRead(path, signal); }
 write(path: string, chunks: AsyncIterable<Buffer>, signal?: AbortSignal, onProgress?: FileProgress) { return this.transport.write(path, chunks, signal, onProgress); }
}
