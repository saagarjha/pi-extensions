import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	BashOperations,
	EditOperations,
	ExtensionAPI,
	ExtensionContext,
	FindOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { AskRequest } from "./ask.ts";
import { checkedNewPath, checkedPath, DeniedError, listDirVerified, mkdirVerified, readFileVerified, walkVerified, writeBufferVerified, writeFileVerified } from "./fsops.ts";
import type { Allow } from "./fsops.ts";
import { isUnder, nfc, resolveReal } from "./paths.ts";
import {
	asksForVerb,
	availableVerbs,
	canReadMode,
	canWriteMode,
	decide,
	isAskMode,
	isWriteVerb,
	LOCAL_TARGET,
	matchScope,
	mountsForScopes,
	translate,
	type Denial,
	type RunningTarget,
	type ScopeMode,
	type SshTarget,
	type State,
	type Verb,
	vmScope,
} from "./policy.ts";
import { TargetManager, SshJobContinuesError, type RemoteSshJob, type SshTargetConfig } from "../../targets/index.ts";
import { describeOp, requiresApproval, type VmOp } from "./vmops.ts";
import { newestFirst, transitionTaskStatus, visibleWindowAroundSelected } from "../../shared/task-lifecycle.ts";

function piPackageRoot(): string | undefined {
	try {
		return dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	} catch {
		return undefined;
	}
}

function realIfExists(path: string): string {
	try {
		return resolveReal(path);
	} catch {
		return nfc(path);
	}
}

function piDocsReadRoots(): string[] {
	const root = piPackageRoot();
	return root ? [join(root, "README.md"), join(root, "docs"), join(root, "examples")].map(realIfExists) : [];
}

let systemScopes: { path: string; mode: ScopeMode; label: string }[] = piDocsReadRoots().map((path) => ({ path, mode: "ro", label: "pi docs" }));

function sessionSystemRoot(ctx: ExtensionContext): string {
	return join(tmpdir(), "pi-session-system", ctx.sessionManager.getSessionId());
}

function sessionTranscriptPath(ctx: ExtensionContext): string {
	return join(sessionSystemRoot(ctx), "transcripts", "current.jsonl");
}

function refreshSessionSystemPaths(ctx: ExtensionContext): void {
	const root = sessionSystemRoot(ctx);
	const scratch = join(root, "scratch");
	const transcripts = join(root, "transcripts");
	mkdirSync(scratch, { recursive: true });
	mkdirSync(transcripts, { recursive: true });
	writeFileSync(join(root, "README.md"), [
		"# Pi session system directory",
		"",
		"scratch/ is a session-local writable workspace for temporary notes/files.",
		"transcripts/ contains read-only hardlinks/copies of this session's JSONL transcript so older history can be inspected after compaction.",
		"",
	].join("\n"));
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile && existsSync(sessionFile)) {
		for (const name of ["current.jsonl", basename(sessionFile)]) {
			const dest = join(transcripts, name);
			try { if (existsSync(dest)) unlinkSync(dest); } catch {}
			try { linkSync(sessionFile, dest); } catch { try { copyFileSync(sessionFile, dest); } catch {} }
		}
	}
	systemScopes = [
		...piDocsReadRoots().map((path) => ({ path, mode: "ro" as const, label: "pi docs" })),
		{ path: realIfExists(root), mode: "ro", label: "session system" },
		{ path: realIfExists(scratch), mode: "rw", label: "session scratch" },
		{ path: realIfExists(transcripts), mode: "ro", label: "session transcripts" },
	];
}

function isSystemPath(path: string, verb: Verb): boolean {
	const s = matchScope(systemScopes, path);
	if (!s) return false;
	return isWriteVerb(verb) ? canWriteMode(s.mode) : verb !== "bash" && canReadMode(s.mode);
}

function isReadLikeVerb(verb: Verb): boolean {
	return verb !== "bash" && !isWriteVerb(verb);
}

function systemAbsolutePath(path: string, cwd: string, verb: Verb): string | undefined {
	try {
		const abs = nfc(isAbsolute(path) ? expandUser(path) : resolve(cwd, expandUser(path)));
		const real = verb === "write" ? `${resolveReal(dirname(abs))}/${nfc(basename(abs))}` : resolveReal(abs);
		return isSystemPath(real, verb) ? real : undefined;
	} catch {
		return undefined;
	}
}

function appendStreamingText(current: string, chunk: string): string {
	const maxChars = 20_000;
	const next = current + chunk;
	return next.length > maxChars ? `[output truncated: showing last ${maxChars} chars]\n${next.slice(-maxChars)}` : next;
}

function padAnsi(text: string, width: number) {
	const visible = visibleWidth(text);
	return visible >= width ? truncateToWidth(text, width) : text + " ".repeat(width - visible);
}

function borderedPlain(lines: string[], width: number, title = "", style: (text: string) => string = (text) => text) {
	if (width < 8) return lines.map((line) => truncateToWidth(line, width));
	const inner = Math.max(1, width - 4);
	const border = Math.max(1, width - 2);
	const rawTitle = title ? ` ${title.toUpperCase()} ` : "";
	const titleText = truncateToWidth(rawTitle, border, "");
	const top = style(`╔${titleText}${"═".repeat(Math.max(0, border - visibleWidth(titleText)))}╗`);
	const body = lines.flatMap((line) => wrapTextWithAnsi(line, inner).map((wrapped) => `${style("║")} ${padAnsi(wrapped, inner)} ${style("║")}`));
	return [top, ...body, style(`╚${"═".repeat(border)}╝`)];
}

/** Tools that exist regardless of what has been added. */
const ALWAYS_ON = ["capabilities", "vm_create", "vm_start", "vm_stop", "vm_list", "vm_destroy", "vm_publish"];

/** Verbs we have actually implemented, so setActiveTools never names a ghost. */
const IMPLEMENTED: Verb[] = ["read", "ls", "find", "grep", "write", "edit", "bash"];

function expandUser(p: string): string {
	return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

function displayPath(path: string, original: string): string {
	return path === original ? path : `${path}\nresolved from ${original}`;
}

function normalizeVmId(id: string): string {
	if (id.startsWith("pi-run-")) throw new Error("Use the public target id, not the Docker container name");
	if (id.startsWith("pi-")) throw new Error("Use the public VM id without the pi- prefix");
	const out = id.toLowerCase();
	if (out === LOCAL_TARGET) throw new Error('VM name "local" is reserved');
	if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(out)) throw new Error("VM names must match [a-z0-9][a-z0-9_.-]{0,62}");
	return out;
}

const ok = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });
const bad = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });

type PermissionsSnapshot = Pick<State, "scopes" | "vms" | "execGrants" | "sshTargets" | "network" | "targets">;

type PermissionSubset = {
	files?: Array<{ path: string; mode?: ScopeMode }>;
	vms?: Array<{ vmId: string; mode?: ScopeMode; network?: boolean }>;
	exec?: Array<{ target: string; command: string; mode?: "ask" | "allow" }>;
	network?: "inherit" | "deny" | "ask" | "allow";
};

type PermissionsBridge = {
	instances: Map<string, {
		getSnapshot(): PermissionsSnapshot;
		applySnapshot(snapshot: PermissionsSnapshot): void;
		reduceSnapshot(subset?: PermissionSubset): PermissionsSnapshot;
	}>;
};

type IdleStatusBridge = {
	backgroundActiveCount?: () => number;
};

function permissionsBridge(): PermissionsBridge {
	const g = globalThis as typeof globalThis & { __piPermissionsBridge?: PermissionsBridge };
	g.__piPermissionsBridge ??= { instances: new Map() };
	return g.__piPermissionsBridge;
}

function idleStatusBridge(): IdleStatusBridge {
	return ((globalThis as typeof globalThis & { __piIdleStatus?: IdleStatusBridge }).__piIdleStatus ??= {});
}

function clonePermissionsSnapshot(snapshot: PermissionsSnapshot): PermissionsSnapshot {
	return {
		scopes: snapshot.scopes.map((s) => ({ ...s })),
		vms: snapshot.vms.map((v) => ({ ...v })),
		execGrants: snapshot.execGrants.map((g) => ({ ...g })),
		sshTargets: snapshot.sshTargets.map((s) => ({ ...s })),
		network: snapshot.network,
		targets: snapshot.targets.map((t) => ({ ...t, vm: t.vm ? { ...t.vm } : null, mounts: t.mounts.map((m) => ({ ...m })) })),
	};
}

function modeRank(mode: ScopeMode) {
	return ({ deny: 0, "ask-ro": 1, ro: 2, "ro-ask-rw": 3, "ask-rw": 4, rw: 5 } as const)[mode];
}

function weakerMode(requested: ScopeMode | undefined, parent: ScopeMode): ScopeMode {
	if (!requested) return parent;
	if (modeRank(requested) > modeRank(parent)) throw new Error(`Cannot delegate ${requested} from parent ${parent} permission`);
	return requested;
}

function weakerExecMode(requested: "ask" | "allow" | undefined, parent: "ask" | "allow"): "ask" | "allow" {
	if (!requested) return parent;
	if (parent === "ask" && requested === "allow") throw new Error("Cannot delegate allow from parent ask exec permission");
	return requested;
}

function isBuiltInSystemMountPath(hostPath: string): boolean {
	// VM targets are started with both user-delegated mounts and Pi's own
	// session/package mounts. The latter are not stored in State.scopes, so they
	// must not make an otherwise delegated running VM disappear in subagents.
	if (hostPath.includes("/pi-session-system/")) return true;
	return piDocsReadRoots().some((root) => isUnder(hostPath, root));
}

function targetCompatibleWith(snapshot: PermissionsSnapshot, target: RunningTarget) {
	const vmGrant = target.vm?.id ? snapshot.vms.find((vm) => vm.vmId === target.vm?.id && vm.mode !== "deny") : undefined;
	if (target.network && snapshot.network !== "allow" && !vmGrant?.network) return false;
	if (target.vm?.id && !vmGrant) return false;
	for (const mount of target.mounts) {
		if (isBuiltInSystemMountPath(mount.hostPath)) continue;
		const scope = snapshot.scopes.find((candidate) => candidate.mode !== "deny" && isUnder(mount.hostPath, candidate.path));
		if (!scope) return false;
		if (mount.mode === "rw" && !canWriteMode(scope.mode)) return false;
		if (mount.mode === "ro" && !canReadMode(scope.mode)) return false;
	}
	return true;
}

function reducePermissionsSnapshot(parentSnapshot: PermissionsSnapshot, subset: PermissionSubset | undefined, builtInScopes = systemScopes): PermissionsSnapshot {
	const parent = clonePermissionsSnapshot(parentSnapshot);
	if (!subset) return parent;
	const network = subset.network === undefined || subset.network === "inherit" ? parent.network : subset.network;
	if (parent.network === "deny" && network !== "deny") throw new Error("Cannot delegate network; parent network is deny");
	if (parent.network === "ask" && network === "allow") throw new Error("Cannot delegate allow network from parent ask network");
	const delegateableFileScopes = [...parent.scopes, ...builtInScopes.map(({ path, mode }) => ({ path, mode }))];
	const scopes = subset.files === undefined
		? parent.scopes.map((scope) => ({ ...scope }))
		: subset.files.map((requested) => {
			const requestedPath = realIfExists(nfc(requested.path));
			const parentScope = delegateableFileScopes.find((scope) => scope.path === requestedPath);
			if (!parentScope) throw new Error(`Cannot delegate file permission the parent does not have exactly: ${requested.path}`);
			return { path: parentScope.path, mode: weakerMode(requested.mode, parentScope.mode) };
		});
	const vms = subset.vms === undefined
		? parent.vms.map((vm) => ({ ...vm }))
		: subset.vms.map((requested) => {
			const requestedVmId = normalizeVmId(requested.vmId);
			const parentVm = parent.vms.find((vm) => vm.vmId === requestedVmId);
			if (!parentVm) throw new Error(`Cannot delegate VM permission the parent does not have: ${requestedVmId}`);
			if (requested.network && !parentVm.network && network !== "allow") {
				throw new Error(`Cannot delegate VM network for ${requestedVmId}; parent has neither VM-specific network nor delegated global network allow`);
			}
			return { vmId: parentVm.vmId, mode: weakerMode(requested.mode, parentVm.mode), network: requested.network ?? parentVm.network };
		});
	const execGrants = subset.exec === undefined
		? parent.execGrants.map((g) => ({ ...g }))
		: subset.exec.map((requested) => {
			const parentGrant = parent.execGrants.find((g) => g.target === requested.target && g.command === requested.command);
			if (!parentGrant) throw new Error(`Cannot delegate exec permission the parent does not have exactly: ${requested.target} ${requested.command}`);
			return { target: parentGrant.target, command: parentGrant.command, mode: weakerExecMode(requested.mode, parentGrant.mode) };
		});
	const reduced: PermissionsSnapshot = { scopes, vms, execGrants, sshTargets: parent.sshTargets, network, targets: parent.targets };
	return { ...reduced, targets: parent.targets.filter((target) => targetCompatibleWith(reduced, target)) };
}

/** Result of a permission guard: either a resolved target, or a denial to report. */
type GuardResult = { t: RunningTarget; denial?: undefined } | { t?: undefined; denial: Denial };

function denialText(d: Denial): string {
	const why: Record<Denial["reason"], string> = {
		NO_TARGET: `There is no target named "${d.target}".`,
		VERB_NOT_GRANTED: `This session does not have permission to use ${d.verb} for this request.`,
		OUT_OF_SCOPE: `"${d.path}" is outside the files and VMs added to this session.`,
		DENIED_PATH: `"${d.path}" was explicitly denied.`,
		READ_ONLY: `"${d.path}" is read-only in this session.`,
	};
	const lines = [`Permission denied: ${why[d.reason]}`];
	lines.push("", "Available now:");
	lines.push(`  targets: ${d.available.targets.join(", ") || "(none)"}`);
	lines.push(`  tools: ${d.available.verbs.join(", ") || "(none)"}`);
	if (d.available.scopes.length || d.available.vms.length) lines.push("  grants:");
	for (const s of d.available.scopes) lines.push(`    ${s.mode.padEnd(9)} ${s.path}`);
	for (const v of d.available.vms) lines.push(`    vm ${v.vmId} (${v.mode})`);
	lines.push("", "Use the listed current state to choose a valid route. Ask the user for access only if the task cannot be satisfied with the available grants and targets.");
	return lines.join("\n");
}

