import { intersectExecGrants, intersectFileScopes, intersectModes, mountsCompatibleWith } from "./delegation.ts";
import { asksForVerb, LOCAL_TARGET, type Scope, type ScopeMode, type State } from "./policy.ts";

export type PermissionsSnapshot = Pick<State, "scopes" | "vms" | "execGrants" | "sshTargets" | "network" | "targets">;
export type PermissionSubset = {
	files?: Array<{ path: string; mode?: ScopeMode }>;
	vms?: Array<{ vmId: string; mode?: ScopeMode; network?: boolean }>;
	exec?: Array<{ target: string; command: string; mode?: "ask" | "allow" }>;
	network?: "inherit" | "deny" | "ask" | "allow";
};

export interface PermissionInstance {
	getSnapshot(): PermissionsSnapshot;
	getDelegationSnapshot(): PermissionsSnapshot;
	getRevision(): number;
	getParentSessionId(): string | undefined;
	subscribe(listener: () => void): () => void;
	inheritFrom(parentSessionId: string, snapshot: PermissionsSnapshot): void;
	reduceSnapshot(subset?: PermissionSubset): PermissionsSnapshot;
	dispose(): void;
}

type PermissionsBridge = { instances: Map<string, PermissionInstance> };
export function permissionsBridge(): PermissionsBridge {
	const global = globalThis as typeof globalThis & { __piPermissionsBridge?: PermissionsBridge };
	return global.__piPermissionsBridge ??= { instances: new Map() };
}

export function clonePermissionsSnapshot(snapshot: PermissionsSnapshot): PermissionsSnapshot {
	return {
		scopes: snapshot.scopes.map((scope) => ({ ...scope })),
		vms: snapshot.vms.map((vm) => ({ ...vm })),
		execGrants: snapshot.execGrants.map((grant) => ({ ...grant })),
		sshTargets: snapshot.sshTargets.map((ssh) => ({ ...ssh })),
		network: snapshot.network,
		targets: snapshot.targets.map((target) => ({ ...target, vm: target.vm ? { ...target.vm } : null, mounts: target.mounts.map((mount) => ({ ...mount })) })),
	};
}

const emptySnapshot = (): PermissionsSnapshot => ({ scopes: [], vms: [], execGrants: [], sshTargets: [], network: "deny", targets: [] });
export const execGrantKey = (target: string, command: string): string => JSON.stringify([target, command]);
type LocalKind = "scope" | "vm" | "vmNetwork" | "exec" | "ssh" | "target";
type LocalOrigins = Record<LocalKind, Set<string>> & { network: boolean };
const localOrigins = (): LocalOrigins => ({ scope: new Set(), vm: new Set(), vmNetwork: new Set(), exec: new Set(), ssh: new Set(), target: new Set([LOCAL_TARGET]), network: false });
const localKinds: LocalKind[] = ["scope", "vm", "vmNetwork", "exec", "ssh", "target"];
export type DelegationState = { parentSessionId: string; local: Record<LocalKind, string[]> & { network: boolean } };

export function parseDelegationState(value: unknown): DelegationState | undefined {
	if (value === undefined) return undefined;
	const saved = value as DelegationState | null;
	if (!saved || typeof saved.parentSessionId !== "string" || !saved.parentSessionId || !saved.local
		|| typeof saved.local.network !== "boolean" || localKinds.some((kind) => !Array.isArray(saved.local[kind]) || !saved.local[kind].every((key) => typeof key === "string"))) {
		throw new Error("Invalid delegated permission provenance.");
	}
	return saved;
}

function intersectNetwork(a: State["network"], b: State["network"]): State["network"] {
	if (a === "deny" || a === undefined || b === "deny" || b === undefined) return "deny";
	return a === "ask" || b === "ask" ? "ask" : "allow";
}

/** A session owns its state; inherited authority is a revocable lease on its parent. */
export class PermissionController implements PermissionInstance {
	private revision = 0;
	private fingerprint: string;
	private parentId: string | undefined;
	private parent: PermissionInstance | undefined;
	private parentRevision: number | undefined;
	private unsubscribeParent: (() => void) | undefined;
	private local = localOrigins();
	private readonly listeners = new Set<() => void>();
	private refreshing = false;
	private notifying = false;
	private disposed = false;

	constructor(
		readonly sessionId: string,
		private readonly state: State,
		private readonly builtInScopes: Scope[],
		private readonly reduce: (subset?: PermissionSubset) => PermissionsSnapshot,
		private readonly onChanged: () => void,
		delegation?: DelegationState,
	) {
		this.fingerprint = JSON.stringify(state);
		if (delegation) {
			this.parentId = delegation.parentSessionId;
			for (const kind of localKinds) this.local[kind] = new Set(delegation.local[kind]);
			this.local.target.add(LOCAL_TARGET);
			this.local.network = delegation.local.network;
			// Persisted inherited grants are already denied. An explicit update
			// must reconnect/renew the lease; only independent local grants survive.
		}
	}

