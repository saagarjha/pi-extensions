import type { BackendCapabilities } from "../api.ts";
import { runDirectStream, type DirectStreamOptions } from "../transports/direct.ts";
/** Host target provider. Authorization remains in permissions. */
export class LocalBackend {
 readonly kind = "local" as const;
	readonly transport = "direct" as const;
	execStream(command: string, opts: DirectStreamOptions) { return runDirectStream(command, opts); }
 readonly enforces: BackendCapabilities = { isolation: false, mounts: false, network: false };
}
