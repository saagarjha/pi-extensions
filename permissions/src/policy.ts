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

export type Mount = { hostPath: string; guestPath: string; mode: "ro" | "rw" };

/**
 * A VM is state and filesystem. Nothing else.
 *
 * It does not record mounts, network, or any other authorization. Those belong
 * to a run. This is what makes reusing a VM across chats safe: it carries
 * software forward, never access.
 */
export type Vm = {
	id: string;
	/** Set when the user named it. Presence signals intent to reuse. */
	name?: string;
};

/**
 * A place tools can run, for the duration of one run.
 *
 * Mounts are bound at start from whatever scopes are current then, so a stopped
 * VM holds no authorization at all.
 */
export type RunningTarget = {
	/** The handle the api hands back and the agent passes to tools. */
	id: string;
	kind: "local" | "mock" | "docker" | "ssh";
	/** Null for the local/ssh target; otherwise the VM backing this run. */
	vm: Vm | null;
	mounts: Mount[];
	network: boolean;
	/** Whether this target can technically execute commands. Authorization is separate. */
	exec: boolean;
};

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
	const readable = grants.some((g) => canReadMode(g.mode));
	const writable = grants.some((g) => canWriteMode(g.mode));
	if (readable) verbs.push(...READ_VERBS);
	if (writable) verbs.push(...WRITE_VERBS);
	if (state.targets.some((t) => t.exec && (t.kind === "docker" || state.execGrants.some((g) => g.target === t.id)))) verbs.push("bash");
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
		hostPath: `/${[...segments(best.hostPath), ...rest].join("/")}`,
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
		return target.exec ? { allow: true, hostPath: null } : deny(state, req, "VERB_NOT_GRANTED");
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

/**
 * Mounts for a run, derived from the scopes current at start.
 *
 * Derived, never requested: there is no path by which the agent can ask for a
 * writable mount of a read-only scope. `deny` scopes simply do not project.
 */
export function mountsForScopes(scopes: Scope[], guestRoot = "/mnt"): Mount[] {
	return scopes
		// A VM mount cannot ask per filesystem access. Project ask scopes only at
		// their non-interactive lower bound: ask-rw/ro-ask-rw become ro; ask-ro is omitted.
		.filter((s) => s.mode !== "deny" && s.mode !== "ask-ro")
		.map((s) => ({
			hostPath: s.path,
			guestPath: `${guestRoot}/${segments(s.path).join("/")}`,
			mode: s.mode === "rw" ? ("rw" as const) : ("ro" as const),
		}));
}
