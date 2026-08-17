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

// Keep locks outside TargetRegistry: an instance created before /reload may still
// own the live backends and need not have any newly added class methods.
function lifecycleLocks(): Map<string, Promise<void>> {
	const global = globalThis as typeof globalThis & { __piTargetLifecycleLocks?: Map<string, Promise<void>> };
	return global.__piTargetLifecycleLocks ??= new Map();
}

function reserveLifecycle(ids: readonly string[], synchronous = false) {
	const pending = lifecycleLocks();
	const keys = [...new Set(ids.map((id) => id.toLowerCase()))];
	if (synchronous) {
		const busy = keys.find((id) => pending.has(id));
		if (busy !== undefined) throw new Error(`VM ${busy} has a lifecycle operation in progress; retry when it finishes`);
	}
	const previous = keys.flatMap((id) => pending.has(id) ? [pending.get(id)!] : []);
	let release!: () => void;
	const done = new Promise<void>((resolve) => { release = resolve; });
	for (const id of keys) pending.set(id, done);
	return { previous, release: () => {
		for (const id of keys) if (pending.get(id) === done) pending.delete(id);
		release();
	} };
}

/** Reserve all affected VM ids together, so multi-VM operations cannot deadlock. */
export function withVmLifecycle<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> {
	const lock = reserveLifecycle(ids);
	return Promise.all(lock.previous).then(operation).finally(lock.release);
}

/** publish remains synchronous; it must refuse rather than race a pending boot/stop. */
export function withVmLifecycleSync<T>(ids: readonly string[], operation: () => T): T {
	const lock = reserveLifecycle(ids, true);
	try { return operation(); } finally { lock.release(); }
}

/** All extension sessions in this Pi process use the same managed-target owner. */
export function targetRegistry(): TargetRegistry {
	const global = globalThis as typeof globalThis & { __piTargetRegistry?: TargetRegistry };
	global.__piTargetRegistry ??= new TargetRegistry();
	return global.__piTargetRegistry;
}
