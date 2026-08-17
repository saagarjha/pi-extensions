import type { Mount, RunningTarget, Vm } from "../policy.ts";

/**
 * What a backend can actually enforce.
 *
 * Declared rather than assumed, so a green test suite is never mistaken for a
 * working boundary. The mock declares all false; a real micro-VM backend would
 * declare all true. Anything that depends on a guarantee can check for it.
 */
export type BackendCapabilities = {
	/** Code execution is genuinely isolated from the host. */
	isolation: boolean;
	/** Mounts are kernel-enforced, not simulated in-process. */
	mounts: boolean;
	/** Network access can actually be prevented. */
	network: boolean;
};

export type CreateVmOptions = {
	/** Human-chosen VM id. Omit for a generated scratch id. */
	name?: string;
	/** Base VM/image to fork from. Omit for ubuntu:latest. */
	base?: string;
	network?: boolean;
	/** Receives incremental output/progress while the VM is being created. */
	onOutput?: (output: string) => void;
};

export type StartOptions = {
	/** Bound at start from the scopes current *now*. Derived, never requested. */
	mounts: Mount[];
	network?: boolean;
};

export type ExecResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
};

/**
 * A backend that can hold VMs and run code in them.
 *
 * The split matters: `createVm` produces state and filesystem, `start` binds
 * authorization. A stopped VM carries no mounts, which is why reusing one
 * across chats moves software without moving access.
 */
export interface TargetBackend {
	readonly kind: RunningTarget["kind"];
	readonly enforces: BackendCapabilities;

	createVm(opts?: CreateVmOptions): Promise<Vm>;
	destroyVm(vmId: string): Promise<void>;
	listVms(): Vm[];
	getVm(vmId: string): Vm | undefined;

	start(vmId: string, opts: StartOptions): Promise<RunningTarget>;
	stop(targetId: string): Promise<void>;
	running(): RunningTarget[];

	exec(
		targetId: string,
		command: string,
		opts?: {
			timeoutMs?: number;
			cwd?: string;
			onOutput?: (output: { stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean }) => void;
		},
	): Promise<ExecResult>;

	isPublished(vmId: string): boolean;
	publish(targetId: string, name: string): string;
}