export default function extension(pi: ExtensionAPI) {
	const targets = new TargetManager();

	// Session state. Deliberately not stored in tool-result details: grants are
	// real-world authorizations and must not rewind when the conversation does.
	const state: State = { scopes: [], vms: [], execGrants: [], sshTargets: [], network: "deny", targets: [targets.localTarget(LOCAL_TARGET)] };

	function mountsForCurrentScopes() {
		return mountsForScopes([...state.scopes, ...systemScopes.map(({ path, mode }) => ({ path, mode }))]);
	}

	// Launch-time equivalent of typing /permissions add file, for headless runs and tests.
	// PI_PERMS_ADD="/some/dir:ro,/other:rw". Absent by default, so a plain
	// launch still starts with nothing added.
	for (const entry of (process.env.PI_PERMS_ADD ?? "").split(",").filter(Boolean)) {
		const i = entry.lastIndexOf(":");
		const requested = nfc(resolve(expandUser(i > 1 ? entry.slice(0, i) : entry)));
		const path = resolveReal(requested);
		const mode = i > 1 ? entry.slice(i + 1) : "ro";
		state.scopes.push({ path, mode: parseMode(mode, "ro") });
	}

	function sshRunningTarget(ssh: SshTarget): RunningTarget {
		return targets.remoteTarget(ssh.id);
	}

	function sshConfig(id: string): SshTarget | undefined {
		return targets.remoteConfig(id);
	}

	function target(id: string): RunningTarget | undefined {
		return state.targets.find((t) => t.id === id);
	}

	type PersistedPermissions = Pick<State, "scopes" | "vms" | "execGrants" | "sshTargets" | "network">;

	function permissionsStatePath(ctx: ExtensionContext): string {
		return join(ctx.sessionManager.getSessionDir(), "extension-state", "permissions", `${ctx.sessionManager.getSessionId()}.json`);
	}

	function loadPermissionsState(ctx: ExtensionContext): void {
		const path = permissionsStatePath(ctx);
		if (!existsSync(path)) return;
		try {
			const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedPermissions>;
			if (Array.isArray(saved.scopes)) state.scopes = saved.scopes;
			if (Array.isArray(saved.vms)) state.vms = saved.vms.flatMap((vm) => {
				try { return [{ ...vm, vmId: normalizeVmId(vm.vmId) }]; }
				catch { return []; }
			});
			if (Array.isArray(saved.execGrants)) state.execGrants = saved.execGrants.filter((g) => typeof g?.target === "string" && typeof g?.command === "string" && (g.mode === "ask" || g.mode === "allow"));
			if (Array.isArray(saved.sshTargets)) {
				state.sshTargets = saved.sshTargets.flatMap((s) => {
					try {
						if (typeof s?.id !== "string" || typeof s?.destination !== "string") return [];
						const port = typeof s.port === "number" && Number.isFinite(s.port) ? s.port : undefined;
						return [{ id: normalizeVmId(s.id), destination: s.destination, port }];
					} catch { return []; }
				});
				for (const ssh of state.sshTargets) { targets.configureRemote(ssh); state.targets.push(sshRunningTarget(ssh)); }
			}
			if (saved.network === "allow" || saved.network === "ask" || saved.network === "deny") state.network = saved.network;
		} catch {
			// Ignore corrupt session permission state. The user can re-add grants.
		}
	}

	function savePermissionsState(ctx: ExtensionContext): void {
		const path = permissionsStatePath(ctx);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ scopes: state.scopes, vms: state.vms, execGrants: state.execGrants, sshTargets: state.sshTargets, network: state.network } satisfies PersistedPermissions, null, 2));
	}

	function ensureExecGrant(targetId: string, command = "*", mode: "allow" | "ask" = "allow"): void {
		const existing = state.execGrants.find((g) => g.target === targetId && g.command === command);
		if (existing) {
			existing.mode = weakerExecMode(existing.mode, mode);
			return;
		}
		state.execGrants.push({ target: targetId, command, mode });
	}

	function managedPermissionToolNames() {
		return new Set([...ALWAYS_ON, ...IMPLEMENTED, "copy", "bg_start", "bg_list", "bg_status", "bg_stop"]);
	}

	function activeToolNames() {
		return [...managedPermissionToolNames()];
	}

	function mergedActiveToolNames() {
		const managed = managedPermissionToolNames();
		const preserved = pi.getActiveTools().filter((name) => !managed.has(name));
		return [...preserved, ...activeToolNames()];
	}

	function syncTools() {
		pi.setActiveTools(mergedActiveToolNames());
	}

	async function ask(ctx: ExtensionContext, req: AskRequest): Promise<boolean> {
		// Nobody there to answer: decline rather than hang.
		if (!ctx.hasUI) return false;
		const body = [...(req.detail ?? []).map((d) => `  • ${d}`), req.onDecline ? `\nIf declined: ${req.onDecline}` : ""]
			.filter(Boolean)
			.join("\n");
		return ctx.ui.confirm(req.operation, body);
	}

	async function approve(ctx: ExtensionContext, op: VmOp): Promise<boolean> {
		if (!requiresApproval(op)) return true;
		return ask(ctx, describeOp(op));
	}

	/**
	 * The authoritative check, applied to the path an fd actually landed on.
	 * decide() runs first on the requested path; this runs after resolution.
	 */
	function makeAllow(t: RunningTarget, verb: Verb, vmRoot?: string): Allow {
		return (real: string) => {
			if (isSystemPath(real, verb)) return true;
			if (vmRoot && isUnder(real, vmRoot)) {
				const g = vmScope(state, t.vm?.id);
				if (!g || g.mode === "deny") return false;
				return !isWriteVerb(verb) || canWriteMode(g.mode);
			}
			const s = matchScope(state.scopes, real);
			if (!s || s.mode === "deny") return false;
			if (!isWriteVerb(verb)) return canReadMode(s.mode);
			if (!canWriteMode(s.mode)) return false;
			const m = t.mounts.find((mt) => isUnder(real, mt.hostPath));
			return !(m && m.mode === "ro");
		};
	}

	type LocatedPath =
		| { kind: "host"; actual: string; allow: Allow }
		| { kind: "vm"; targetId: string; actual: string };

	/** Where a tool argument actually lives, and what may be touched. */
	function locate(t: RunningTarget, path: string, verb: Verb, cwd: string): LocatedPath {
		if (t.kind === "local") {
			const abs = nfc(isAbsolute(path) ? expandUser(path) : resolve(cwd, expandUser(path)));
			return { kind: "host", actual: abs, allow: makeAllow(t, verb) };
		}
		const abs = nfc(isAbsolute(path) ? path : resolve("/", path));
		const translated = translate(t, abs);
		if (translated?.hostPath) return { kind: "host", actual: translated.hostPath, allow: makeAllow(t, verb) };
		return { kind: "vm", targetId: t.id, actual: abs };
	}

	function guard(verb: Verb, params: { target: string; path?: string }, pathForDecision = params.path): GuardResult {
		const t = target(params.target);
		const d = decide(state, { verb, target: t?.id ?? params.target, path: pathForDecision });
		return d.allow ? { t: t as RunningTarget } : { denial: { ...d.denial, target: params.target } };
	}

	async function guardBash(ctx: ExtensionContext, params: { target: string; command: string }): Promise<GuardResult> {
		const t = target(params.target);
		if (!t) return guard("bash", params);
		if (!t.exec) return guard("bash", params);
		if (t.kind === "linux" || t.kind === "macos") return { t };
		if (t.kind === "remote") {
			if (!sshConfig(t.id)) return guard("bash", params);
			if (state.network === "deny") return { denial: { verb: "bash", target: params.target, reason: "VERB_NOT_GRANTED", available: { targets: state.targets.map((x) => x.id), scopes: state.scopes, vms: state.vms, verbs: availableVerbs(state) } } };
		}
		const grant = state.execGrants.find((g) => g.target === t.id && g.command === params.command)
			?? state.execGrants.find((g) => g.target === t.id && g.command === "*");
		if (!grant) {
			return {
				denial: {
					verb: "bash",
					target: params.target,
					reason: "VERB_NOT_GRANTED",
					available: { targets: state.targets.map((x) => x.id), scopes: state.scopes, vms: state.vms, verbs: availableVerbs(state) },
				},
			};
		}
		if (t.kind === "remote" && state.network === "ask") {
			const okToNetwork = await ask(ctx, {
				operation: `Allow SSH connection to ${t.id}`,
				detail: [`Target: ${sshConfig(t.id)?.destination ?? t.id}`],
				onDecline: "Pi will not connect to this SSH target.",
			});
			if (!okToNetwork) return { denial: { verb: "bash", target: params.target, reason: "VERB_NOT_GRANTED", available: { targets: state.targets.map((x) => x.id), scopes: state.scopes, vms: state.vms, verbs: availableVerbs(state) } } };
		}
		if (grant.mode === "ask") {
			const okToExec = await ask(ctx, {
				operation: `Allow exec on ${t.id}`,
				detail: [`Grant: ${grant.command}`, `$ ${params.command}`],
				onDecline: "Pi will not run this command.",
			});
			if (!okToExec) return { denial: { verb: "bash", target: params.target, reason: "VERB_NOT_GRANTED", available: { targets: state.targets.map((x) => x.id), scopes: state.scopes, vms: state.vms, verbs: availableVerbs(state) } } };
		}
		return { t };
	}

	async function approveAskScope(ctx: ExtensionContext, t: RunningTarget, verb: Verb, pathForDecision: string | undefined, originalPath: string | undefined): Promise<boolean> {
		if (!pathForDecision || verb === "bash") return true;
		const translated = translate(t, pathForDecision);
		if (translated === null) {
			const g = vmScope(state, t.vm?.id);
			if (!g || !asksForVerb(g.mode, verb)) return true;
			return ask(ctx, {
				operation: `Allow ${verb} on VM ${g.vmId}${originalPath ? ` at ${originalPath}` : ""}`,
				detail: ["This VM permission is ask-only. Approving allows this operation once."],
				onDecline: `Pi will not ${verb} this VM path.`,
			});
		}
		const scope = matchScope(state.scopes, translated.hostPath);
		if (!scope || !asksForVerb(scope.mode, verb)) return true;
		return ask(ctx, {
			operation: `Allow ${verb} on ${originalPath ?? pathForDecision}`,
			detail: [
				`Resolved path: ${translated.hostPath}`,
				`Ask permission: ${scope.mode}`,
				"Approving allows this operation once.",
			],
			onDecline: `Pi will not ${verb} this path.`,
		});
	}

	function pathForLocalDecision(path: string, verb: Verb, cwd: string): string {
		const abs = nfc(isAbsolute(path) ? expandUser(path) : resolve(cwd, expandUser(path)));
		if (verb === "write") {
			const parent = resolveReal(dirname(abs));
			return `${parent}/${nfc(basename(abs))}`;
		}
		return resolveReal(abs);
	}

	// ---------------------------------------------------------------- tools

	const targetParam = Type.String({ description: 'Where to act: "local", an SSH target id, or a running VM target id. For VM-backed targets, the target id is the VM id.' });

	function toolCallLine(parts: Array<string | undefined>, theme: any) {
		const [name, ...rest] = parts.filter(Boolean) as string[];
		const text = [name, ...rest].filter(Boolean).join(" ");
		const line = theme?.fg && name
			? [theme.fg("toolTitle", theme.bold?.(name) ?? name), rest.length ? theme.fg("toolOutput", rest.join(" ")) : undefined].filter(Boolean).join(" ")
			: text;
		return { invalidate() {}, render: (width: number) => [truncateToWidth(line, width)] };
	}

	pi.registerTool({
		name: "capabilities",
		label: "Capabilities",
		description:
			"Report exactly what this session may do right now: which directories were added and at what mode, which VMs are usable, and which targets are running. Use this when access is unclear, and after a permission denial.",
		promptSnippet: "Report what this session is currently permitted to do",
		promptGuidelines: [],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			refreshSessionSystemPaths(ctx);
			const verbs = availableVerbs(state).filter((v) => IMPLEMENTED.includes(v));
			const running = state.targets.map(
				(t) =>
					`  ${t.id}${t.exec ? " [exec-capable]" : ""}${t.kind === "linux" ? " [exec allowed]" : ""}${t.kind === "remote" ? " [ssh]" : ""}${t.network ? " [network]" : ""}` +
					(t.mounts.length ? `\n${t.mounts.map((m) => `      ${m.hostPath} → ${m.guestPath} (${m.mode})`).join("\n")}` : ""),
			);
			const systemRoots = systemScopes;
			const lines = [
				"files:",
				...(state.scopes.length ? state.scopes.map((s) => `  ${s.mode.padEnd(9)} ${s.path}`) : ["  none"]),
				...(systemRoots.length ? ["system:", ...systemRoots.map((s) => `  ${s.mode.padEnd(9)} ${s.path}  (${s.label})`)] : []),
				`network: ${state.network ?? "deny"}`,
				"vms:",
				...(state.vms.length ? state.vms.map((v) => {
					const run = state.targets.find((t) => t.vm?.id === v.vmId);
					return `  ${v.mode.padEnd(9)} ${v.vmId}${v.network ? " +network" : ""} ${run ? `running${run.exec ? " [exec]" : ""}${run.network ? " [network]" : ""}` : "stopped"}`;
				}) : ["  none"]),
				"ssh targets:",
				...(state.sshTargets.length ? state.sshTargets.map((s) => `  ${s.id} ${s.destination}${s.port !== undefined ? `:${s.port}` : ""}`) : ["  none"]),
				"exec grants:",
				...(state.execGrants.length ? state.execGrants.map((g) => `  ${g.mode.padEnd(5)} ${g.target} ${g.command}`) : ["  none"]),
				"running:",
				...(running.length ? running : ["  none"]),
				`tools: ${mergedActiveToolNames().join(", ") || "none"}`,
			];
			const modelLines = [...lines];
			if (!verbs.some((v) => v === "read" || v === "ls" || v === "find" || v === "grep")) modelLines.push("hint: read/ls/find/grep need readable file or VM access.");
			if (!verbs.some((v) => v === "write" || v === "edit")) modelLines.push("hint: write/edit need writable file or VM access.");
			if (!verbs.includes("bash")) modelLines.push("hint: bash/bg_* need a running exec-capable target with an exec grant; Docker VM targets allow exec by design.");
			return ok(modelLines.join("\n"), { display: lines.join("\n") });
		},
		renderResult(result: any) {
			const text = result.details?.display ?? result.content?.map((part: any) => part.text ?? "").join("\n") ?? "";
			return { invalidate() {}, render: (width: number) => text.split("\n").map((line: string) => truncateToWidth(line, width)) };
		},
	});

	pi.registerTool({
		name: "vm_create",
		label: "Create VM",
		description:
			"Create a fresh VM and start it as a running exec target. Unnamed instances are scratch and need no approval. The default base is minimal ubuntu:latest: basic shell/userland only, not much else — in particular, no scripting runtimes. Start with temporary network if you need to install more.",
		promptSnippet: "Create and start a VM target",
		promptGuidelines: [
			"Use vm_create when you need an executable target and no suitable exec-enabled target is already available.",
			"Prefer an unnamed vm_create — it is free and needs no approval.",
			"The default VM is intentionally minimal Ubuntu: basic shell/userland only, not much else — in particular, no scripting runtimes unless you install them.",
			"If you only need network to install or fetch dependencies, keep that phase short, then vm_stop and vm_start without network before reading or processing user files.",
		],
		parameters: Type.Object({
			os: Type.Optional(Type.Union([Type.Literal("linux"), Type.Literal("macos")], { description: "VM operating system; Linux is the default. macOS requires Apple Silicon macOS 27+." })),
			name: Type.Optional(Type.String({ description: "Only for a durable, reusable VM. Omit for a generated scratch id." })), 
			base: Type.Optional(Type.String({ description: "Existing VM to fork from. Omit this field to use the built-in minimal ubuntu:latest base." })),
			network: Type.Optional(Type.Boolean({ description: "Requires approval unless network is already allowed: turns read access into possible exfiltration." })),
		}),
		renderCall(args: any, theme: any) {
			return toolCallLine(["vm_create", args?.os ? `os=${args.os}` : undefined, args?.name, args?.base ? `base=${args.base}` : undefined, args?.network ? "network" : undefined], theme);
		},
		async execute(_id, params, _signal, onUpdate, ctx) {
			const wantsNetwork = params.network ?? false;
			let createName: string | undefined;
			try { createName = params.name ? normalizeVmId(params.name) : undefined; }
			catch (err) { return bad(`vm_create failed: ${(err as Error).message}`); }
			const op: VmOp = { op: "create", name: createName, network: wantsNetwork };
			if (wantsNetwork && state.network !== "allow") {
				if (state.network !== "ask") return bad("Permission denied: network access is not enabled for this session. Use /permissions add network ask|allow to allow it.");
				if (!(await approve(ctx, op))) return bad("Permission denied: VM creation was not approved.");
			} else if (params.name && !(await approve(ctx, op))) {
				return bad("Permission denied: VM creation was not approved.");
			}
			let baseId: string | undefined;
			try {
				baseId = params.base ? normalizeVmId(params.base) : undefined;
			} catch (err) {
				return bad(`vm_create failed: ${(err as Error).message}`);
			}
			if (baseId && !vmScope(state, baseId) && !targets.isPublished(baseId)) {
				return bad(
					`Permission denied: base VM ${baseId} is private and has not been added to this session. ` +
						`If you wanted the default Ubuntu base, omit the base parameter. ` +
						`Otherwise use /permissions add vm ro ${baseId} to allow temporary access.`, 
				);
			}
			try {
				let progress = "";
				const onOutput = (chunk: string) => {
					progress = appendStreamingText(progress, chunk);
					onUpdate?.(ok(progress));
				};
				const vm = await targets.createVm({ os: params.os, name: createName, base: baseId, network: wantsNetwork, onOutput });
				state.vms.push({ vmId: vm.id, mode: "rw" });
				refreshSessionSystemPaths(ctx);
				const run = await targets.start(vm.id, {
					mounts: mountsForCurrentScopes(),
					network: wantsNetwork,
				});
				state.targets = state.targets.filter((t) => t.id !== run.id);
				state.targets.push(run);
				ensureExecGrant(run.id);
				savePermissionsState(ctx);
				syncTools();
				const networkNote = run.network
					? "\nNetwork is ENABLED. If it was only needed temporarily, vm_stop this target and vm_start it again without network before reading or processing user files."
					: "";
				return ok(`Created and started ${vm.id}.${networkNote}`, {
					display: [
						`Created and started ${vm.id}`,
						`vm: rw${run.network ? ", network" : ""}`,
						`target: ${run.id} [exec]${run.network ? " [network]" : ""}`,
					].join("\n"),
				});
			} catch (err) {
				return bad(`vm_create failed: ${(err as Error).message}`);
			}
		},
		renderResult: renderDisplayResult,
	});

	pi.registerTool({
		name: "vm_start",
		label: "Start VM",
		description:
			"Adopt an added VM into this session by starting it as a running target. It mounts whatever directories have been added, at the mode they were added. Network is off by default and requires approval or a VM network permission. If network is only needed temporarily, stop and restart without network when finished.",
		promptSnippet: "Start/adopt an added VM as a running target",
		parameters: Type.Object({
			vmId: Type.String({ description: "VM id to start, e.g. scratch-abc123" }),
			network: Type.Optional(Type.Boolean({ description: "Requires approval: turns read access into possible exfiltration." })),
		}),
		renderCall(args: any, theme: any) {
			return toolCallLine(["vm_start", args?.vmId, args?.network ? "network" : undefined], theme);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			refreshSessionSystemPaths(ctx);
			let vmId: string;
			try { vmId = normalizeVmId(params.vmId); }
			catch (err) { return bad(`vm_start failed: ${(err as Error).message}`); }
			const grant = vmScope(state, vmId);
			if (!grant || grant.mode === "deny") {
				return bad(`Permission denied: VM ${vmId} has not been added to this session. Use /permissions add vm rw ${vmId} first.`);
			}
			if (!canWriteMode(grant.mode)) {
				return bad(`Permission denied: VM ${vmId} is read-only in this session. Starting it requires rw, ask-rw, or ro-ask-rw because vm_stop saves changes back to the VM.`);
			}
			if (isAskMode(grant.mode)) {
				const okToStart = await ask(ctx, {
					operation: `Start VM ${vmId}`,
					detail: [`This VM permission is ${grant.mode}. Starting allows a running target whose changes can later be persisted with vm_stop.`],
					onDecline: "the VM is not started",
				});
				if (!okToStart) return bad("Permission denied: VM start was not approved.");
			}
			const wantsNetwork = params.network ?? false;
			if (wantsNetwork && state.network !== "allow" && !grant.network) {
				if (state.network !== "ask") return bad(`Permission denied: network access is not enabled for this session or VM ${vmId}. Use /permissions add network ask|allow or /permissions add vm network ${vmId} to allow it.`);
				if (!(await approve(ctx, { op: "start", vmId, network: true }))) {
					return bad("Permission denied: starting this VM with network was not approved.");
				}
			}
			try {
				const run = await targets.start(vmId, {
					mounts: mountsForCurrentScopes(),
					network: params.network,
				});
				state.targets = state.targets.filter((t) => t.id !== run.id);
				state.targets.push(run);
				syncTools();
				const networkNote = run.network
					? "\nNetwork is ENABLED. If it was only needed temporarily, vm_stop this target and vm_start it again without network before reading or processing user files."
					: "";
				return ok(`Started ${vmId}.${networkNote}`, {
					display: [
						`Started ${vmId}`,
						`vm: ${grant.mode}${grant.network ? ", network grant" : ""}`,
						`target: ${run.id} [exec]${run.network ? " [network]" : ""}`,
					].join("\n"),
				});
			} catch (err) {
				return bad(`vm_start failed: ${(err as Error).message}`);
			}
		},
		renderResult: renderDisplayResult,
	});

	pi.registerTool({
		name: "vm_stop",
		label: "Stop VM",
		description:
			"Stop a running VM target, save its filesystem changes back to the VM, and remove the target. This drops this session's mounts; the VM can be started again later.",
		promptSnippet: "Stop a running VM target and persist its changes",
		parameters: Type.Object({ target: targetParam }),
		renderCall(args: any, theme: any) {
			return toolCallLine(["vm_stop", args?.target], theme);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const t = target(params.target);
			let vmId: string;
			let targetId: string;
			if (t) {
				if (!t.vm) return bad(`Permission denied: target ${params.target} is not a VM.`);
				vmId = t.vm.id;
				targetId = t.id;
			} else {
				try {
					vmId = normalizeVmId(params.target);
					targetId = vmId;
				} catch {
					return bad(`Permission denied: there is no running target named ${params.target}.`);
				}
			}
			const grant = vmScope(state, vmId);
			if (!grant || !canWriteMode(grant.mode)) return bad(`Permission denied: VM ${vmId} has not been added with write access for this session.`);
			if (isAskMode(grant.mode)) {
				const okToStop = await ask(ctx, {
					operation: `Stop and persist VM ${vmId}`,
					detail: [`This VM permission is ${grant.mode}. Stopping saves target changes back to the VM.`],
					onDecline: "the running target is left untouched",
				});
				if (!okToStop) return bad("Permission denied: stopping and saving this VM was not approved.");
			}
			if (!t) {
				const okToRecover = await ask(ctx, {
					operation: `Stop external target ${targetId}`,
					detail: ["This target is not owned by the current session.", "If another session is still using it, that session will be interrupted."],
					onDecline: "leave the running target untouched",
				});
				if (!okToRecover) return bad("Permission denied: stopping the external target was not approved.");
			}

			try {
				await targets.stop(targetId);
				state.targets = state.targets.filter((x) => x.id !== targetId);
				syncTools();
				return ok(`Stopped ${vmId}; changes saved.`);
			} catch (err) {
				return bad(`vm_stop failed: ${(err as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "vm_list",
		label: "List VMs",
		description: "List managed VMs.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const vms = targets.listVms();
				return ok(vms.length ? vms.map((v) => {
					const run = state.targets.find((t) => t.vm?.id === v.id);
					return `${v.id}${v.name ? ` (${v.name})` : ""} ${run ? "running" : "stopped"}${targets.isPublished(v.id) ? " [published]" : ""}`;
				}).join("\n") : "(none)");
			} catch (err) {
				return bad(`vm_list failed: ${(err as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "vm_destroy",
		label: "Destroy VM",
		description: "Destroy a VM and its filesystem. Destroying a named VM requires approval.",
		parameters: Type.Object({ vmId: Type.String() }),
		renderCall(args: any, theme: any) {
			return toolCallLine(["vm_destroy", args?.vmId], theme);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let vmId: string;
			try { vmId = normalizeVmId(params.vmId); }
			catch (err) { return bad(`vm_destroy failed: ${(err as Error).message}`); }
			const grant = vmScope(state, vmId);
			if (!grant || !canWriteMode(grant.mode)) return bad(`Permission denied: VM ${vmId} has not been added with write access for this session.`);
			if (isAskMode(grant.mode)) {
				const okToDestroy = await ask(ctx, {
					operation: `Destroy VM ${vmId}`,
					detail: [`This VM permission is ${grant.mode}. Destroying deletes the VM filesystem.`],
					onDecline: "the VM is left intact",
				});
				if (!okToDestroy) return bad("Permission denied: destroying this VM was not approved.");
			}
			const named = Boolean(targets.getVm(vmId)?.name);
			if (!(await approve(ctx, { op: "destroy", vmId, named }))) return bad("Permission denied: destroying this VM was not approved.");
			try {
				await targets.destroyVm(vmId);
				state.vms = state.vms.filter((v) => v.vmId !== vmId);
				state.targets = state.targets.filter((t) => t.vm?.id !== vmId);
				state.execGrants = state.execGrants.filter((g) => g.target !== vmId);
				savePermissionsState(ctx);
				syncTools();
				return ok(`Destroyed ${vmId}.`);
			} catch (err) {
				return bad(`vm_destroy failed: ${(err as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "vm_publish",
		label: "Publish VM",
		description: "Publish a running target as a reusable VM. Publishing a named VM under its own name marks/updates that VM as published. Requires approval.",
		parameters: Type.Object({ target: targetParam, name: Type.String({ description: "Published VM id/name." }) }),
		renderCall(args: any, theme: any) {
			return toolCallLine(["vm_publish", args?.target, args?.name ? `as ${args.name}` : undefined], theme);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const t = target(params.target);
			if (!t || !t.exec) return bad(`Permission denied: there is no running target named ${params.target}.`);
			if (!t.vm) return bad(`Permission denied: target ${params.target} is not a VM.`);
			let publishId: string;
			try { publishId = normalizeVmId(params.name); }
			catch (err) { return bad(`vm_publish failed: ${(err as Error).message}`); }
			const okToPublish = await ask(ctx, {
				operation: `Publish ${params.target} as ${publishId}`,
				detail: ["future sessions may use this as a base without temporary VM access", "If publishing the target's own VM id, this updates it in place and marks it published."],
			});
			if (!okToPublish) return bad("Permission denied: publishing this VM was not approved.");
			try {
				const published = targets.publish(t.id, publishId);
				return ok(`Published ${t.id} as ${published}. Use vm_create with base=${published} to fork it.`, { display: `Published ${t.id} as ${published}` });
			} catch (err) {
				return bad(`vm_publish failed: ${(err as Error).message}`);
			}
		},
		renderResult: renderDisplayResult,
	});


	// -------------------------------------------------------- filesystem tools

	function globToRegExp(pattern: string): RegExp {
		let out = "^";
		for (let i = 0; i < pattern.length; i++) {
			const ch = pattern[i] ?? "";
			if (ch === "*") {
				if (pattern[i + 1] === "*") {
					out += ".*";
					i++;
				} else out += "[^/]*";
			} else if (ch === "?") {
				out += "[^/]";
			} else {
				out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
			}
		}
		return new RegExp(`${out}$`);
	}
	function guestPathForActual(t: RunningTarget, real: string): string {
		if (t.kind === "local") return real;
		const m = t.mounts.find((mt) => isUnder(real, mt.hostPath));
		if (!m) return real;
		const rel = relative(m.hostPath, real).split("/").filter(Boolean).join("/");
		return rel ? `${m.guestPath}/${rel}` : m.guestPath;
	}

	function actualForBuiltIn(t: RunningTarget, absolutePath: string, verb: Exclude<Verb, "bash">, cwd: string) {
		return locate(t, absolutePath, verb, t.kind === "local" ? cwd : "/");
	}

	function checkLocated(loc: LocatedPath): void {
		if (loc.kind === "host") checkedPath(loc.actual, loc.allow);
		else if (!targets.vmExists(loc.targetId, loc.actual)) throw new Error(`No such file or directory: ${loc.actual}`);
	}

	function readLocated(loc: LocatedPath): Buffer {
		return loc.kind === "host" ? readFileSync(checkedPath(loc.actual, loc.allow)) : targets.vmReadFile(loc.targetId, loc.actual);
	}

	function writeLocated(loc: LocatedPath, content: string): void {
		if (loc.kind === "host") writeFileVerified(loc.actual, content, loc.allow);
		else targets.vmWriteFile(loc.targetId, loc.actual, content);
	}

	function registerBuiltInFsTool(
		verb: Exclude<Verb, "bash" | "grep">,
		factory: (cwd: string, options?: any) => any,
		makeOperations: (t: RunningTarget, ctx: ExtensionContext) => any,
		massageParams: (params: any) => any = (params) => params,
	) {
		const shell = factory("/");
		pi.registerTool({
			...shell,
			...(verb === "read" && {
				description: `${shell.description} If your goal is to copy or transfer a file/directory, use the copy tool instead of reading file contents through the context window.`,
				promptGuidelines: [
					...(shell.promptGuidelines ?? []),
					"If the user wants to copy, move, transfer, or duplicate files/directories, prefer the copy tool instead of reading contents through the context window and writing them back out.",
				],
			}),
			parameters: Type.Object({ target: targetParam, ...(shell.parameters as any).properties }),
			async execute(id: string, rawParams: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
				const params = massageParams(rawParams);
				refreshSessionSystemPaths(ctx);
				const t0 = target(params.target);
				let pathForDecision = params.path ?? ".";
				const hiddenRead = t0?.kind === "local" ? systemAbsolutePath(pathForDecision, ctx.cwd, verb) : undefined;
				if (t0?.kind === "local") {
					try {
						pathForDecision = pathForLocalDecision(pathForDecision, verb, ctx.cwd);
					} catch {}
				} else if (t0) {
					pathForDecision = nfc(isAbsolute(pathForDecision) ? pathForDecision : resolve("/", pathForDecision));
				}
				const g: GuardResult = hiddenRead && t0 ? { t: t0 } : guard(verb, { target: params.target, path: params.path }, pathForDecision);
				if (g.denial) return bad(denialText({ ...g.denial, path: params.path ?? "." }));
				if (!(await approveAskScope(ctx, g.t, verb, pathForDecision, params.path ?? "."))) {
					return bad(`Permission denied: ${verb} was not approved for ${params.path ?? "."}.`);
				}
				try {
					const base = factory(g.t.kind === "local" ? ctx.cwd : "/", { operations: makeOperations(g.t, ctx) });
					const { target: _target, ...innerParams } = params;
					return await base.execute(id, innerParams, signal, onUpdate, ctx);
				} catch (err) {
					if (err instanceof DeniedError) {
						return bad(`Permission denied: "${params.path ?? "."}" resolved to ${err.realPath}, which is outside the files and VMs added to this session.`);
					}
					return bad(`${verb} failed: ${(err as Error).message}`);
				}
			},
			renderCall(args: any, theme: any, context: any) {
				const { target: _target, ...innerArgs } = massageParams(args ?? {});
				return factory(context.cwd).renderCall?.(innerArgs, theme, context);
			},
			renderResult(result: any, options: any, theme: any, context: any) {
				return factory(context.cwd).renderResult?.(result, options, theme, context);
			},
		});
	}

	registerBuiltInFsTool("read", createReadToolDefinition, (t, ctx): ReadOperations => ({
		access: async (absolutePath) => checkLocated(actualForBuiltIn(t, absolutePath, "read", ctx.cwd)),
		readFile: async (absolutePath) => readLocated(actualForBuiltIn(t, absolutePath, "read", ctx.cwd)),
	}));

	registerBuiltInFsTool("ls", createLsToolDefinition, (t, ctx): LsOperations => ({
		exists: (absolutePath) => {
			try {
				checkLocated(actualForBuiltIn(t, absolutePath, "ls", ctx.cwd));
				return true;
			} catch {
				return false;
			}
		},
		stat: (absolutePath) => {
			const loc = actualForBuiltIn(t, absolutePath, "ls", ctx.cwd);
			return loc.kind === "host" ? statSync(checkedPath(loc.actual, loc.allow)) : targets.vmStat(loc.targetId, loc.actual);
		},
		readdir: (absolutePath) => {
			const loc = actualForBuiltIn(t, absolutePath, "ls", ctx.cwd);
			return loc.kind === "host" ? listDirVerified(loc.actual, loc.allow).entries : targets.vmReadDir(loc.targetId, loc.actual);
		},
	}));

	registerBuiltInFsTool("find", createFindToolDefinition, (t, ctx): FindOperations => ({
		exists: (absolutePath) => {
			try {
				checkLocated(actualForBuiltIn(t, absolutePath, "find", ctx.cwd));
				return true;
			} catch {
				return false;
			}
		},
		glob: (pattern, searchPath, options) => {
			const loc = actualForBuiltIn(t, searchPath, "find", ctx.cwd);
			const re = globToRegExp(pattern);
			const hits: string[] = [];
			const visit = (guest: string, isDir: boolean) => {
				if (hits.length >= options.limit) return;
				const rel = relative(searchPath, guest).split("/").join("/");
				if (rel.includes("node_modules/") || rel.includes(".git/")) return;
				const candidate = isDir ? `${rel}/` : rel;
				const matchedPart = pattern.includes("/") ? candidate : basename(candidate.replace(/\/$/, ""));
				if (re.test(matchedPart)) hits.push(guest);
			};
			if (loc.kind === "host") {
				walkVerified(loc.actual, loc.allow, (real, isDir) => visit(guestPathForActual(t, real), isDir), { maxEntries: options.limit * 20 });
			} else {
				for (const entry of targets.vmWalk(loc.targetId, loc.actual, options.limit * 20)) visit(entry.path, entry.isDir);
			}
			return hits;
		},
	}));

	registerBuiltInFsTool("write", createWriteToolDefinition, (t, ctx): WriteOperations => ({
		mkdir: async (_dir) => {},
		writeFile: async (absolutePath, content) => writeLocated(actualForBuiltIn(t, absolutePath, "write", ctx.cwd), content),
	}), (params) => ({ ...params, content: params.content ?? params.contents }));

	registerBuiltInFsTool("edit", createEditToolDefinition, (t, ctx): EditOperations => ({
		access: async (absolutePath) => checkLocated(actualForBuiltIn(t, absolutePath, "edit", ctx.cwd)),
		readFile: async (absolutePath) => readLocated(actualForBuiltIn(t, absolutePath, "edit", ctx.cwd)),
		writeFile: async (absolutePath, content) => writeLocated(actualForBuiltIn(t, absolutePath, "edit", ctx.cwd), content),
	}));

	function appendTargetPath(base: string, name: string): string {
		return base === "/" ? `/${name}` : `${base.replace(/\/+$/, "")}/${name}`;
	}

	function existsLocated(loc: LocatedPath): boolean {
		try {
			checkLocated(loc);
			return true;
		} catch (err) {
			if (err instanceof DeniedError) throw err;
			return false;
		}
	}

	function isDirLocated(loc: LocatedPath): boolean {
		return loc.kind === "host" ? statSync(checkedPath(loc.actual, loc.allow)).isDirectory() : targets.vmStat(loc.targetId, loc.actual).isDirectory();
	}

	function listLocated(loc: LocatedPath): string[] {
		return loc.kind === "host" ? readdirSync(checkedPath(loc.actual, loc.allow)).map(nfc).sort() : targets.vmReadDir(loc.targetId, loc.actual);
	}

	function mkdirLocated(loc: LocatedPath): void {
		if (loc.kind === "host") mkdirVerified(loc.actual, loc.allow);
		else targets.vmMkdir(loc.targetId, loc.actual);
	}

	function writeBufferLocated(loc: LocatedPath, content: Buffer): void {
		if (loc.kind === "host") writeBufferVerified(loc.actual, content, loc.allow);
		else targets.vmWriteFileBytes(loc.targetId, loc.actual, content);
	}

	function pathForFsDecision(t0: RunningTarget | undefined, targetPath: string, verb: Exclude<Verb, "bash">, cwd: string): string {
		if (t0?.kind === "local") return pathForLocalDecision(targetPath, verb, cwd);
		if (t0) return nfc(isAbsolute(targetPath) ? targetPath : resolve("/", targetPath));
		return targetPath;
	}

	type CopyEndpoint = LocatedPath | { kind: "remote"; cfg: SshTargetConfig; actual: string };

	function locateCopyEndpoint(t: RunningTarget, path: string, verb: "read" | "write", cwd: string): CopyEndpoint {
		if (t.kind === "remote") {
			const cfg = sshConfig(t.id);
			if (!cfg) throw new Error(`ssh target not found: ${t.id}`);
			return { kind: "remote", cfg, actual: nfc(isAbsolute(path) ? path : resolve("/", path)) };
		}
		return locate(t, path, verb, cwd);
	}

	async function approveSshFilesystem(ctx: ExtensionContext, t: RunningTarget, op: "read" | "write", path: string): Promise<string | undefined> {
		if (t.kind !== "remote") return undefined;
		if (!sshConfig(t.id)) return `SSH target not found: ${t.id}`;
		const grant = state.execGrants.find((g) => g.target === t.id && g.command === "*");
		if (!grant) return `Permission denied: copying ${op === "read" ? "from" : "to"} SSH target ${t.id} requires an exec grant for '*'. Add one with /permissions add exec ask|allow ${t.id} *.`;
		if (state.network === "deny") return `Permission denied: SSH target ${t.id} requires network permission. Use /permissions add network ask|allow.`;
		if (state.network === "ask") {
			const okToNetwork = await ask(ctx, { operation: `Allow SSH connection to ${t.id}`, detail: [`Target: ${sshConfig(t.id)?.destination ?? t.id}`, `Operation: copy ${op} ${path}`], onDecline: "Pi will not copy over SSH." });
			if (!okToNetwork) return "Permission denied: SSH network access was not approved.";
		}
		if (grant.mode === "ask") {
			const okToExec = await ask(ctx, { operation: `Allow SSH filesystem ${op} on ${t.id}`, detail: ["This is permitted because the target has exec '*' ask-only access.", `Path: ${path}`], onDecline: "Pi will not copy over SSH." });
			if (!okToExec) return "Permission denied: SSH filesystem access was not approved.";
		}
		return undefined;
	}

	async function sshChecked(cfg: SshTargetConfig, command: string, stdin?: Buffer, signal?: AbortSignal): Promise<Buffer> {
		const res = await targets.sshBytes(cfg, command, { stdin, signal, timeoutMs: 300_000 });
		if (res.exitCode !== 0) throw new Error((res.stderr.toString() || res.stdout.toString() || "ssh command failed").trim());
		return res.stdout;
	}

	async function vmChecked(targetId: string, command: string, stdin?: Buffer, signal?: AbortSignal): Promise<Buffer> {
		return targets.vmExecBytes(targetId, command, { input: stdin, signal, timeoutMs: 300_000 });
	}

	async function existsCopyEndpoint(ep: CopyEndpoint, signal?: AbortSignal): Promise<boolean> {
		if (ep.kind === "host") return existsLocated(ep);
		if (ep.kind === "vm") {
			try {
				await vmChecked(ep.targetId, `if test -d ${targets.shellQuote(ep.actual)}; then printf d; elif test -e ${targets.shellQuote(ep.actual)}; then printf f; else exit 1; fi`, undefined, signal);
				return true;
			} catch { return false; }
		}
		const res = await targets.sshBytes(ep.cfg, `if test -d ${targets.shellQuote(ep.actual)}; then printf d; elif test -e ${targets.shellQuote(ep.actual)}; then printf f; else exit 1; fi`, { signal, timeoutMs: 300_000 });
		return res.exitCode === 0;
	}

	async function isSymlinkCopyEndpoint(ep: CopyEndpoint, signal?: AbortSignal): Promise<boolean> {
		if (ep.kind === "host") return lstatSync(ep.actual).isSymbolicLink();
		if (ep.kind === "vm") {
			try {
				await vmChecked(ep.targetId, `test -L ${targets.shellQuote(ep.actual)}`, undefined, signal);
				return true;
			} catch { return false; }
		}
		const res = await targets.sshBytes(ep.cfg, `test -L ${targets.shellQuote(ep.actual)}`, { signal, timeoutMs: 300_000 });
		return res.exitCode === 0;
	}

	async function isDirCopyEndpoint(ep: CopyEndpoint, signal?: AbortSignal): Promise<boolean> {
		if (ep.kind === "host") return statSync(checkedPath(ep.actual, ep.allow)).isDirectory();
		const command = `if test -L ${targets.shellQuote(ep.actual)}; then exit 2; elif test -d ${targets.shellQuote(ep.actual)}; then printf d; elif test -e ${targets.shellQuote(ep.actual)}; then printf f; else exit 1; fi`;
		const out = ep.kind === "vm" ? await vmChecked(ep.targetId, command, undefined, signal) : await sshChecked(ep.cfg, command, undefined, signal);
		return out.toString() === "d";
	}

	async function isFileCopyEndpoint(ep: CopyEndpoint, signal?: AbortSignal): Promise<boolean> {
		if (ep.kind === "host") return statSync(checkedPath(ep.actual, ep.allow)).isFile();
		if (ep.kind === "vm") {
			try {
				await vmChecked(ep.targetId, `test -f ${targets.shellQuote(ep.actual)}`, undefined, signal);
				return true;
			} catch { return false; }
		}
		const res = await targets.sshBytes(ep.cfg, `test -f ${targets.shellQuote(ep.actual)}`, { signal, timeoutMs: 300_000 });
		return res.exitCode === 0;
	}

	async function listCopyEndpoint(ep: CopyEndpoint, signal?: AbortSignal): Promise<string[]> {
		if (ep.kind === "host") return listLocated(ep);
		const command = `find ${targets.shellQuote(ep.actual)} -mindepth 1 -maxdepth 1 -printf '%f\\0' | sort -z`;
		const out = ep.kind === "vm" ? await vmChecked(ep.targetId, command, undefined, signal) : await sshChecked(ep.cfg, command, undefined, signal);
		return out.toString("utf8").split("\0").filter(Boolean).map(nfc);
	}

	async function mkdirCopyEndpoint(ep: CopyEndpoint, signal?: AbortSignal): Promise<void> {
		if (ep.kind === "remote") await sshChecked(ep.cfg, `mkdir -- ${targets.shellQuote(ep.actual)}`, undefined, signal);
		else if (ep.kind === "vm") await vmChecked(ep.targetId, `mkdir -- ${targets.shellQuote(ep.actual)}`, undefined, signal);
		else mkdirLocated(ep);
	}

	async function readCopyEndpoint(ep: CopyEndpoint, signal?: AbortSignal): Promise<Buffer> {
		if (ep.kind === "remote") return sshChecked(ep.cfg, `cat -- ${targets.shellQuote(ep.actual)}`, undefined, signal);
		if (ep.kind === "vm") return vmChecked(ep.targetId, `cat -- ${targets.shellQuote(ep.actual)}`, undefined, signal);
		if (signal?.aborted) throw new Error("aborted");
		return readFileAsync(checkedPath(ep.actual, ep.allow));
	}

	async function writeCopyEndpoint(ep: CopyEndpoint, content: Buffer, signal?: AbortSignal): Promise<void> {
		if (ep.kind === "remote") await sshChecked(ep.cfg, `test -d ${targets.shellQuote(dirname(ep.actual))} && cat > ${targets.shellQuote(ep.actual)}`, content, signal);
		else if (ep.kind === "vm") await vmChecked(ep.targetId, `test -d ${targets.shellQuote(dirname(ep.actual))} && cat > ${targets.shellQuote(ep.actual)}`, content, signal);
		else {
			if (signal?.aborted) throw new Error("aborted");
			let real: string;
			try {
				lstatSync(ep.actual);
				real = checkedPath(ep.actual, ep.allow);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
				real = checkedNewPath(ep.actual, ep.allow);
			}
			await writeFileAsync(real, content);
		}
	}

	pi.registerTool({
		name: "copy",
		label: "Copy",
		description: "Copy a file or the contents of a directory between targets. Directory sources are copied rsync-style: the contents of sourcePath are copied into destPath. Requires read permission on non-SSH sources and write permission on non-SSH destinations; SSH sources/destinations require exec '*' on that SSH target. Existing files are not overwritten unless overwrite is true. SSH operations have a 5 minute per-command timeout.",
		promptSnippet: "Copy files/directories between targets with read permission on the source and write permission on the destination",
		parameters: Type.Object({
			sourceTarget: targetParam,
			sourcePath: Type.String({ description: "Source file or directory path on sourceTarget." }),
			destTarget: targetParam,
			destPath: Type.String({ description: "Destination path on destTarget. For directory sources, source contents are copied into this directory." }),
			overwrite: Type.Optional(Type.Boolean({ description: "Overwrite existing files. Defaults to false." })),
			maxEntries: Type.Optional(Type.Number({ description: "Maximum files/directories to copy before stopping. Defaults to 10000." })),
		}),
		renderCall(args: any, theme: any) {
			const source = `${args?.sourceTarget ?? "?"}:${args?.sourcePath ?? "?"}`;
			const dest = `${args?.destTarget ?? "?"}:${args?.destPath ?? "?"}`;
			const flags = [args?.overwrite ? "overwrite" : undefined, args?.maxEntries ? `max ${args.maxEntries}` : undefined].filter(Boolean).join(", ");
			const name = theme.fg("toolTitle", theme.bold?.("copy") ?? "copy");
			const line = `${name} ${theme.fg("toolOutput", source)} ${theme.fg("muted", "→")} ${theme.fg("toolOutput", dest)}${flags ? theme.fg("muted", ` (${flags})`) : ""}`;
			return { invalidate() {}, render: (width: number) => [truncateToWidth(line, width)] };
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			refreshSessionSystemPaths(ctx);
			const sourceTarget = target(params.sourceTarget);
			const destTarget = target(params.destTarget);
			let sourceDecision = params.sourcePath;
			let destDecision = params.destPath;
			try { sourceDecision = pathForFsDecision(sourceTarget, params.sourcePath, "read", ctx.cwd); } catch {}
			try { destDecision = pathForFsDecision(destTarget, params.destPath, "write", ctx.cwd); } catch {}

			if (!sourceTarget) {
				const g = guard("read", { target: params.sourceTarget, path: params.sourcePath }, sourceDecision);
				return bad(g.denial ? denialText({ ...g.denial, path: params.sourcePath }) : `Permission denied: there is no target named ${params.sourceTarget}.`);
			}
			if (!destTarget) {
				const g = guard("write", { target: params.destTarget, path: params.destPath }, destDecision);
				return bad(g.denial ? denialText({ ...g.denial, path: params.destPath }) : `Permission denied: there is no target named ${params.destTarget}.`);
			}
			if (sourceTarget.kind === "remote") {
				const denied = await approveSshFilesystem(ctx, sourceTarget, "read", params.sourcePath);
				if (denied) return bad(denied);
			} else {
				const hiddenSource = sourceTarget.kind === "local" ? systemAbsolutePath(sourceDecision, ctx.cwd, "read") : undefined;
				const sourceGuard: GuardResult = hiddenSource ? { t: sourceTarget } : guard("read", { target: params.sourceTarget, path: params.sourcePath }, sourceDecision);
				if (sourceGuard.denial) return bad(denialText({ ...sourceGuard.denial, path: params.sourcePath }));
				if (!(await approveAskScope(ctx, sourceGuard.t, "read", sourceDecision, params.sourcePath))) return bad(`Permission denied: reading ${params.sourcePath} was not approved.`);
			}
			if (destTarget.kind === "remote") {
				const denied = await approveSshFilesystem(ctx, destTarget, "write", params.destPath);
				if (denied) return bad(denied);
			} else {
				const hiddenDest = destTarget.kind === "local" ? systemAbsolutePath(destDecision, ctx.cwd, "write") : undefined;
				const destGuard: GuardResult = hiddenDest ? { t: destTarget } : guard("write", { target: params.destTarget, path: params.destPath }, destDecision);
				if (destGuard.denial) return bad(denialText({ ...destGuard.denial, path: params.destPath }));
				if (!(await approveAskScope(ctx, destGuard.t, "write", destDecision, params.destPath))) return bad(`Permission denied: writing ${params.destPath} was not approved.`);
			}

			const overwrite = params.overwrite ?? false;
			const maxEntries = Math.max(1, Math.min(Number(params.maxEntries ?? 10_000), 100_000));
			let files = 0;
			let dirs = 0;
			const countEntry = () => {
				if (files + dirs >= maxEntries) throw new Error(`copy stopped after ${maxEntries} entries; narrow the source or raise maxEntries`);
			};
			try {
				const srcRoot = locateCopyEndpoint(sourceTarget, params.sourcePath, "read", ctx.cwd);
				if (!(await existsCopyEndpoint(srcRoot, signal))) throw new Error(`source does not exist: ${params.sourcePath}`);
				if (await isSymlinkCopyEndpoint(srcRoot, signal)) throw new Error(`source is a symlink; copy refuses symlinks for consistent cross-target semantics: ${params.sourcePath}`);
				const copyFileTo = async (fromPath: string, toPath: string) => {
					countEntry();
					const from = locateCopyEndpoint(sourceTarget, fromPath, "read", ctx.cwd);
					if (await isSymlinkCopyEndpoint(from, signal)) throw new Error(`source is a symlink; copy refuses symlinks for consistent cross-target semantics: ${fromPath}`);
					if (!(await isFileCopyEndpoint(from, signal))) throw new Error(`source is not a regular file: ${fromPath}`);
					const to = locateCopyEndpoint(destTarget, toPath, "write", ctx.cwd);
					if (await existsCopyEndpoint(to, signal)) {
						if (await isSymlinkCopyEndpoint(to, signal)) throw new Error(`destination is a symlink; copy refuses symlinks for consistent cross-target semantics: ${toPath}`);
						if (await isDirCopyEndpoint(to, signal)) throw new Error(`destination is a directory: ${toPath}`);
						if (!overwrite) throw new Error(`destination exists (set overwrite=true to replace): ${toPath}`);
					}
					await writeCopyEndpoint(to, await readCopyEndpoint(from, signal), signal);
					files += 1;
				};
				const copyDirContents = async (fromDirPath: string, toDirPath: string) => {
					const fromDir = locateCopyEndpoint(sourceTarget, fromDirPath, "read", ctx.cwd);
					if (await isSymlinkCopyEndpoint(fromDir, signal)) throw new Error(`source is a symlink; copy refuses symlinks for consistent cross-target semantics: ${fromDirPath}`);
					const toDir = locateCopyEndpoint(destTarget, toDirPath, "write", ctx.cwd);
					if (await existsCopyEndpoint(toDir, signal)) {
						if (await isSymlinkCopyEndpoint(toDir, signal)) throw new Error(`destination is a symlink; copy refuses symlinks for consistent cross-target semantics: ${toDirPath}`);
						if (!(await isDirCopyEndpoint(toDir, signal))) throw new Error(`destination exists and is not a directory: ${toDirPath}`);
					}
					if (!(await existsCopyEndpoint(toDir, signal))) {
						countEntry();
						await mkdirCopyEndpoint(toDir, signal);
						dirs += 1;
					}
					for (const name of await listCopyEndpoint(fromDir, signal)) {
						const childFromPath = appendTargetPath(fromDirPath, name);
						const childToPath = appendTargetPath(toDirPath, name);
						const childFrom = locateCopyEndpoint(sourceTarget, childFromPath, "read", ctx.cwd);
						if (await isSymlinkCopyEndpoint(childFrom, signal)) throw new Error(`source is a symlink; copy refuses symlinks for consistent cross-target semantics: ${childFromPath}`);
						if (await isDirCopyEndpoint(childFrom, signal)) await copyDirContents(childFromPath, childToPath);
						else await copyFileTo(childFromPath, childToPath);
					}
				};
				if (await isDirCopyEndpoint(srcRoot, signal)) {
					if (sourceTarget.id === destTarget.id && isUnder(destDecision, sourceDecision)) {
						throw new Error("cannot copy a directory into itself or one of its descendants");
					}
					await copyDirContents(params.sourcePath, params.destPath);
				} else {
					if (!(await isFileCopyEndpoint(srcRoot, signal))) throw new Error(`source is not a regular file: ${params.sourcePath}`);
					const destRoot = locateCopyEndpoint(destTarget, params.destPath, "write", ctx.cwd);
					const finalDest = (await existsCopyEndpoint(destRoot, signal)) && (await isDirCopyEndpoint(destRoot, signal)) ? appendTargetPath(params.destPath, basename(params.sourcePath)) : params.destPath;
					await copyFileTo(params.sourcePath, finalDest);
				}
				const summary = `${files} file${files === 1 ? "" : "s"}${dirs ? `, ${dirs} director${dirs === 1 ? "y" : "ies"}` : ""}`;
				return ok(`Copied ${files} file${files === 1 ? "" : "s"}${dirs ? ` and created ${dirs} director${dirs === 1 ? "y" : "ies"}` : ""}.`, {
					display: `Copied ${summary}`,
				});
			} catch (err) {
				if (err instanceof DeniedError) return bad(`Permission denied: copy resolved to ${err.realPath}, which is outside the files and VMs added to this session.`);
				return bad(`copy failed: ${(err as Error).message}`);
			}
		},
		renderResult: renderDisplayResult,
	});

	function fsTool(
		verb: Exclude<Verb, "bash">,
		label: string,
		description: string,
		extra: Record<string, never> | object,
		run: (t: RunningTarget, params: any, ctx: ExtensionContext) => string,
	) {
		pi.registerTool({
			name: verb,
			label,
			description,
			parameters: Type.Object({ target: targetParam, path: Type.String(), ...extra }),
			async execute(_id, params: any, _signal, _onUpdate, ctx) {
				refreshSessionSystemPaths(ctx);
				const t0 = target(params.target);
				let pathForDecision = params.path;
				if (t0?.kind === "local") {
					try {
						pathForDecision = pathForLocalDecision(params.path, verb, ctx.cwd);
					} catch {
						// If the path cannot be resolved, fall back to the pure policy check
						// on the requested spelling. The filesystem operation will report
						// the concrete failure if the request is otherwise in scope.
					}
				} else if (t0) {
					pathForDecision = nfc(isAbsolute(params.path) ? params.path : resolve("/", params.path));
				}
				const hiddenRead = t0?.kind === "local" ? systemAbsolutePath(pathForDecision, ctx.cwd, verb) : undefined;
				const g = hiddenRead && t0 ? { t: t0 } : guard(verb, params, pathForDecision);
				if (g.denial) return bad(denialText({ ...g.denial, path: params.path }));
				if (!(await approveAskScope(ctx, g.t, verb, pathForDecision, params.path))) {
					return bad(`Permission denied: ${verb} was not approved for ${params.path}.`);
				}
				try {
					return ok(run(g.t, params, ctx));
				} catch (err) {
					if (err instanceof DeniedError) {
						return bad(
							`Permission denied: "${params.path}" resolved to ${err.realPath}, which is outside the files and VMs added to this session.`,
						);
					}
					return bad(`${verb} failed: ${(err as Error).message}`);
				}
			},
		});
	}

	fsTool("grep", "Grep", "Search file contents under a directory on a target. Output is truncated to 100 matches or 50KB.", {
		pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
		glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
		context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
	}, (t, p, ctx) => {
		const loc = locate(t, p.path, "grep", ctx.cwd);
		const re = p.literal ? undefined : new RegExp(p.pattern, p.ignoreCase ? "i" : undefined);
		const maxMatches = Math.max(1, Math.min(Number(p.limit ?? 100), 1000));
		const maxBytes = 50 * 1024;
		let bytes = 0;
		let matchCount = 0;
		let truncated = false;
		const hits: string[] = [];
		const pushHit = (hit: string, isMatch = true) => {
			if (isMatch) {
				if (matchCount >= maxMatches) {
					truncated = true;
					return;
				}
				matchCount++;
			}
			if (bytes >= maxBytes) {
				truncated = true;
				return;
			}
			const size = Buffer.byteLength(hit, "utf8") + 1;
			if (bytes + size > maxBytes) {
				truncated = true;
				return;
			}
			hits.push(hit);
			bytes += size;
		};
		const contextLines = Math.max(0, Number(p.context ?? 0));
		const formatPath = (file: string) => {
			const base = loc.kind === "host" ? checkedPath(loc.actual, loc.allow) : p.path;
			const rel = relative(base, file).split("/").join("/");
			return rel && !rel.startsWith("..") ? rel : basename(file);
		};
		const scan = (name: string, content: Buffer) => {
			const lines = content.toString("utf8").split("\n");
			lines.forEach((line, i) => {
				const haystack = p.ignoreCase ? line.toLowerCase() : line;
				const needle = p.ignoreCase ? p.pattern.toLowerCase() : p.pattern;
				if (p.literal ? haystack.includes(needle) : re!.test(line)) {
					if (matchCount >= maxMatches) {
						truncated = true;
						return;
					}
					matchCount++;
					const start = contextLines ? Math.max(0, i - contextLines) : i;
					const end = contextLines ? Math.min(lines.length - 1, i + contextLines) : i;
					for (let j = start; j <= end; j++) pushHit(`${name}${j === i ? ":" : "-"}${j + 1}${j === i ? ":" : "-"} ${(lines[j] ?? "").trim()}`, false);
				}
			});
		};
		if (loc.kind === "host") {
			const root = checkedPath(loc.actual, loc.allow);
			const args = ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
			if (p.ignoreCase) args.push("--ignore-case");
			if (p.literal) args.push("--fixed-strings");
			if (p.glob) args.push("--glob", p.glob);
			args.push("--max-count", String(maxMatches), "--", p.pattern, root);
			const rg = spawnSync("rg", args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 });
			if (!rg.error) {
				if (rg.status !== 0 && rg.status !== 1 && rg.signal !== "SIGTERM") throw new Error((rg.stderr || `ripgrep exited with ${rg.status}`).trim());
				if (contextLines > 0) {
					const files = new Set<string>();
					for (const line of rg.stdout.split("\n")) {
						if (!line.trim()) continue;
						let event: any;
						try { event = JSON.parse(line); } catch { continue; }
						if (event.type !== "match") continue;
						const file = event.data?.path?.text;
						if (file) files.add(file);
					}
					for (const file of files) {
						try {
							const { text } = readFileVerified(file, loc.allow, 256 * 1024);
							scan(formatPath(file), Buffer.from(text));
						} catch {}
					}
				} else {
					for (const line of rg.stdout.split("\n")) {
						if (!line.trim()) continue;
						let event: any;
						try { event = JSON.parse(line); } catch { continue; }
						if (event.type !== "match") continue;
						const file = event.data?.path?.text;
						const lineNumber = event.data?.line_number;
						const text = event.data?.lines?.text;
						if (!file || typeof lineNumber !== "number" || typeof text !== "string") continue;
						try { checkedPath(file, loc.allow); } catch { continue; }
						pushHit(`${formatPath(file)}:${lineNumber}: ${text.replace(/\r?\n$/, "").trim()}`);
					}
				}
			} else if ((rg.error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw rg.error;
			} else if (!statSync(root).isDirectory()) {
				const { text } = readFileVerified(root, loc.allow, 256 * 1024);
				scan(formatPath(root), Buffer.from(text));
			} else {
				walkVerified(root, loc.allow, (real, isDir) => {
					if (isDir || matchCount >= maxMatches || bytes >= maxBytes) return;
					try {
						const { text } = readFileVerified(real, loc.allow, 256 * 1024);
						scan(formatPath(real), Buffer.from(text));
					} catch {
						/* unreadable or denied — skip silently so it cannot be used as an oracle */
					}
				});
			}
		} else {
			for (const hit of targets.vmGrep(loc.targetId, loc.actual, p.pattern, maxMatches)) pushHit(hit);
		}
		const output = hits.join("\n") || "(no matches)";
		return truncated ? `${output}\n\n[Output truncated: showing at most ${maxMatches} matches or 50KB]` : output;
	});


	const bashRenderer = createBashToolDefinition("/", {
		exposeSessionEnvironment: false,
		operations: { exec: async () => ({ exitCode: 1 }) },
	});

	type BackgroundJob = {
		id: string;
		target: string;
		command: string;
		cwd: string;
		status: "running" | "done" | "failed" | "stopped";
		startedAt: number;
		updatedAt: number;
		exitCode?: number;
		error?: string;
		output: string;
		completionRead?: boolean;
		completionNotified?: boolean;
		controller: AbortController;
		remote?: RemoteSshJob;
	};
	const backgroundJobs = new Map<string, BackgroundJob>();
	idleStatusBridge().backgroundActiveCount = () => [...backgroundJobs.values()].filter((job) => job.status === "running").length;
	let backgroundUiCtx: ExtensionContext | undefined;
	const backgroundListeners = new Set<() => void>();
	const FOREGROUND_BASH_MAX_TIMEOUT_MS = 600_000;
	const backgroundId = () => `bg_${Math.random().toString(36).slice(2, 8)}`;
	function backgroundList() { return newestFirst(backgroundJobs.values(), (job) => job.startedAt); }
	function notifyBackgroundChanged() {
		for (const listener of backgroundListeners) listener();
		refreshBackgroundUi();
	}
	function notifyBackgroundCompletion(job: BackgroundJob) {
		if (job.status === "running" || job.completionNotified) return;
		job.completionNotified = true;
		const exit = job.exitCode === undefined ? "" : ` (exit ${job.exitCode})`;
		const statusLabel = job.status === "done" ? "finished" : job.status;
		try {
			pi.sendMessage({
				customType: "background.completion",
				display: true,
				content: `Background command ${job.id} ${statusLabel}${exit}.\n\nCommand: ${job.command}\n\nUse bg_status with id ${job.id} to view buffered output.`,
				details: { id: job.id, target: job.target, cwd: job.cwd, command: job.command, status: job.status, exitCode: job.exitCode, error: job.error },
			}, { triggerTurn: true, deliverAs: "followUp" });
		} catch {}
		const ctx = backgroundUiCtx;
		try {
			if (!ctx?.hasUI) return;
			const kind = job.status === "done" ? "info" : job.status === "stopped" ? "warning" : "error";
			ctx.ui.notify(`Background ${job.id} ${statusLabel}${exit}: ${job.command}`, kind);
		} catch {
			backgroundUiCtx = undefined;
		}
	}
	function setBackgroundContext(ctx: ExtensionContext) {
		backgroundUiCtx = ctx;
		refreshBackgroundUi();
	}
	function appendBackgroundOutput(job: BackgroundJob, chunk: unknown) {
		job.output = appendStreamingText(job.output, typeof chunk === "string" ? chunk : String(chunk));
		job.updatedAt = Date.now();
		notifyBackgroundChanged();
	}
	function renderBackgroundJob(job: BackgroundJob, tailChars = 8000) {
		const runtime = job.status === "running" ? `running for ${Math.max(0, Math.round((Date.now() - job.startedAt) / 1000))}s` : job.status;
		const exit = job.exitCode === undefined ? "" : ` exit=${job.exitCode}`;
		const header = `${job.id} [${runtime}${exit}] target=${job.target} cwd=${job.cwd}\n$ ${job.command}`;
		const output = job.output.length > tailChars ? `[output truncated: showing last ${tailChars} chars]\n${job.output.slice(-tailChars)}` : job.output;
		return `${header}\n\n${output || "(no output yet)"}${job.error ? `\n\nerror: ${job.error}` : ""}`;
	}
	function backgroundCompletionSummary(job: BackgroundJob) {
		const tail = job.output.split("\n").filter(Boolean).slice(-20).join("\n");
		return `${job.id} [${job.status}${job.exitCode === undefined ? "" : ` exit=${job.exitCode}`}] $ ${job.command}${tail ? `\n${tail}` : ""}${job.error ? `\nerror: ${job.error}` : ""}`;
	}
	function backgroundCompletionActivity(job: BackgroundJob) {
		return `${job.id} [${job.status}${job.exitCode === undefined ? "" : ` exit=${job.exitCode}`}] target=${job.target} cwd=${job.cwd} $ ${job.command}`;
	}
	function backgroundCompletionDisplay(job: BackgroundJob) {
		const tail = job.output.split("\n").filter(Boolean).slice(-20).join("\n");
		return `${job.id} [${job.status}${job.exitCode === undefined ? "" : ` exit=${job.exitCode}`}]\n$ ${job.command}${tail ? `\n${tail}` : ""}${job.error ? `\nerror: ${job.error}` : ""}`;
	}
	function renderDisplayResult(result: any) {
		const text = result.details?.display ?? result.content?.map((part: any) => part.text ?? "").join("\n") ?? "";
		return { invalidate() {}, render: (width: number) => text.split("\n").map((line: string) => truncateToWidth(line, width)) };
	}
	function unreadBackgroundCompletionJobs(markRead = false) {
		const jobs = backgroundList().filter((job) => job.status !== "running" && !job.completionRead);
		if (markRead) for (const job of jobs) job.completionRead = true;
		return jobs;
	}
	function unreadBackgroundCompletions(markRead = false) {
		return unreadBackgroundCompletionJobs(markRead).map(backgroundCompletionSummary);
	}
	function unreadBackgroundCompletionDisplays() {
		return unreadBackgroundCompletionJobs(false).map(backgroundCompletionDisplay);
	}
	function transitionBackgroundJob(job: BackgroundJob, status: BackgroundJob["status"]) {
		return transitionTaskStatus(job, status);
	}
	function finishBackgroundJob(job: BackgroundJob, exitCode: number | undefined) {
		job.exitCode = exitCode;
		transitionBackgroundJob(job, exitCode === 0 || exitCode === undefined ? "done" : "failed");
		notifyBackgroundCompletion(job);
		notifyBackgroundChanged();
	}
	function failBackgroundJob(job: BackgroundJob, error: unknown) {
		job.error = error instanceof Error ? error.message : String(error);
		transitionBackgroundJob(job, "failed");
		notifyBackgroundCompletion(job);
		notifyBackgroundChanged();
	}
	async function syncRemoteBackgroundJob(job: BackgroundJob, tailChars = 8000) {
		if (!job.remote || job.status !== "running") return;
		const cfg = sshConfig(job.target);
		if (!cfg) return;
		const remote = await targets.remoteJobStatus(cfg, job.remote, tailChars);
		job.output = remote.output;
		job.error = remote.error;
		job.exitCode = remote.exitCode;
		if (remote.status === "done") transitionBackgroundJob(job, "done");
		else if (remote.status === "failed" || remote.status === "killed") transitionBackgroundJob(job, "failed");
		else if (remote.status === "running" || remote.status === "starting") transitionBackgroundJob(job, "running");
		else {
			job.error = remote.error ?? remote.status;
			job.updatedAt = Date.now();
		}
		notifyBackgroundCompletion(job);
	}
	async function stopBackgroundJob(job: BackgroundJob) {
		if (job.status === "running") {
			if (job.remote) {
				const cfg = sshConfig(job.target);
				if (cfg) {
					try { await targets.stopRemoteJob(cfg, job.remote); }
					catch (err) { job.error = err instanceof Error ? err.message : String(err); }
				}
			}
			job.controller.abort();
			transitionBackgroundJob(job, "stopped");
			notifyBackgroundCompletion(job);
			notifyBackgroundChanged();
		}
	}
	function refreshBackgroundUi() {
		const ctx = backgroundUiCtx;
		try { if (!ctx?.hasUI) return; } catch { backgroundUiCtx = undefined; return; }
		const jobs = backgroundList();
		const running = jobs.filter((job) => job.status === "running").length;
		if (jobs.length === 0) {
			ctx.ui.setStatus("background", undefined);
			ctx.ui.setWidget("background", undefined);
			return;
		}
		ctx.ui.setStatus("background", ctx.ui.theme.fg("accent", `bg ${running}/${jobs.length}`));
		ctx.ui.setWidget("background", (_tui, theme) => ({
			render: (width) => {
				const counts = {
					running,
					done: jobs.filter((job) => job.status === "done").length,
					failed: jobs.filter((job) => job.status === "failed" || job.status === "stopped").length,
				};
				const parts = [
					theme.fg("accent", `[${jobs.length} bg]`),
					counts.running ? theme.fg("accent", `[● ${counts.running}]`) : undefined,
					counts.done ? theme.fg("success", `[✓ ${counts.done}]`) : undefined,
					counts.failed ? theme.fg("error", `[✗ ${counts.failed}]`) : undefined,
					theme.fg("dim", "[/background]"),
				].filter((part): part is string => part !== undefined);
				return [truncateToWidth(parts.join(" "), width)];
			},
			invalidate: () => {},
		}), { placement: "belowEditor" });
	}

	class BackgroundPanel implements Component, Focusable {
		private selected = 0;
		private scrollOffset = 0;
		private unsubscribe: () => void;
		focused = false;
		constructor(private tui: TUI, private ctx: ExtensionContext, private keybindings: { matches(data: string, action: string): boolean }, private done: () => void) {
			this.unsubscribe = () => backgroundListeners.delete(this.renderListener);
			backgroundListeners.add(this.renderListener);
		}
		private renderListener = () => this.tui.requestRender();
		dispose() { this.unsubscribe(); }
		invalidate() {}
		handleInput(data: string) {
			const jobs = backgroundList();
			if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) return this.done();
			const stopSelected = data === "\x04" || this.keybindings.matches(data, "tui.input.deleteForward");
			if (stopSelected) { const job = jobs[this.selected]; if (job) stopBackgroundJob(job); this.tui.requestRender(); return; }
			if (this.keybindings.matches(data, "tui.select.up")) { this.selected = Math.max(0, this.selected - 1); this.scrollOffset = 0; }
			else if (this.keybindings.matches(data, "tui.select.down")) { this.selected = Math.min(Math.max(0, jobs.length - 1), this.selected + 1); this.scrollOffset = 0; }
			else if (matchesKey(data, "shift+tab")) { this.selected = jobs.length === 0 ? 0 : (this.selected + jobs.length - 1) % jobs.length; this.scrollOffset = 0; }
			else if (this.keybindings.matches(data, "tui.input.tab")) { this.selected = jobs.length === 0 ? 0 : (this.selected + 1) % jobs.length; this.scrollOffset = 0; }
			else if (this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.altScreen.pageUp")) this.scrollOffset += 10;
			else if (this.keybindings.matches(data, "tui.select.pageDown") || this.keybindings.matches(data, "tui.altScreen.pageDown")) this.scrollOffset = Math.max(0, this.scrollOffset - 10);
			else if (this.keybindings.matches(data, "tui.altScreen.bottom")) this.scrollOffset = 0;
			this.tui.requestRender();
		}
		render(width: number): string[] {
			const jobs = backgroundList();
			const innerWidth = Math.max(1, width - 4);
			const bodyHeight = 30;
			const lines: string[] = [];
			if (jobs.length === 0) {
				lines.push("No background commands. Use bg_start from the agent.");
			} else {
				const tabs = jobs.map((job, i) => {
					const marker = job.status === "running" ? "●" : job.status === "done" ? "✓" : "✗";
					const label = `${marker} ${job.id}`;
					return i === this.selected ? this.ctx.ui.theme.bg("selectedBg", this.ctx.ui.theme.fg("accent", ` ${label} `)) : this.ctx.ui.theme.fg("dim", ` ${label} `);
				});
				const { start, end } = visibleWindowAroundSelected({
					count: tabs.length,
					selected: this.selected,
					maxWidth: innerWidth,
					itemWidth: (i) => visibleWidth(tabs[i] ?? ""),
				});
				const tabsLine = `${start > 0 ? "‹ " : ""}${tabs.slice(start, end).join(" ")}${end < tabs.length ? " ›" : ""}`;
				lines.push(truncateToWidth(tabsLine, innerWidth));
				lines.push("═".repeat(innerWidth));
				const job = jobs[this.selected];
				if (job) {
					lines.push(this.ctx.ui.theme.fg("accent", `${job.id}`) + this.ctx.ui.theme.fg("dim", `  ${job.status} · ${job.target} · ${job.cwd}`));
					lines.push(this.ctx.ui.theme.fg("dim", `$ ${truncateToWidth(job.command, Math.max(1, innerWidth - 2))}`));
					lines.push("");
					const logLines = renderBackgroundJob(job, 40_000).split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", innerWidth).map((wrapped) => truncateToWidth(wrapped, innerWidth)));
					const maxLogLines = Math.max(4, bodyHeight - lines.length - 2);
					if (logLines.length > maxLogLines) {
						const viewportLines = Math.max(1, maxLogLines - 1);
						const maxOffset = Math.max(0, logLines.length - viewportLines);
						this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
						const end = logLines.length - this.scrollOffset;
						const start = Math.max(0, end - viewportLines);
						lines.push(this.ctx.ui.theme.fg("dim", this.scrollOffset ? `↑ ${start} earlier • ↓ ${logLines.length - end} later` : `… ${start} earlier lines hidden`));
						lines.push(...logLines.slice(start, end));
					} else {
						this.scrollOffset = 0;
						lines.push(...logLines);
					}
				}
			}
			while (lines.length < bodyHeight - 1) lines.push("");
			if (lines.length > bodyHeight - 1) lines.splice(0, lines.length - (bodyHeight - 1), this.ctx.ui.theme.fg("dim", "… earlier panel content hidden"));
			lines.push(this.ctx.ui.theme.fg("dim", "ctrl-d stop selected • pageUp/pageDown scroll • tab/shift-tab job • esc close"));
			return borderedPlain(lines, width, "background commands", (text) => this.ctx.ui.theme.fg("accent", text));
		}
	}

	const baseBashRenderCall = bashRenderer.renderCall;
	// prepareArguments is typed against the base bash schema ({ command, timeout }),
	// which does not include our target param. Drop it rather than inherit a shim
	// that would strip target if the base tool ever defines one.
	const { prepareArguments: _prepareBashArguments, ...bashRendererShared } = bashRenderer;
	pi.registerTool({
		...bashRendererShared,
		name: "bash",
		label: "Bash",
		description:
			"Run a shell command on a target with exec enabled. Foreground commands have a maximum runtime of 10 minutes; use bg_start for longer-running work. The target may be local or VM-backed; inspect capabilities when unsure which targets are available.",
		promptGuidelines: ["bash requires a running target with exec enabled. Use the targets listed by capabilities; if none has exec, create/start a VM or ask the user to provide an exec target.", "Foreground bash commands time out after at most 10 minutes. Requests for longer timeouts are rejected; use bg_start for commands that may run longer.", "Background commands continue after your turn ends. When a background command finishes or needs attention, Pi will add a follow-up message and give you another turn; do not poll to find out whether it finished."],
		parameters: Type.Object({
			target: targetParam,
			command: Type.String(),
			timeoutMs: Type.Optional(Type.Number({ description: `Timeout in milliseconds. Defaults to ${FOREGROUND_BASH_MAX_TIMEOUT_MS}ms (10 minutes). Values above this are rejected; use bg_start for longer-running commands.` })),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			if (params.timeoutMs !== undefined && params.timeoutMs > FOREGROUND_BASH_MAX_TIMEOUT_MS) {
				return bad(`Foreground bash timeout ${params.timeoutMs}ms exceeds the 10 minute maximum (${FOREGROUND_BASH_MAX_TIMEOUT_MS}ms). Use bg_start for commands that may run longer, then continue other work until its completion notification or inspect it with bg_status or bg_list.`);
			}
			const timeoutMs = Math.max(params.timeoutMs ?? FOREGROUND_BASH_MAX_TIMEOUT_MS, 1);
			const g = await guardBash(ctx, params);
			if (g.denial) return bad(denialText(g.denial));
			if (g.t.kind === "remote") {
				const cfg = sshConfig(g.t.id);
				if (!cfg) return bad(`ssh target not found: ${g.t.id}`);
				const jobId = backgroundId();
				const cwd = "/";
				let output = "";
				try {
					const remote = await targets.launchRemoteJob(cfg, jobId, params.command, cwd);
					const append = (chunk: Buffer) => {
						output = appendStreamingText(output, chunk.toString());
						onUpdate?.(ok(output) as any);
					};
					const result = await targets.followRemoteJob(cfg, remote, { signal, timeoutMs, onData: append });
					const suffix = result.exitCode === undefined || result.exitCode === 0 ? "" : `\n\n[ssh ${g.t.id} exited ${result.exitCode}]`;
					return ok(`${output}${suffix}` || "(no output)") as any;
				} catch (err) {
					if (err instanceof SshJobContinuesError) {
						const job: BackgroundJob = { id: jobId, target: g.t.id, command: params.command, cwd, status: "running", startedAt: Date.now(), updatedAt: Date.now(), output, controller: new AbortController(), remote: err.remote };
						backgroundJobs.set(job.id, job);
						notifyBackgroundChanged();
						return ok(`SSH connection ended while waiting; command continues as background job ${job.id}.`, { display: `Continues as ${job.id} [running] target=${job.target}` }) as any;
					}
					return bad(`ssh bash failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			const operations: BashOperations = {
				exec: (command, cwd, options) => {
					const opts = {
						cwd,
						onData: options.onData,
						signal: options.signal,
						timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1000,
						timeoutLabel: options.timeout === undefined ? undefined : String(options.timeout),
					};
					return g.t.kind === "local" ? targets.localExecStream(command, opts) : targets.execStream(g.t.id, command, opts);
				},
			};
			const base = createBashToolDefinition(g.t.kind === "local" ? ctx.cwd : "/", { operations, exposeSessionEnvironment: false });
			try {
				return await base.execute(id, { command: params.command, timeout: timeoutMs / 1000 }, signal, onUpdate, ctx);
			} catch (err) {
				return bad((err as Error).message);
			}
		},
		...(baseBashRenderCall && {
			renderCall(args: { target: string; command: string; timeoutMs?: number }, theme: Parameters<typeof baseBashRenderCall>[1], context: Parameters<typeof baseBashRenderCall>[2]) {
				const { target: _target, timeoutMs, ...inner } = args ?? {};
				return baseBashRenderCall({ ...inner, timeout: timeoutMs === undefined ? undefined : timeoutMs / 1000 }, theme, context);
			},
		}),
		renderResult: bashRenderer.renderResult,
	});

	pi.registerTool({
		name: "bg_start",
		label: "Start Background Command",
		description: "Start a shell command on an executable target and return immediately. Use /background for live output, bg_list to inspect the completion mailbox, bg_status only for deliberate output inspection, and bg_stop to stop it.",
		promptSnippet: "bg_start: run a long command in the background on an exec-enabled target",
		promptGuidelines: ["Use bg_start for long-running commands such as dev servers, watchers, and test loops.", "After bg_start, continue only with concrete independent work. If the next step depends on the command finishing or producing output, end your turn; Pi will add a follow-up message and give you another turn when there is completion/activity to handle.", "Do not poll bg_status/bg_list by reflex. Use bg_list for occasional orientation, bg_status only for deliberate output inspection, or /background for live output.", "If you start a background command only for the task, stop it with bg_stop when it is no longer needed unless the user asked to keep it running."],
		parameters: Type.Object({
			target: targetParam,
			command: Type.String(),
			cwd: Type.Optional(Type.String({ description: "Working directory inside the target. Defaults to /." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Optional maximum runtime in milliseconds." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const g = await guardBash(ctx, params);
			if (g.denial) return bad(denialText(g.denial));
			const sshCfg = g.t.kind === "remote" ? sshConfig(g.t.id) : undefined;
			if (g.t.kind === "remote" && !sshCfg) return bad(`ssh target not found: ${g.t.id}`);
			const job: BackgroundJob = {
				id: backgroundId(),
				target: g.t.id,
				command: params.command,
				cwd: params.cwd ?? (g.t.kind === "local" ? ctx.cwd : "/"),
				status: "running",
				startedAt: Date.now(),
				updatedAt: Date.now(),
				output: "",
				controller: new AbortController(),
			};
			backgroundJobs.set(job.id, job);
			notifyBackgroundChanged();
			if (g.t.kind === "remote") {
				const cfg = sshCfg!;
				try {
					job.remote = await targets.launchRemoteJob(cfg, job.id, params.command, job.cwd);
				} catch (err) {
					backgroundJobs.delete(job.id);
					notifyBackgroundChanged();
					return bad(`ssh bg_start failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				void targets.followRemoteJob(cfg, job.remote, {
					signal: job.controller.signal,
					timeoutMs: params.timeoutMs,
					onData: (chunk) => appendBackgroundOutput(job, chunk),
				}).then((result) => {
					if (job.status === "stopped") return;
					finishBackgroundJob(job, result.exitCode);
				}).catch((error: unknown) => {
					if (job.status === "stopped") return;
					if (error instanceof SshJobContinuesError) {
						job.error = error.message;
						transitionBackgroundJob(job, "running");
						notifyBackgroundChanged();
					} else {
						failBackgroundJob(job, error);
					}
				});
			} else {
				const runBackground = g.t.kind === "local" ? targets.localExecStream.bind(targets) : targets.execStream.bind(targets, g.t.id);
				void runBackground(params.command, {
					cwd: job.cwd,
					signal: job.controller.signal,
					timeoutMs: params.timeoutMs,
					timeoutLabel: params.timeoutMs === undefined ? undefined : String(params.timeoutMs / 1000),
					onData: (chunk: unknown) => appendBackgroundOutput(job, chunk),
				}).then((result: any) => {
					if (job.status === "stopped") return;
					finishBackgroundJob(job, typeof result?.exitCode === "number" ? result.exitCode : undefined);
				}).catch((error: unknown) => {
					if (job.status === "stopped") return;
					failBackgroundJob(job, error);
				});
			}
			return ok(
				`Started background command ${job.id} on ${job.target}. Use /background for live output or bg_list for mailbox/status inspection; completion notification will arrive asynchronously. Avoid polling bg_status.`,
				{ display: `Started ${job.id} [running] target=${job.target} cwd=${job.cwd}` },
			);
		},
		...(baseBashRenderCall && {
			renderCall(args: { target: string; command: string; cwd?: string; timeoutMs?: number }, theme: Parameters<typeof baseBashRenderCall>[1], context: Parameters<typeof baseBashRenderCall>[2]) {
				return baseBashRenderCall({ command: args?.command ?? "", timeout: args?.timeoutMs === undefined ? undefined : args.timeoutMs / 1000 }, theme, context);
			},
		}),
		renderResult: renderDisplayResult,
	});

	pi.registerTool({
		name: "bg_list",
		label: "List Background Commands",
		description: "List live/retained background commands and compact unread completion mailbox items. Prefer this over bg_status unless you need a specific command's buffered output.",
		promptGuidelines: ["Use bg_list for occasional orientation only. Do not poll; when a background command finishes or needs attention, Pi will add a follow-up message and give you another turn.", "If there is no independent work to do while background work runs, end your turn instead of checking status repeatedly."],
		parameters: Type.Object({
			includeRead: Type.Optional(Type.Boolean({ description: "Include completions already marked read in the listing. Defaults to true." })),
			markRead: Type.Optional(Type.Boolean({ description: "Mark unread completion mailbox items read. Defaults to false." })),
		}),
		renderCall(args: any, theme: any) {
			return toolCallLine(["bg_list", args?.includeRead === false ? "unread" : undefined, args?.markRead ? "mark-read" : undefined], theme);
		},
		async execute(_id, params) {
			for (const job of backgroundJobs.values()) if (job.remote) await syncRemoteBackgroundJob(job, 2000);
			const jobs = backgroundList();
			const includeRead = params.includeRead ?? true;
			const listed = includeRead ? jobs : jobs.filter((job) => job.status === "running" || !job.completionRead);
			const lines = listed.length
				? listed.map((job) => `${job.id} [${job.status}${job.exitCode === undefined ? "" : ` exit=${job.exitCode}`}${job.completionRead ? ", read" : ""}] target=${job.target} cwd=${job.cwd} $ ${job.command}`)
				: ["No background commands."];
			const unread = unreadBackgroundCompletionJobs(params.markRead ?? false).map(backgroundCompletionActivity);
			const message = unread.length
				? `${lines.join("\n")}\n\nUnread completion mailbox:\n${unread.join("\n")}`
				: lines.join("\n");
			return ok(message);
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background Command Status",
		description: "Show status and buffered output for background commands. Use only for deliberate inspection of a specific job's output; never use it as a progress poll.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Background job id. Required for output inspection; omit only to get guidance to use bg_list." })),
			tailChars: Type.Optional(Type.Number({ description: "Maximum output chars to return for one job. Defaults to 8000." })),
		}),
		renderCall(args: any, theme: any) {
			return toolCallLine(["bg_status", args?.id, args?.tailChars ? `tail=${args.tailChars}` : undefined], theme);
		},
		async execute(_id, params) {
			if (!params.id) {
				return ok("bg_status is for deliberate inspection of one job's buffered output. Pass an id, or use bg_list for compact mailbox/status inspection.");
			}
			const job = backgroundJobs.get(params.id);
			if (!job) return bad(`Unknown background command: ${params.id}`);
			if (job.remote) await syncRemoteBackgroundJob(job, params.tailChars ?? 2000);
			return ok(renderBackgroundJob(job, params.tailChars ?? 2000));
		},
	});

	pi.registerTool({
		name: "bg_stop",
		label: "Stop Background Command",
		description: "Stop a running background command.",
		parameters: Type.Object({ id: Type.String({ description: "Background job id." }) }),
		renderCall(args: any, theme: any) {
			return toolCallLine(["bg_stop", args?.id], theme);
		},
		async execute(_id, params) {
			const job = backgroundJobs.get(params.id);
			if (!job) return bad(`Unknown background command: ${params.id}`);
			if (job.status === "running") await stopBackgroundJob(job);
			return ok(renderBackgroundJob(job, 4000));
		},
	});

	// ------------------------------------------------------------- commands

	function isModeToken(s: string | undefined): s is ScopeMode | "ask" {
		return s === "ro" || s === "rw" || s === "ask" || s === "ask-ro" || s === "ask-rw" || s === "ro-ask-rw" || s === "deny";
	}

	function parseMode(s: string | undefined, fallback: ScopeMode): ScopeMode {
		if (s === "ask") return "ask-ro";
		return s === "ro" || s === "rw" || s === "ask-ro" || s === "ask-rw" || s === "ro-ask-rw" || s === "deny" ? s : fallback;
	}

	function isExecMode(s: string | undefined): s is "ask" | "allow" {
		return s === "ask" || s === "allow";
	}

	function parseNetworkMode(s: string | undefined): State["network"] {
		if (s === "allow" || s === "ask" || s === "deny") return s;
		return "allow";
	}

	function canonicalExistingPath(cwd: string, what: string): { requested: string; real: string } {
		const requested = nfc(resolve(cwd, expandUser(what)));
		return { requested, real: resolveReal(requested) };
	}

	function parseSshDestination(spec: string): { destination: string; port?: number } {
		const m = spec.match(/^(.+):(\d+)$/);
		const destination = m?.[1] ?? spec;
		const port = m?.[2] === undefined ? undefined : Number(m[2]);
		if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) throw new Error("SSH port must be an integer from 1 to 65535");
		return { destination, port };
	}

	async function offerRestartWithoutNetwork(ctx: ExtensionContext, vmIds?: Set<string>): Promise<string> {
		const runningTargets = state.targets.filter((t) => t.network && t.vm && (!vmIds || vmIds.has(t.vm.id)));
		if (!runningTargets.length) return "";
		const okToRestart = await ask(ctx, {
			operation: "Restart running networked VM target(s) without network now?",
			detail: runningTargets.map((t) => t.id),
			onDecline: "network remains active in already-running targets until they are stopped",
		});
		if (!okToRestart) return "\nExisting networked target(s) were left running; stop/restart them to drop network.";
		const restarted: string[] = [];
		for (const t of runningTargets) {
			const vmId = t.vm?.id;
			if (!vmId) continue;
			await targets.stop(t.id);
			state.targets = state.targets.filter((x) => x.id !== t.id);
			refreshSessionSystemPaths(ctx);
			const run = await targets.start(vmId, { mounts: mountsForCurrentScopes(), network: false });
			state.targets.push(run);
			restarted.push(run.id);
		}
		return restarted.length ? `\nRestarted without network: ${restarted.join(", ")}` : "";
	}

	function permsText(): string {
		const verbs = availableVerbs(state).filter((v) => IMPLEMENTED.includes(v));
		return [
			"files:",
			state.scopes.length ? state.scopes.map((s) => `  ${s.mode.padEnd(6)} ${s.path}`).join("\n") : "  (no directories added)",
			`network: ${state.network ?? "deny"}`,
			"vms:",
			state.vms.length ? state.vms.map((v) => {
				const run = state.targets.find((t) => t.vm?.id === v.vmId);
				return `  ${v.mode.padEnd(6)} ${v.vmId}${v.network ? " [network]" : ""} ${run ? "running" : "stopped"}`;
			}).join("\n") : "  (no vms added)",
			"ssh targets:",
			state.sshTargets.length ? state.sshTargets.map((s) => `  ${s.id} ${s.destination}${s.port !== undefined ? `:${s.port}` : ""}`).join("\n") : "  (no ssh targets added)",
			"exec grants:",
			state.execGrants.length ? state.execGrants.map((g) => `  ${g.mode.padEnd(5)} ${g.target} ${g.command}`).join("\n") : "  (no exec grants added)",
			`tools: ${mergedActiveToolNames().join(", ") || "(none)"}`
		].join("\n");
	}

	function permissionsUsage(): string {
		return [
			"usage:",
			"  /permissions list",
			"  /permissions add network <ask|allow>",
			"  /permissions remove network",
			"  /permissions add file [ro|rw|ask-ro|ask-rw|ro-ask-rw|deny] <path>",
			"  /permissions add vm [ro|rw|ask-ro|ask-rw|ro-ask-rw|deny] <id> [network]",
			"  /permissions add vm network <id>",
			"  /permissions add ssh <id> <destination[:port]>",
			"  /permissions remove file <path>",
			"  /permissions remove vm <id>",
			"  /permissions remove vm network <id>",
			"  /permissions remove ssh <id>",
			"  /permissions add exec <ask|allow> <target> <command|*>",
			"  /permissions remove exec <target> <command|*>",
			"  /permissions deny file <path>",
		].join("\n");
	}

	function permissionCompletions(argumentPrefix: string) {
		const trailingSpace = /\s$/.test(argumentPrefix);
		const tokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);
		const current = trailingSpace ? "" : (tokens.pop() ?? "");
		const before = tokens.length ? `${tokens.join(" ")} ` : "";
		const item = (value: string, description?: string, label = value) => ({ value: `${before}${value}`, label, description });
		const filter = (items: ReturnType<typeof item>[]) => {
			const out = items.filter((i) => i.label.startsWith(current) || i.value.slice(before.length).startsWith(current));
			return out.length ? out : null;
		};
		const action = tokens[0];
		const kind = tokens[1];
		if (tokens.length === 0) return filter([
			item("list", "show current permissions"),
			item("add", "add a session permission"),
			item("remove", "remove a session permission"),
			item("deny", "deny a file path"),
		]);
		if (tokens.length === 1) {
			if (action === "add") return filter([item("file", "grant a file or directory"), item("vm", "grant a VM"), item("ssh", "add an SSH target"), item("network", "grant network"), item("exec", "grant command execution")]);
			if (action === "remove") return filter([item("file", "remove a file grant"), item("vm", "remove a VM grant"), item("ssh", "remove an SSH target"), item("network", "remove network"), item("exec", "remove an exec grant")]);
			if (action === "deny") return filter([item("file", "deny a file path")]);
			return null;
		}
		if (action === "add" && kind === "network") return filter([item("ask", "ask before network use"), item("allow", "allow network use")]);
		if (action === "add" && kind === "file" && tokens.length === 2) return filter([item("ro", "read-only"), item("rw", "read-write"), item("ask-ro", "ask before reads"), item("ask-rw", "ask before reads/writes"), item("ro-ask-rw", "read now, ask before writes")]);
		if (action === "add" && kind === "vm" && tokens.length === 2) return filter([item("ro", "read-only VM"), item("rw", "read-write VM"), item("ask-ro", "ask before VM reads"), item("ask-rw", "ask before VM reads/writes"), item("ro-ask-rw", "read VM now, ask before writes"), item("network", "allow network for this VM")]);
		if (kind === "vm" && (tokens.length === 2 || tokens.length === 3)) {
			const vmIds = new Set([...state.vms.map((v) => v.vmId), ...targets.listVms().map((v) => v.id)]);
			return filter([...vmIds].sort().map((id) => item(id, "VM id")));
		}
		if (action === "add" && kind === "exec" && tokens.length === 2) return filter([item("ask", "ask before executing matching command"), item("allow", "allow matching command")]);
		if (action === "add" && kind === "exec" && tokens.length === 3) return filter(state.targets.map((t) => item(t.id, "target id")));
		if (kind === "ssh" && action === "remove" && tokens.length === 2) return filter(state.sshTargets.map((s) => item(s.id, "SSH target")));
		if (action === "remove" && kind === "vm" && tokens.length >= 3) return filter([item("network", "remove VM-specific network permission")]);
		return null;
	}

	pi.registerCommand("permissions", {
		description: "Manage session permissions: /permissions add file rw <path> | /permissions add exec ask local <command> | /permissions list",
		getArgumentCompletions: permissionCompletions,
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const [action, kind, ...rest] = parts;
			if (!action || action === "list" || action === "show") return ctx.ui.notify(permsText(), "info");

			if (action !== "add" && action !== "remove" && action !== "deny") {
				return ctx.ui.notify(permissionsUsage(), "warning");
			}
			if (kind !== "file" && kind !== "vm" && kind !== "ssh" && kind !== "network" && kind !== "exec") return ctx.ui.notify(permissionsUsage(), "warning");
			if (action === "deny" && kind !== "file") return ctx.ui.notify("usage: /permissions deny file <path>", "warning");

			if (kind === "network") {
				if (action === "add") state.network = parseNetworkMode(rest[0]);
				else state.network = "deny";
				let note = "";
				if (action === "remove") {
					try {
						note = await offerRestartWithoutNetwork(ctx);
					} catch (err) {
						note = `\nCould not restart networked targets: ${(err as Error).message}`;
					}
				}
				savePermissionsState(ctx);
				syncTools();
				return ctx.ui.notify(`${action === "add" ? "Added" : "Removed"} network permission${action === "add" ? ` (${state.network})` : ""}.${note}\n${permsText()}`, "info");
			}

			if (kind === "ssh") {
				if (action === "deny") return ctx.ui.notify(permissionsUsage(), "warning");
				if (action === "add") {
					const [id, destinationSpec, extra] = rest;
					if (!id || !destinationSpec || extra) return ctx.ui.notify(permissionsUsage(), "warning");
					let sshId: string;
					try { sshId = normalizeVmId(id); }
					catch (err) { return ctx.ui.notify((err as Error).message, "warning"); }
					let parsed: { destination: string; port?: number };
					try { parsed = parseSshDestination(destinationSpec); }
					catch (err) { return ctx.ui.notify((err as Error).message, "warning"); }
					if (target(sshId) && !sshConfig(sshId)) return ctx.ui.notify(`Target ${sshId} already exists.`, "warning");
					if (state.network === "deny") return ctx.ui.notify("SSH targets require network permission. Use /permissions add network ask|allow first.", "warning");
					const ssh = { id: sshId, ...parsed } satisfies SshTarget;
					try { await targets.probeRemote(ssh); }
					catch (err) { return ctx.ui.notify(`SSH target rejected: ${err instanceof Error ? err.message : String(err)}`, "warning"); }
					state.sshTargets = state.sshTargets.filter((s) => s.id !== sshId);
					state.sshTargets.push(ssh);
				targets.configureRemote(ssh);
					state.targets = state.targets.filter((t) => t.id !== sshId);
					state.targets.push(sshRunningTarget(ssh));
					savePermissionsState(ctx);
					syncTools();
					return ctx.ui.notify(`Added SSH target ${sshId} (${parsed.destination}${parsed.port !== undefined ? `:${parsed.port}` : ""}).\n${permsText()}`, "info");
				}
				const [id] = rest;
				if (!id) return ctx.ui.notify(permissionsUsage(), "warning");
				let sshId: string;
				try { sshId = normalizeVmId(id); }
				catch (err) { return ctx.ui.notify((err as Error).message, "warning"); }
				state.sshTargets = state.sshTargets.filter((s) => s.id !== sshId);
				targets.removeRemote(sshId);
				state.targets = state.targets.filter((t) => t.id !== sshId);
				state.execGrants = state.execGrants.filter((g) => g.target !== sshId);
				savePermissionsState(ctx);
				syncTools();
				return ctx.ui.notify(`Removed SSH target ${sshId}.\n${permsText()}`, "info");
			}

			if (kind === "vm") {
				const networkOnly = rest[0] === "network";
				const id = networkOnly ? rest[1] : isModeToken(rest[0]) ? rest[1] : rest[0];
				if (!id) return ctx.ui.notify(permissionsUsage(), "warning");
				let vmId: string;
				try { vmId = normalizeVmId(id); }
				catch (err) { return ctx.ui.notify((err as Error).message, "warning"); }
				const existing = vmScope(state, vmId);

				if (action === "add") {
					const mode = networkOnly && existing ? existing.mode : parseMode(networkOnly ? undefined : rest[0], "ro");
					const network = networkOnly || rest.includes("network") || existing?.network;
					state.vms = state.vms.filter((v) => v.vmId !== vmId);
					state.vms.push({ vmId, mode, network });
					savePermissionsState(ctx);
					syncTools();
					return ctx.ui.notify(`Added VM ${vmId}${network ? " with network permission" : ""}.\n${permsText()}`, "info");
				}

				if (networkOnly && existing) {
					state.vms = state.vms.map((v) => (v.vmId === vmId ? { ...v, network: false } : v));
					let note = "";
					try {
						note = await offerRestartWithoutNetwork(ctx, new Set([vmId]));
					} catch (err) {
						note = `\nCould not restart networked target: ${(err as Error).message}`;
					}
					savePermissionsState(ctx);
					syncTools();
					return ctx.ui.notify(`Removed network permission for VM ${vmId}.${note}\n${permsText()}`, "info");
				}

				state.vms = state.vms.filter((v) => v.vmId !== vmId);
				savePermissionsState(ctx);
				syncTools();
				return ctx.ui.notify(`Removed VM ${vmId}.\n${permsText()}`, "info");
			}

			if (kind === "exec") {
				if (action === "deny") return ctx.ui.notify(permissionsUsage(), "warning");
				if (action === "add") {
					const m = args.match(/^\s*add\s+exec\s+(ask|allow)\s+(\S+)\s+([\s\S]+)$/);
					if (!m) return ctx.ui.notify(permissionsUsage(), "warning");
					const [, mode, targetId, command] = m;
					if (!isExecMode(mode) || !targetId || !command) return ctx.ui.notify(permissionsUsage(), "warning");
					state.execGrants = state.execGrants.filter((g) => !(g.target === targetId && g.command === command));
					state.execGrants.push({ target: targetId, command, mode });
					savePermissionsState(ctx);
					syncTools();
					return ctx.ui.notify(`Added exec permission (${mode}) for ${targetId}: ${command}\n${permsText()}`, "info");
				}
				const m = args.match(/^\s*remove\s+exec\s+(\S+)\s+([\s\S]+)$/);
				if (!m) return ctx.ui.notify(permissionsUsage(), "warning");
				const [, targetId, command] = m;
				if (!targetId || !command) return ctx.ui.notify(permissionsUsage(), "warning");
				state.execGrants = state.execGrants.filter((g) => !(g.target === targetId && g.command === command));
				savePermissionsState(ctx);
				syncTools();
				return ctx.ui.notify(`Removed exec permission for ${targetId}: ${command}\n${permsText()}`, "info");
			}

			const mode = action === "add" && isModeToken(rest[0]) ? rest[0] : undefined;
			const pathWords = mode ? rest.slice(1) : rest;
			const what = pathWords.join(" ");
			if (!what) return ctx.ui.notify(permissionsUsage(), "warning");

			let path: string;
			let requested: string;
			try {
				({ requested, real: path } = canonicalExistingPath(ctx.cwd, what));
			} catch (err) {
				return ctx.ui.notify(`Cannot ${action} ${what}: ${(err as Error).message}`, "warning");
			}

			state.scopes = state.scopes.filter((s) => s.path !== path);
			if (action === "add") {
				state.scopes.push({ path, mode: parseMode(mode, "ro") });
				savePermissionsState(ctx);
				syncTools();
				return ctx.ui.notify(`Added file permission for ${displayPath(path, requested)}.\n${permsText()}`, "info");
			}
			if (action === "deny") {
				state.scopes.push({ path, mode: "deny" });
				savePermissionsState(ctx);
				syncTools();
				return ctx.ui.notify(`Denied file path ${displayPath(path, requested)}.\n${permsText()}`, "info");
			}

			// Mounts bind at start, so a running target keeps them until restarted.
			let note = "";
			const stillMounted = state.targets.filter((t) => t.mounts.some((m) => isUnder(m.hostPath, path)));
			if (stillMounted.length) {
				note = `\nStill mounted in ${stillMounted.map((t) => t.id).join(", ")} — stop or restart to apply this change.`;
			}
			savePermissionsState(ctx);
			syncTools();
			return ctx.ui.notify(`Removed file permission for ${displayPath(path, requested)}.${note}\n${permsText()}`, "info");
		},
	});

	pi.registerCommand("background", {
		description: "Open the background command monitor.",
		handler: async (_args, ctx) => {
			setBackgroundContext(ctx);
			if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("/background requires the TUI", "warning"); return; }
			await ctx.ui.custom<void>((tui, _theme, keybindings, done) => new BackgroundPanel(tui, ctx, keybindings, done), {
				overlay: true,
				overlayOptions: { width: "86%", maxHeight: "68%", anchor: "center" },
			});
		},
	});

	// -------------------------------------------------------------- lifecycle

	let registeredSessionId: string | undefined;

	pi.on("session_start", async (_e, ctx) => {
		loadPermissionsState(ctx);
		refreshSessionSystemPaths(ctx);
		setBackgroundContext(ctx);
		registeredSessionId = ctx.sessionManager.getSessionId();
		const sessionBuiltInScopes = systemScopes.map((scope) => ({ ...scope }));
		permissionsBridge().instances.set(registeredSessionId, {
			getSnapshot: () => clonePermissionsSnapshot(state),
			applySnapshot: (snapshot) => {
				const cloned = clonePermissionsSnapshot(snapshot);
				state.scopes = cloned.scopes;
				state.vms = cloned.vms;
				state.execGrants = cloned.execGrants;
				state.sshTargets = cloned.sshTargets;
				targets.setRemoteConfigs(state.sshTargets);
				state.network = cloned.network;
				state.targets = cloned.targets;
				syncTools();
			},
			reduceSnapshot: (subset) => reducePermissionsSnapshot(state, subset, sessionBuiltInScopes),
		});
		syncTools();
	});

	pi.on("session_shutdown", () => {
		delete idleStatusBridge().backgroundActiveCount;
		if (registeredSessionId) permissionsBridge().instances.delete(registeredSessionId);
		registeredSessionId = undefined;
	});

	pi.on("session_compact", async (event, ctx) => {
		refreshSessionSystemPaths(ctx);
		pi.sendMessage({
			customType: "permissions.compaction-transcript-pointer",
			display: false,
			content: [
				"The session was compacted.",
				`The full JSONL transcript, including pre-compaction history, is available at: ${sessionTranscriptPath(ctx)}`,
				"Use read/grep on that file if exact prior messages or tool results are needed.",
			].join("\n"),
			details: { compactionEntryId: event.compactionEntry.id, transcript: sessionTranscriptPath(ctx) },
		}, { triggerTurn: false });
	});

	// Re-derive rather than announce: conversation branching can rewind the
	// transcript, but grants are real-world state and must not rewind with it.
	pi.on("before_agent_start", async (event, ctx) => {
		refreshSessionSystemPaths(ctx);
		const verbs = availableVerbs(state).filter((v) => IMPLEMENTED.includes(v));
		// State first, in the affirmative. An earlier version opened with "this
		// session starts with no access", and models read that policy statement
		// as the current state and repeated it back even while holding grants.
		const readable = state.scopes.filter((s) => s.mode !== "deny");
		const denied = state.scopes.filter((s) => s.mode === "deny");
		const systemRoots = systemScopes;
		const block = [
			"## Your access right now",
			"",
			readable.length
				? `User-granted directories:\n${readable
						.map((s) => `  - ${s.path}  (${s.mode})`)
						.join("\n")}`
				: "User-granted directories: none.",
			systemRoots.length ? `\nSystem paths (built in; not user permission grants):\n${systemRoots.map((s) => `  - ${s.path}  (${s.mode}, ${s.label})`).join("\n")}` : "",
			denied.length ? `\nExplicitly denied:\n${denied.map((s) => `  - ${s.path}`).join("\n")}` : "",
			`\nNetwork permission: ${state.network ?? "deny"}`,
			state.vms.length
				? `\nVMs you can use:\n${state.vms.map((v) => {
					const run = state.targets.find((t) => t.vm?.id === v.vmId);
					return `  - ${v.vmId} (${v.mode}${v.network ? ", network" : ""}, ${run ? "running" : "stopped"})`;
				}).join("\n")}`
				: "\nVMs you can use: none yet.",
			state.execGrants.length
				? `\nExec grants:\n${state.execGrants.map((g) => `  - ${g.target}: ${g.mode} ${g.command}`).join("\n")}`
				: "\nExec grants: none.",
			`\nTargets running: ${state.targets.map((t) => `${t.id}${t.exec ? " [exec-capable]" : ""}${t.kind === "linux" ? " [exec allowed]" : ""}`).join(", ")}`,
			"",
			"Permission state is factual current state. Choose paths and targets from the listed state; if a tool reports a missing permission or target, use that result to choose another valid route when one exists, and ask the user for access only when the task cannot be satisfied with the available state.",
		]
			.filter((l) => l !== "")
			.join("\n");
		const out = `${event.systemPrompt}\n\n${block}`;
		if (process.env.PI_PERMS_DUMP) {
			(await import("node:fs")).writeFileSync(process.env.PI_PERMS_DUMP, out);
		}
		return { systemPrompt: out };
	});
}
