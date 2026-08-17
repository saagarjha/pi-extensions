import type { Mount, RunningTarget, Vm } from "../../targets/index.ts";
export type { Mount, RunningTarget, Vm } from "../../targets/index.ts";
import { depth, isUnder, nfc, segments } from "./paths.ts";

/**
 * The decision core.
 *
 * Deliberately pure: no filesystem access, no I/O, no clock. Every permission
 * question is a function of (scopes, targets, request). That makes it testable
 * as a table, and it means the policy layer physically cannot leak whether a
 * path exists — it never looks.
 */

export type ScopeMode = "deny" | "ask-ro" | "ask-rw" | "ro" | "ro-ask-rw" | "rw";
export type Scope = { path: string; mode: ScopeMode };

export const READ_VERBS = ["read", "grep", "find", "ls"] as const;
export const WRITE_VERBS = ["write", "edit"] as const;

export type ReadVerb = (typeof READ_VERBS)[number];
export type WriteVerb = (typeof WRITE_VERBS)[number];
export type FsVerb = ReadVerb | WriteVerb;
export type Verb = FsVerb | "bash";

export const LOCAL_TARGET = "local";

export function isWriteVerb(v: Verb): v is WriteVerb {
	return (WRITE_VERBS as readonly string[]).includes(v);
}

export function isFsVerb(v: Verb): v is FsVerb {
	return v !== "bash";
}

/**
 * A VM the session is allowed to use.
 *
 * VMs are added exactly like directories are, and for the same reason: a VM has
 * a filesystem that may hold things you would not hand over by default. A VM
 * the agent created itself this session is granted implicitly — it is empty and
 * the agent made it. Anything pre-existing, especially a named base image built
 * in another chat, has to be added by you.
 */
export type VmScope = { vmId: string; mode: ScopeMode; network?: boolean };

export type ExecGrant = { target: string; command: string; mode: "ask" | "allow" };

export type SshTarget = { id: string; destination: string; port?: number };

export type State = {
	scopes: Scope[];
	vms: VmScope[];
	execGrants: ExecGrant[];
	sshTargets: SshTarget[];
	network?: "deny" | "ask" | "allow";
	targets: RunningTarget[];
};

export type DenyReason =
	| "NO_TARGET"
	| "VERB_NOT_GRANTED"
	| "OUT_OF_SCOPE"
	| "DENIED_PATH"
	| "READ_ONLY";

export type Denial = {
	verb: Verb;
	target: string;
	path?: string;
	reason: DenyReason;
	/** What *is* possible. This is the field that turns a refusal into a route. */
	available: { targets: string[]; scopes: Scope[]; vms: VmScope[]; verbs: Verb[] };
};

export type Decision =
	| { allow: true; hostPath: string | null }
	| { allow: false; denial: Denial };

export const emptyState = (): State => ({ scopes: [], vms: [], execGrants: [], sshTargets: [], network: "deny", targets: [] });

export function canReadMode(mode: ScopeMode): boolean {
	return mode === "ro" || mode === "rw" || mode === "ask-ro" || mode === "ask-rw" || mode === "ro-ask-rw";
}

export function canWriteMode(mode: ScopeMode): boolean {
	return mode === "rw" || mode === "ask-rw" || mode === "ro-ask-rw";
}

export function isAskMode(mode: ScopeMode): boolean {
	return mode === "ask-ro" || mode === "ask-rw" || mode === "ro-ask-rw";
}

export function asksForVerb(mode: ScopeMode, verb: Verb): boolean {
	if (mode === "ask-ro" || mode === "ask-rw") return true;
	return mode === "ro-ask-rw" && isWriteVerb(verb);
}

/** The grant covering a VM's own filesystem, if the session has one. */
export function vmScope(state: State, vmId: string | undefined): VmScope | undefined {
	if (vmId === undefined) return undefined;
	return state.vms.find((v) => v.vmId === vmId);
}

/**
 * Verbs are derived from what has been added rather than granted separately:
 * there is no useful directory that is readable but not greppable. Adding a
 * readable directory — or a readable VM — is what makes the read tools exist.
 */
export function availableVerbs(state: State): Verb[] {
	const verbs: Verb[] = [];
	const grants = [...state.scopes, ...state.vms];
	const sshFiles = (state.network === "allow" || state.network === "ask") && state.targets.some(target =>
		target.kind === "remote" && target.exec && state.sshTargets.some(config => config.id === target.id)
		&& state.execGrants.some(grant => grant.target === target.id && grant.command === "*"));
	const readable = sshFiles || grants.some((g) => canReadMode(g.mode));
	const writable = sshFiles || grants.some((g) => canWriteMode(g.mode));
	if (readable) verbs.push(...READ_VERBS);
	if (writable) verbs.push(...WRITE_VERBS);
	if (state.targets.some((t) => {
		if (!t.exec) return false;
		if (t.kind === "linux" || t.kind === "macos") return canWriteMode(vmScope(state, t.vm?.id)?.mode ?? "deny");
		return state.execGrants.some((g) => g.target === t.id);
	})) verbs.push("bash");
	return verbs;
}

/** Most specific scope wins, so a deep `deny` can carve a hole in a shallow `ro`. */
export function matchScope(scopes: Scope[], hostPath: string): Scope | undefined {
	let best: Scope | undefined;
	for (const s of scopes) {
		if (!isUnder(hostPath, s.path)) continue;
		if (!best || depth(s.path) > depth(best.path)) best = s;
	}
	return best;
}

