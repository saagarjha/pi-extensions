import { isUnder, segments } from "./paths.ts";
import { asksForVerb, matchScope, mountsForScopes, type ExecGrant, type Mount, type Scope, type ScopeMode, type VmScope } from "./policy.ts";

// Compare read and write authority independently: deny < ask < allow.
const authority = {
	deny: [0, 0],
	"ask-ro": [1, 0],
	"ask-rw": [1, 1],
	ro: [2, 0],
	"ro-ask-rw": [2, 1],
	rw: [2, 2],
} as const satisfies Record<ScopeMode, readonly [number, number]>;

function rights(mode: ScopeMode) {
	if (!Object.hasOwn(authority, mode)) throw new Error(`Invalid permission mode: ${mode}`);
	return authority[mode];
}

export function weakerMode(requested: ScopeMode | undefined, parent: ScopeMode): ScopeMode {
	const mode = requested === undefined ? parent : requested;
	const [parentRead, parentWrite] = rights(parent);
	const [read, write] = rights(mode);
	if (read > parentRead || write > parentWrite) {
		throw new Error(`Cannot delegate ${mode} from parent ${parent} permission`);
	}
	return mode;
}

export function intersectModes(a: ScopeMode, b: ScopeMode): ScopeMode {
	const [aRead, aWrite] = rights(a);
	const [bRead, bWrite] = rights(b);
	const read = Math.min(aRead, bRead), write = Math.min(aWrite, bWrite);
	if (read === 0) return "deny";
	if (read === 1) return write === 0 ? "ask-ro" : "ask-rw";
	return write === 0 ? "ro" : write === 1 ? "ro-ask-rw" : "rw";
}

/** Clamp the current selected regions without losing revoked boundaries. */
export function intersectFileScopes(current: Scope[], ceiling: Scope[]): Scope[] {
	const result: Scope[] = [];
	const seen = new Set<string>();
	// Either policy can change at a boundary. Equivalent paths tie in
	// matchScope, so keep their first spelling and evaluate the original lists.
	for (const { path } of [...current, ...ceiling]) {
		const key = segments(path).join("/");
		if (seen.has(key)) continue;
		seen.add(key);
		const currentScope = matchScope(current, path);
		if (!currentScope) continue; // Never select a region outside current.
		const ceilingScope = matchScope(ceiling, path);
		// Keep deny tombstones: a later ceiling expansion must not restore access.
		result.push({ path, mode: intersectModes(currentScope.mode, ceilingScope?.mode ?? "deny") });
	}
	return result;
}

/** Intersect effective exact-command-over-wildcard permissions per target. */
export function intersectExecGrants(current: ExecGrant[], ceiling: ExecGrant[]): ExecGrant[] {
	const result: ExecGrant[] = [];
	for (const target of new Set(current.map((grant) => grant.target))) {
		const currentGrants = current.filter((grant) => grant.target === target);
		const ceilingGrants = ceiling.filter((grant) => grant.target === target);
		const currentWildcard = currentGrants.find((grant) => grant.command === "*");
		const ceilingWildcard = ceilingGrants.find((grant) => grant.command === "*");
		// Include exact exceptions from both sides, even under a wildcard.
		const commands = new Set([...currentGrants, ...ceilingGrants].map((grant) => grant.command));
		for (const command of commands) {
			const currentGrant = currentGrants.find((grant) => grant.command === command) ?? currentWildcard;
			const ceilingGrant = ceilingGrants.find((grant) => grant.command === command) ?? ceilingWildcard;
			// A wildcard survives only if both sides have one; otherwise the
			// available exact commands are the entire remaining selection.
			if (!currentGrant || !ceilingGrant) continue;
			result.push({
				target,
				command,
				mode: currentGrant.mode === "ask" || ceilingGrant.mode === "ask" ? "ask" : "allow",
			});
		}
	}
	return result;
}

/** Scopes include the caller's actual built-ins; no pathname exemptions. */
export function mountsCompatibleWith(scopes: Scope[], mounts: Mount[]): boolean {
	const allowed = mountsForScopes(scopes);
	// A live policy proxy is owned by its controller session, not transferable authority.
	return mounts.every((mount) => !mount.permissionSession && allowed.some((candidate) =>
		isUnder(mount.hostPath, candidate.hostPath) && (mount.mode === "ro" || candidate.mode === "rw")));
}

/** Preserve negative constraints on implicitly readable (published) VM bases. */
export function retainVmConstraints(parent: VmScope[], selected: VmScope[]): VmScope[] {
	// Omitting an ask-only VM must not turn its published base into an
	// unconditionally readable resource. Deny rather than adding an omitted grant.
	return [
		...selected,
		...parent.filter((vm) => (vm.mode === "deny" || asksForVerb(vm.mode, "read"))
			&& !selected.some((grant) => grant.vmId === vm.vmId))
			.map((vm) => ({ vmId: vm.vmId, mode: "deny" as const })),
	];
}

/** Paths must already be canonical. A subset selects grants, not which constraints survive. */
export function reduceFileScopes(parent: Scope[], requested: Array<{ path: string; mode?: ScopeMode }>): Scope[] {
	const seen = new Set<string>();
	const selected = requested.map((request) => {
		if (seen.has(request.path)) throw new Error(`Duplicate delegated file permission: ${request.path}`);
		seen.add(request.path);
		const grant = parent.find((scope) => scope.path === request.path);
		if (!grant) throw new Error(`Cannot delegate file permission the parent does not have exactly: ${request.path}`);
		return { path: grant.path, mode: weakerMode(request.mode, grant.mode) };
	});

	// Effective policy changes only at scope boundaries. Include every parent
	// boundary below a selected grant, then intersect the two policies there.
	// This retains omitted denies/ask/ro exceptions without copying stronger
	// descendant grants into a child that requested a weaker ancestor.
	const boundaries = new Set([
		...selected.map((scope) => scope.path),
		...parent.filter((scope) => selected.some((grant) => isUnder(scope.path, grant.path))).map((scope) => scope.path),
	]);
	return [...boundaries].map((path) => {
		const parentScope = matchScope(parent, path);
		const childScope = matchScope(selected, path);
		if (!parentScope || !childScope) throw new Error(`Missing permission at delegated scope boundary: ${path}`);
		return { path, mode: intersectModes(parentScope.mode, childScope.mode) };
	});
}
