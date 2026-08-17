import type { RunningTarget, Vm } from "../policy.ts";
import type {
	BackendCapabilities,
	CreateVmOptions,
	ExecResult,
	StartOptions,
	TargetBackend,
} from "./types.ts";

/**
 * ============================================================================
 * NOT IMPLEMENTED — there is no target backend.
 * ============================================================================
 *
 * `TargetBackend` (see types.ts) is the real design: a place tools can run,
 * with mounts bound at start from whatever scopes are current then. Nothing
 * implements it yet.
 *
 * A real implementation needs to provide, and actually enforce:
 *
 *   - isolation — code runs somewhere that is not the user's machine
 *   - mounts    — granted directories projected in at their granted mode,
 *                 enforced by the kernel, with `ro` genuinely read-only
 *   - network   — able to be switched off, since read access plus egress is
 *                 exfiltration the user never granted
 *
 * Candidates: a micro-VM (Gondolin, QEMU+KVM/HVF), a container with a real
 * mount namespace, or an SSH host. Whichever it is, it implements this
 * interface and everything above it stays unchanged.
 *
 * Until then every method here throws. This is deliberate: a stub that quietly
 * ran commands on the host would be worse than no backend at all, and a stub
 * that pretended to isolate them would be worse still.
 */

export class NotImplementedError extends Error {
	constructor(what: string) {
		super(
			`${what} is not implemented: there is no target backend. ` +
				"Execution, VMs and mounts require a backend that can actually isolate them.",
		);
		this.name = "NotImplementedError";
	}
}

export class UnimplementedBackend implements TargetBackend {
	readonly kind = "mock" as const;

	/** Nothing is enforced because nothing exists to enforce it. */
	readonly enforces: BackendCapabilities = {
		isolation: false,
		mounts: false,
		network: false,
	};

	readonly canExecute = false;

	// NOT IMPLEMENTED: VM lifecycle.
	async createVm(_opts?: CreateVmOptions): Promise<Vm> {
		throw new NotImplementedError("creating a VM");
	}

	async destroyVm(_vmId: string): Promise<void> {
		throw new NotImplementedError("destroying a VM");
	}

	listVms(): Vm[] {
		return [];
	}

	getVm(_vmId: string): Vm | undefined {
		return undefined;
	}

	// NOT IMPLEMENTED: binding mounts and starting a target.
	async start(_vmId: string, _opts: StartOptions): Promise<RunningTarget> {
		throw new NotImplementedError("starting a target");
	}

	async stop(_targetId: string): Promise<void> {
		throw new NotImplementedError("stopping a target");
	}

	running(): RunningTarget[] {
		return [];
	}

	// NOT IMPLEMENTED: execution. See the header — this must never become a
	// call into child_process on the host.
	async exec(_targetId: string, _command: string, _opts?: unknown): Promise<ExecResult> {
		throw new NotImplementedError("running commands");
	}

	isPublished(_vmId: string): boolean {
		return false;
	}

	publish(_targetId: string, _name: string): string {
		throw new NotImplementedError("publishing a VM");
	}
}
