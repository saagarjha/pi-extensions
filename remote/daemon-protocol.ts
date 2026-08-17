export interface LaunchProfile {
	agentDir: string;
	executable: string;
	cliPath: string;
	args: string[];
	/** Memory only: never written to disk. */
	env: Record<string, string | undefined>;
}
export type LauncherProfile = LaunchProfile;

export interface DaemonDescriptor {
	protocol: 1;
	instanceId: string;
	pid: number;
	uid: number;
	socketPath: string;
	/** Client API origin; Unix socket is discovery/administration only. */
	origin: string;
	token: string;
}

export interface ManagedRecord {
	ownerId: string;
	status: "launching" | "ready" | "stopped" | "quarantined";
	socketPath: string;
	workerToken: string;
	sessionId?: string;
	sessionFile?: string;
	canonicalFile?: string;
	fileIdentity?: string;
	agentDir: string;
	pid?: number;
}

/** Native picker discovery is scoped to an explicit profile, never a daemon-only catalog. */
export interface DaemonListParams {
	profile: LaunchProfile;
}

/** Paths are discovered by the daemon; callers cannot supply arbitrary history filenames. */
export interface DaemonAttachParams {
	sessionId: string;
	profile?: LaunchProfile;
	fileIdentity?: string;
	control?: boolean;
	ifUnoccupied?: boolean;
	controlIfFree?: boolean;
}

export interface DaemonFrame {
	id: number;
	method: string;
	params?: Record<string, unknown>;
}