	getParentSessionId(): string | undefined { return this.parentId; }
	getRevision(): number { this.changed(); return this.revision; }
	getSnapshot(): PermissionsSnapshot { this.changed(); return clonePermissionsSnapshot(this.state); }
	getDelegationSnapshot(): PermissionsSnapshot {
		const snapshot = this.getSnapshot();
		snapshot.scopes.push(...this.builtInScopes.map((scope) => ({ ...scope })));
		return snapshot;
	}
	reduceSnapshot(subset?: PermissionSubset): PermissionsSnapshot { this.changed(); return this.reduce(subset); }
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Only explicit human grants and newly created resources become session-local. */
	markLocal(kind: LocalKind, key: string): void { if (this.parentId !== undefined) this.local[kind].add(key); }
	forgetLocal(kind: LocalKind, key: string): void { this.local[kind].delete(key); }
	markLocalNetwork(): void { if (this.parentId !== undefined) this.local.network = true; }

	inheritFrom(parentSessionId: string, snapshot: PermissionsSnapshot): void {
		const registry = permissionsBridge().instances;
		const parent = registry.get(parentSessionId);
		if (!parent?.subscribe || !parent.getRevision || !parent.getDelegationSnapshot || !parent.getParentSessionId) {
			throw new Error("Permission inheritance failed closed: parent does not support live revocation. Reload the extensions.");
		}
		const visited = new Set([this.sessionId]);
		for (let id: string | undefined = parentSessionId; id !== undefined; id = registry.get(id)?.getParentSessionId()) {
			if (visited.has(id)) throw new Error("Permission inheritance cannot contain a cycle.");
			visited.add(id);
		}
		// Explicit update_subagent may renew inherited authority. It must not
		// discard scratch resources or independent human grants made in the child.
		const renewed = this.selectUsableTargets(this.withLocalPermissions(clonePermissionsSnapshot(snapshot)));
		this.unsubscribeParent?.();
		this.parentId = parentSessionId;
		this.parent = parent;
		this.parentRevision = undefined;
		this.unsubscribeParent = parent.subscribe(() => this.changed());
		const revision = this.revision;
		this.assign(renewed);
		this.changed(true);
		// Binding itself changes durable provenance, even with an empty grant set.
		if (this.revision === revision) this.onChanged();
	}