type Translation = { hostPath: string; mountMode: Mount["mode"] | null } | null;

/**
 * Map a path in target space to a host path.
 *
 * Returns null when the path is on the target's own filesystem rather than
 * inside a projected mount.
 */
export function translate(target: RunningTarget, targetPath: string): Translation {
	if (target.kind === "local") {
		return { hostPath: nfc(targetPath), mountMode: null };
	}
	let best: Mount | undefined;
	for (const m of target.mounts) {
		if (!isUnder(targetPath, m.guestPath)) continue;
		if (!best || depth(m.guestPath) > depth(best.guestPath)) best = m;
	}
	if (!best) return null;
	const rest = segments(targetPath).slice(depth(best.guestPath));
	return {
		hostPath: `/${[...segments(best.logicalHostPath ?? best.hostPath), ...rest].join("/")}`,
		mountMode: best.mode,
	};
}

export type Request = { verb: Verb; target: string; path?: string };

function deny(state: State, req: Request, reason: DenyReason): Decision {
	return {
		allow: false,
		denial: {
			verb: req.verb,
			target: req.target,
			path: req.path,
			reason,
			available: {
				targets: state.targets.map((t) => t.id),
				scopes: state.scopes,
				vms: state.vms,
				verbs: availableVerbs(state),
			},
		},
	};
}

export function decide(state: State, req: Request): Decision {
	const target = state.targets.find((t) => t.id === req.target);
	if (!target) return deny(state, req, "NO_TARGET");

	if (req.verb === "bash") {
		if (!target.exec) return deny(state, req, "VERB_NOT_GRANTED");
		if (target.kind === "linux" || target.kind === "macos") {
			const grant = vmScope(state, target.vm?.id);
			if (!grant || grant.mode === "deny") return deny(state, req, "OUT_OF_SCOPE");
			if (!canWriteMode(grant.mode)) return deny(state, req, "READ_ONLY");
		}
		// Command-specific exec grants and any approvals are checked by guardBash().
		return { allow: true, hostPath: null };
	}

	if (!availableVerbs(state).includes(req.verb)) {
		return deny(state, req, "VERB_NOT_GRANTED");
	}

	if (req.path === undefined) return deny(state, req, "OUT_OF_SCOPE");

	const t = translate(target, req.path);

	// Outside any mount: the VM's own filesystem, which is itself a granted
	// resource. A scratch VM the agent created is granted implicitly and owns
	// its disk completely; a pre-existing VM added by the user is governed by
	// the mode they added it with.
	if (t === null) {
		const g = vmScope(state, target.vm?.id);
		if (!g || g.mode === "deny") return deny(state, req, "OUT_OF_SCOPE");
		if (isWriteVerb(req.verb) && !canWriteMode(g.mode)) return deny(state, req, "READ_ONLY");
		return { allow: true, hostPath: null };
	}

	const scope = matchScope(state.scopes, t.hostPath);
	if (!scope) return deny(state, req, "OUT_OF_SCOPE");
	if (scope.mode === "deny") return deny(state, req, "DENIED_PATH");

	if (isWriteVerb(req.verb)) {
		if (!canWriteMode(scope.mode)) return deny(state, req, "READ_ONLY");
		if (t.mountMode === "ro") return deny(state, req, "READ_ONLY");
	}

	return { allow: true, hostPath: t.hostPath };
}

/** A mount cannot prompt: expose only access that needs no approval. */
function unconditionalMountMode(mode: ScopeMode): Mount["mode"] | undefined {
	if (mode === "rw") return "rw";
	if (mode === "ro" || mode === "ro-ask-rw") return "ro";
	return undefined;
}

/**
 * Mounts for a run, derived from the scopes current at start.
 *
 * Every mount must be safe independently: a child overlay cannot restrict a
 * separately reachable ancestor share (as exposed on macOS). Omit ancestors
 * containing read restrictions; downgrade them to ro for write restrictions.
 * Explicitly allowed descendants still project independently, including rw
 * scratch directories below ro parents or re-grants below denied parents.
 */
export function mountsForScopes(scopes: Scope[], guestRoot = "/mnt"): Mount[] {
	// Equivalent paths tie in matchScope, where the first scope wins. Ignore
	// later entries before considering restrictions or projecting any mounts.
	const seen = new Set<string>();
	const effectiveScopes = scopes.filter((scope) => {
		const key = segments(scope.path).join("/");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	const mounts: Mount[] = [];
	for (const scope of effectiveScopes) {
		let mode = unconditionalMountMode(scope.mode);
		if (mode === undefined) continue;
		// Check every depth, not just immediate children: a deeper re-grant
		// does not remove restrictions on the intervening scope's own path.
		for (const descendant of effectiveScopes) {
			if (!isUnder(descendant.path, scope.path)) continue;
			const descendantMode = unconditionalMountMode(descendant.mode);
			if (descendantMode === undefined) {
				mode = undefined;
				break;
			}
			if (descendantMode === "ro") mode = "ro";
		}
		if (mode === undefined) continue;
		mounts.push({
			hostPath: scope.path,
			guestPath: `${guestRoot}/${segments(scope.path).join("/")}`,
			mode,
		});
	}
	return mounts;
}
