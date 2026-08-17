import { LinuxBackend } from "./backends/linux.ts";
import { MacOSBackend } from "./backends/macos.ts";
import type { RunningTarget } from "./api.ts";

/**
 * Process-local owner of managed target connectivity and lifecycle state.
 *
 * A Pi subagent creates a separate extension/session instance, but it is still
 * in this process. Managed targets must therefore not be owned by an individual
 * TargetManager: doing so gives a child a copied RunningTarget description with
 * no usable macOS service or SSH endpoint. Remote targets are deliberately not
 * kept here; their serializable SSH configuration is restored by each session.
 */
export class TargetRegistry {
	readonly linux = new LinuxBackend();
	readonly macos = new MacOSBackend();

	backendForVm(id: string): LinuxBackend | MacOSBackend | undefined {
		if (this.linux.getVm(id)) return this.linux;
		if (this.macos.getVm(id)) return this.macos;
		return undefined;
	}

	resolveManagedTarget(id: string): RunningTarget | undefined {
		return this.linux.running().find((target) => target.id === id)
			?? this.macos.running().find((target) => target.id === id);
	}
}

/** All extension sessions in this Pi process use the same managed-target owner. */
export function targetRegistry(): TargetRegistry {
	const global = globalThis as typeof globalThis & { __piTargetRegistry?: TargetRegistry };
	global.__piTargetRegistry ??= new TargetRegistry();
	return global.__piTargetRegistry;
}