	/** Called after mutations and before admission. Parent revisions are checked lazily too. */
	changed(forceRefresh = false): void {
		if (this.disposed) throw new Error("Permission session is closed.");
		if (this.refreshing) return; // A parent notification can re-enter its current reader.
		this.refreshing = true;
		try {
			if (this.parentId !== undefined) {
				const parent = permissionsBridge().instances.get(this.parentId);
				// Replacing a bridge under the same session ID is not automatic renewal.
				const connected = parent === this.parent && parent !== undefined;
				const revision = connected ? parent.getRevision() : undefined;
				if (forceRefresh || revision !== this.parentRevision || !connected || JSON.stringify(this.state) !== this.fingerprint) {
					const ceiling = connected ? parent.getDelegationSnapshot() : emptySnapshot();
					this.assign(this.clamp(ceiling));
					this.parentRevision = revision;
				}
			}
		} finally {
			this.refreshing = false;
		}
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
					for (const listener of [...this.listeners]) {
						// One failed observer must not prevent revocation in its siblings.
						// Its next operation still has to refresh before being admitted.
						try { listener(); } catch {}
					}
				} finally { this.notifying = false; }
			}
		}
	}

	private assign(snapshot: PermissionsSnapshot): void {
		this.state.scopes = snapshot.scopes;
		this.state.vms = snapshot.vms;
		this.state.execGrants = snapshot.execGrants;
		this.state.sshTargets = snapshot.sshTargets;
		this.state.network = snapshot.network;
		this.state.targets = snapshot.targets;
	}

	private clamp(ceiling: PermissionsSnapshot): PermissionsSnapshot {
		const current = this.state;
		const inheritedScopes = current.scopes.filter((scope) => !this.local.scope.has(scope.path));
		const inheritedExec = current.execGrants.filter((grant) => !this.local.exec.has(execGrantKey(grant.target, grant.command)));
		const vms = current.vms.map((vm) => {
			const limit = ceiling.vms.find((candidate) => candidate.vmId === vm.vmId);
			return {
				vmId: vm.vmId,
				mode: this.local.vm.has(vm.vmId) ? vm.mode : intersectModes(vm.mode, limit?.mode ?? "deny"),
				network: this.local.vmNetwork.has(vm.vmId) ? vm.network
					: Boolean(vm.network && (limit?.network || ceiling.network === "allow")),
			};
		});
		// Published bases have implicit read authority. Preserve newly imposed
		// parent restrictions even when the child had no explicit grant for them.
		for (const vm of ceiling.vms) {
			if (!vms.some((candidate) => candidate.vmId === vm.vmId) && (vm.mode === "deny" || asksForVerb(vm.mode, "read"))) {
				vms.push({ vmId: vm.vmId, mode: "deny", network: false });
			}
		}
		const sshTargets = current.sshTargets.filter((ssh) => this.local.ssh.has(ssh.id) || ceiling.sshTargets.some((limit) =>
			limit.id === ssh.id && limit.destination === ssh.destination && limit.port === ssh.port));
		return this.selectUsableTargets(this.keepCurrentRestrictions(this.withLocalPermissions({
			scopes: intersectFileScopes(inheritedScopes, ceiling.scopes),
			vms,
			execGrants: intersectExecGrants(inheritedExec, ceiling.execGrants),
			sshTargets,
			network: intersectNetwork(current.network, ceiling.network),
			targets: current.targets.filter((target) => (this.local.target.has(target.id) || ceiling.targets.some((limit) => limit.id === target.id))
				&& (target.kind !== "remote" || sshTargets.some((ssh) => ssh.id === target.id))),
		})));
	}

	private selectUsableTargets(snapshot: PermissionsSnapshot): PermissionsSnapshot {
		const scopes = [...snapshot.scopes, ...this.builtInScopes];
		return {
			...snapshot,
			// A parent's session mounts are not implicitly shared with its child.
			// Preserve owned runtime records for cleanup; operation guards still
			// reject their use if a subsequent revocation makes mounts incompatible.
			targets: snapshot.targets.filter((target) => this.local.target.has(target.id) || mountsCompatibleWith(scopes, target.mounts)),
		};
	}

	private keepCurrentRestrictions(snapshot: PermissionsSnapshot): PermissionsSnapshot {
		// Source-key filtering alone is insufficient: a new inherited descendant
		// can override a local deny, or removing an exact ask can expose a local
		// allow wildcard. Bound the assembled policy, not just its inherited part.
		return {
			...snapshot,
			scopes: intersectFileScopes(snapshot.scopes, this.state.scopes),
			execGrants: intersectExecGrants(snapshot.execGrants, this.state.execGrants),
		};
	}

	private withLocalPermissions(inherited: PermissionsSnapshot): PermissionsSnapshot {
		const current = this.state;
		const ownScopes = current.scopes.filter((scope) => this.local.scope.has(scope.path));
		const ownExec = current.execGrants.filter((grant) => this.local.exec.has(execGrantKey(grant.target, grant.command)));
		const ownSsh = current.sshTargets.filter((ssh) => this.local.ssh.has(ssh.id));
		const ownTargets = current.targets.filter((target) => this.local.target.has(target.id));
		const vms = inherited.vms.map((vm) => ({ ...vm }));
		for (const vm of current.vms) {
			if (!this.local.vm.has(vm.vmId) && !this.local.vmNetwork.has(vm.vmId)) continue;
			let merged = vms.find((candidate) => candidate.vmId === vm.vmId);
			if (!merged) { merged = { vmId: vm.vmId, mode: "deny" }; vms.push(merged); }
			if (this.local.vm.has(vm.vmId)) merged.mode = vm.mode;
			if (this.local.vmNetwork.has(vm.vmId)) merged.network = vm.network;
		}
		return {
			scopes: [...ownScopes, ...inherited.scopes.filter((scope) => !this.local.scope.has(scope.path))],
			vms,
			execGrants: [...ownExec, ...inherited.execGrants.filter((grant) => !this.local.exec.has(execGrantKey(grant.target, grant.command)))],
			sshTargets: [...ownSsh, ...inherited.sshTargets.filter((ssh) => !this.local.ssh.has(ssh.id))],
			network: this.local.network ? current.network : inherited.network,
			targets: [...ownTargets, ...inherited.targets.filter((target) => !this.local.target.has(target.id))],
		};
	}

	getDelegationState(): DelegationState | undefined {
		if (this.parentId === undefined) return undefined;
		return {
			parentSessionId: this.parentId,
			local: {
				scope: [...this.local.scope], vm: [...this.local.vm], vmNetwork: [...this.local.vmNetwork],
				exec: [...this.local.exec], ssh: [...this.local.ssh], target: [...this.local.target], network: this.local.network,
			},
		};
	}

	/** A delegated lease must not become an independent durable grant on resume. */
	getPersistableSnapshot(): PermissionsSnapshot {
		if (this.parentId === undefined) return clonePermissionsSnapshot(this.state);
		return this.keepCurrentRestrictions(this.withLocalPermissions({
			...emptySnapshot(),
			scopes: this.state.scopes.filter((scope) => !this.local.scope.has(scope.path)).map((scope) => ({ path: scope.path, mode: "deny" })),
			vms: this.state.vms.filter((vm) => !this.local.vm.has(vm.vmId)).map((vm) => ({ vmId: vm.vmId, mode: "deny" })),
		}));
	}

	dispose(): void {
		if (this.disposed) return;
		this.unsubscribeParent?.();
		this.unsubscribeParent = undefined;
		this.disposed = true;
		if (permissionsBridge().instances.get(this.sessionId) === this) permissionsBridge().instances.delete(this.sessionId);
		// Dependents now see a missing parent and discard inherited authority.
		for (const listener of [...this.listeners]) { try { listener(); } catch {} }
		this.listeners.clear();
	}
}
