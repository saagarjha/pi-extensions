import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent, BeforeAgentStartEventResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { State } from "./policy.ts";

export type PermissionsSnapshot = Pick<State, "scopes" | "vms" | "execGrants" | "sshTargets" | "network" | "targets">;
// Schema-specific definitions are erased only at the forwarding registry boundary.
export type PermissionTool = ToolDefinition<any, any>;
export type PermissionCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
export type PermissionNotification = (...args: Parameters<ExtensionAPI["sendMessage"]>) => boolean;
export interface PermissionRuntime {
	executeTool(name: string, args: Parameters<PermissionTool["execute"]>, notify?: PermissionNotification, toolNames?: string[], notifyUi?: ExtensionContext["ui"]["notify"]): ReturnType<PermissionTool["execute"]>;
	executeCommand(name: string, args: string, signal?: AbortSignal, toolNames?: string[]): Promise<void>;
	beforeAgentStart(event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | undefined>;
}
export interface PermissionInstance {
	getSnapshot(): PermissionsSnapshot;
	getRevision(): number;
	subscribe(listener: () => void): () => void;
	getOwner(): PermissionController;
	dispose(): void;
}

type SharedRelationship = { owner: PermissionController };
type PermissionsBridge = { instances: Map<string, PermissionInstance>; shared: Map<string, SharedRelationship> };
export function permissionsBridge(): PermissionsBridge {
	const global = globalThis as typeof globalThis & { __piPermissionsBridge?: PermissionsBridge };
	const bridge = global.__piPermissionsBridge ??= { instances: new Map(), shared: new Map() };
	bridge.shared ??= new Map();
	return bridge;
}

/** Retain through child reload; release only after child shutdown has joined its calls. */
export function stageSharedPermissions(sessionId: string, parentSessionId: string): () => void {
	const bridge = permissionsBridge();
	if (sessionId === parentSessionId || bridge.shared.has(sessionId) || bridge.instances.has(sessionId)) {
		throw new Error("Shared permissions already staged or cyclic.");
	}
	const parent = bridge.instances.get(parentSessionId);
	if (!parent?.getOwner) throw new Error("Shared permission owner unavailable; reload extensions.");
	const entry = { owner: parent.getOwner() };
	bridge.shared.set(sessionId, entry);
	return () => {
		if (bridge.shared.get(sessionId) !== entry) return;
		bridge.instances.get(sessionId)?.dispose();
		bridge.shared.delete(sessionId);
	};
}

/** A distinct alias can be disposed without disposing the owner's resources. */
export function bindSharedPermissions(sessionId: string): PermissionInstance | undefined {
	const entry = permissionsBridge().shared.get(sessionId);
	if (!entry) return undefined;
	let disposed = false;
	const subscriptions = new Set<() => void>();
	const owner = () => {
		if (disposed || permissionsBridge().shared.get(sessionId) !== entry) throw new Error("Shared permission session is closed.");
		return entry.owner.getOwner();
	};
	const alias: PermissionInstance = {
		getOwner: owner,
		getSnapshot: () => owner().getSnapshot(),
		getRevision: () => owner().getRevision(),
		subscribe: (listener) => {
			const unsubscribe = owner().subscribe(listener);
			subscriptions.add(unsubscribe);
			return () => { subscriptions.delete(unsubscribe); unsubscribe(); };
		},
		dispose: () => {
			disposed = true;
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.clear();
			if (permissionsBridge().instances.get(sessionId) === alias) permissionsBridge().instances.delete(sessionId);
		},
	};
	// Install even if the root is gone: admission fails closed, never initializes an independent policy.
	permissionsBridge().instances.get(sessionId)?.dispose();
	permissionsBridge().instances.set(sessionId, alias);
	return alias;
}

export function clonePermissionsSnapshot(snapshot: PermissionsSnapshot): PermissionsSnapshot {
	return {
		scopes: snapshot.scopes.map(scope => ({ ...scope })),
		vms: snapshot.vms.map(vm => ({ ...vm })),
		execGrants: snapshot.execGrants.map(grant => ({ ...grant })),
		sshTargets: snapshot.sshTargets.map(ssh => ({ ...ssh })),
		network: snapshot.network,
		targets: snapshot.targets.map(target => ({
			...target,
			vm: target.vm ? { ...target.vm } : null,
			...(target.hostFilesystem ? { hostFilesystem: { ...target.hostFilesystem } } : {}),
			mounts: target.mounts.map(mount => ({ ...mount })),
		})),
	};
}

/** One root owns live policy, approvals, filesystem, target manager, and jobs. */
export class PermissionController implements PermissionInstance {
	private revision = 0;
	private fingerprint: string;
	private disposed = false;
	private notifying = false;
	private readonly listeners = new Set<() => void>();

	constructor(
		readonly sessionId: string,
		private readonly state: State,
		private readonly onChanged: () => void,
		readonly runtime: PermissionRuntime,
		readonly context: ExtensionContext,
	) {
		this.fingerprint = JSON.stringify(state);
	}

	getOwner(): PermissionController {
		if (this.disposed || permissionsBridge().instances.get(this.sessionId) !== this) throw new Error("Shared permission owner is closed or replaced.");
		return this;
	}
	getRevision(): number { this.getOwner(); this.changed(); return this.revision; }
	getSnapshot(): PermissionsSnapshot { this.getOwner(); this.changed(); return clonePermissionsSnapshot(this.state); }
	getPersistableSnapshot(): PermissionsSnapshot { return clonePermissionsSnapshot(this.state); }
	subscribe(listener: () => void): () => void {
		this.getOwner();
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	changed(): void {
		if (this.disposed) throw new Error("Permission session is closed.");
		const fingerprint = JSON.stringify(this.state);
		if (fingerprint === this.fingerprint) return;
		this.fingerprint = fingerprint;
		this.revision++;
		try {
			this.onChanged();
		} finally {
			if (!this.notifying) {
				this.notifying = true;
				try {
					for (const listener of [...this.listeners]) { try { listener(); } catch {} }
				} finally { this.notifying = false; }
			}
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (permissionsBridge().instances.get(this.sessionId) === this) permissionsBridge().instances.delete(this.sessionId);
		for (const listener of [...this.listeners]) { try { listener(); } catch {} }
		this.listeners.clear();
	}
}
