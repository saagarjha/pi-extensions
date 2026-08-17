import type { BackendCapabilities } from "../api.ts";
import type { SshTargetConfig } from "../transports/ssh.ts";
/** Configured external SSH target. It intentionally does not claim local guarantees. */
export class RemoteBackend {
 readonly kind = "remote" as const;
	readonly transport = "ssh" as const;
 readonly enforces: BackendCapabilities = { isolation: false, mounts: false, network: false };
 constructor(readonly config: SshTargetConfig) {}
}
