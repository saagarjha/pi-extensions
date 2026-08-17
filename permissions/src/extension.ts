import { homedir, tmpdir } from "node:os";
import { ensureFSKitSetup } from "../fskit/setup.ts";
import { FSKitController, NativeMountDriver } from "../fskit/index.ts";
import { TargetFiles } from "../../targets/files.ts";
import type { TargetAuthority } from "../../targets/access.ts";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getDocsPath,
	getExamplesPath,
	getPackageDir,
	getReadmePath,
} from "@earendil-works/pi-coding-agent";
import type {
	BashOperations,
	EditOperations,
	ExtensionAPI,
	ExtensionContext,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { AskRequest } from "./ask.ts";
import { mountsCompatibleWith, reduceFileScopes, retainVmConstraints, weakerMode } from "./delegation.ts";
import { clonePermissionsSnapshot, execGrantKey, parseDelegationState, PermissionController, permissionsBridge, type DelegationState, type PermissionSubset, type PermissionsSnapshot } from "./bridge.ts";
import { DeniedError } from "./fsops.ts";
import { isUnder, nfc, resolveReal } from "./paths.ts";
import {
	asksForVerb,
	availableVerbs,
	canReadMode,
	canWriteMode,
	isAskMode,
	LOCAL_TARGET,
	type RunningTarget,
	type ScopeMode,
	type SshTarget,
	type State,
	type Verb,
	vmScope,
} from "./policy.ts";
import { TargetManager, SshJobContinuesError, type RemoteSshJob, type SshTargetConfig } from "../../targets/index.ts";
import { readBuffer, writeBuffer } from "../../targets/files.ts";
import { describeOp, requiresApproval, type VmOp } from "./vmops.ts";
import { newestFirst, transitionTaskStatus, visibleWindowAroundSelected } from "../../shared/task-lifecycle.ts";

let piByteMimeDetector: Promise<(bytes: Uint8Array) => string | null> | undefined;
function detectPiImageMimeType(bytes: Uint8Array): Promise<string | null> {
	piByteMimeDetector ??= import(pathToFileURL(join(getPackageDir(), "dist/utils/mime.js")).href)
		.then((module) => module.detectSupportedImageMimeType as (input: Uint8Array) => string | null);
	return piByteMimeDetector.then((detect) => detect(bytes));
}

function realIfExists(path: string): string {
	try {
		return resolveReal(path);
	} catch {
		return nfc(path);
	}
}

function piDocsReadRoots(): string[] {
	// Pi binds these SDK imports to the running installation, not local typecheck dependencies.
	return [getReadmePath(), getDocsPath(), getExamplesPath()].map(realIfExists);
}

type SystemScope = { path: string; mode: ScopeMode; label: string };

function sessionSystemRoot(ctx: ExtensionContext): string {
	return join(tmpdir(), "pi-session-system", ctx.sessionManager.getSessionId());
}

function sessionTranscriptPath(ctx: ExtensionContext): string {
	return join(sessionSystemRoot(ctx), "transcripts", "current.jsonl");
}

function prepareSessionSystemScopes(ctx: ExtensionContext): SystemScope[] {
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
	return [
		...piDocsReadRoots().map((path) => ({ path, mode: "ro" as const, label: "pi docs" })),
		{ path: realIfExists(root), mode: "ro", label: "session system" },
		{ path: realIfExists(scratch), mode: "rw", label: "session scratch" },
		{ path: realIfExists(transcripts), mode: "ro", label: "session transcripts" },
	];
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

/**
 * Pi 0.84.5+ makes factory tools prefer ctx.cwd over their captured cwd.
 * Target tools deliberately capture a guest cwd, so present that value only
 * to nested factory execution while preserving the real outer context.
 */
function factoryContextWithCwd(ctx: ExtensionContext, cwd: string): ExtensionContext {
	return new Proxy(ctx, {
		get(target, property, receiver) {
			return property === "cwd" ? cwd : Reflect.get(target, property, receiver);
		},
	});
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
// Pi marks tool executions as errors when they throw, not from a returned isError field.
function bad(text: string): never { throw new Error(text); }

function vmNetworkNote(t: RunningTarget): string {
	if (!t.network) return "";
	return t.kind === "macos"
		? "\nNetwork is ENABLED. macOS VMs cannot run without networking; stop this target to end its network access."
		: "\nNetwork is ENABLED. If it was only needed temporarily, vm_stop this target and vm_start it again without network before reading or processing user files.";
}

type IdleStatusBridge = {
	backgroundActiveCount?: () => number;
};

function idleStatusBridge(): IdleStatusBridge {
	return ((globalThis as typeof globalThis & { __piIdleStatus?: IdleStatusBridge }).__piIdleStatus ??= {});
}

/** Validate the entire command before its caller mutates permission state. */
function parseNetworkPermission(action: string, args: readonly string[]): NonNullable<State["network"]> {
	if (action === "remove" && args.length === 0) return "deny";
	const mode = args[0];
	if (action === "add" && args.length === 1 && (mode === "allow" || mode === "ask" || mode === "deny")) return mode;
	throw new Error("usage: /permissions add network <ask|allow|deny> | /permissions remove network");
}

function weakerExecMode(requested: "ask" | "allow" | undefined, parent: "ask" | "allow"): "ask" | "allow" {
	if (!requested) return parent;
	if (parent === "ask" && requested === "allow") throw new Error("Cannot delegate allow from parent ask exec permission");
	return requested;
}

function targetCompatibleWith(snapshot: PermissionsSnapshot, target: RunningTarget, builtInScopes: State["scopes"]) {
	const vmGrant = target.vm?.id ? snapshot.vms.find((vm) => vm.vmId === target.vm?.id && vm.mode !== "deny") : undefined;
	if (target.network && snapshot.network !== "allow" && !vmGrant?.network) return false;
	if (target.vm?.id && !vmGrant) return false;
	// A live mount cannot be reduced by changing copied metadata. Do not hand
	// an incompatible target to a child; leave the owner's running VM alone.
	return mountsCompatibleWith([...snapshot.scopes, ...builtInScopes], target.mounts);
}

function reducePermissionsSnapshot(parentSnapshot: PermissionsSnapshot, subset: PermissionSubset | undefined, builtInScopes: State["scopes"] = []): PermissionsSnapshot {
	const parent = clonePermissionsSnapshot(parentSnapshot);
	if (!subset) return parent;
	const parentNetwork = parent.network ?? "deny";
	const network = subset.network === undefined || subset.network === "inherit" ? parentNetwork : subset.network;
	if (parentNetwork === "deny" && network !== "deny") throw new Error("Cannot delegate network; parent network is deny");
	if (parentNetwork === "ask" && network === "allow") throw new Error("Cannot delegate allow network from parent ask network");
	const delegateableFileScopes = [...parent.scopes, ...builtInScopes.map(({ path, mode }) => ({ path, mode }))];
	const scopes = subset.files === undefined
		? parent.scopes.map((scope) => ({ ...scope }))
		: reduceFileScopes(delegateableFileScopes, subset.files.map((requested) => ({
			path: realIfExists(nfc(requested.path)), mode: requested.mode,
		})));
	const vms = subset.vms === undefined
		? parent.vms.map((vm) => ({ ...vm }))
		: retainVmConstraints(parent.vms, subset.vms.map((requested) => {
			const requestedVmId = normalizeVmId(requested.vmId);
			const parentVm = parent.vms.find((vm) => vm.vmId === requestedVmId);
			if (!parentVm) throw new Error(`Cannot delegate VM permission the parent does not have: ${requestedVmId}`);
			if (requested.network && !parentVm.network && network !== "allow") {
				throw new Error(`Cannot delegate VM network for ${requestedVmId}; parent has neither VM-specific network nor delegated global network allow`);
			}
			return { vmId: parentVm.vmId, mode: weakerMode(requested.mode, parentVm.mode), network: requested.network ?? parentVm.network };
		}));
	const execGrants = subset.exec === undefined
		? parent.execGrants.map((g) => ({ ...g }))
		: subset.exec.map((requested) => {
			const parentGrant = parent.execGrants.find((g) => g.target === requested.target && g.command === requested.command);
			if (!parentGrant) throw new Error(`Cannot delegate exec permission the parent does not have exactly: ${requested.target} ${requested.command}`);
			return { target: parentGrant.target, command: parentGrant.command, mode: weakerExecMode(requested.mode, parentGrant.mode) };
		});
	const reduced: PermissionsSnapshot = { scopes, vms, execGrants, sshTargets: parent.sshTargets, network, targets: parent.targets };
	return { ...reduced, targets: parent.targets.filter((target) => targetCompatibleWith(reduced, target, builtInScopes)) };
}

export default function extension(pi: ExtensionAPI) {
	const targets = new TargetManager();
	let fskit: FSKitController | undefined;
	let fskitFailure: Error | undefined;
	let fskitSession: string | undefined;
	function requireFileBackend() {
		if (fskitFailure) throw fskitFailure;
		if (!fskit) throw new Error("The FSKit session filesystem is unavailable. Complete first-use setup and enable pi-fs in System Settings.");
		fskit.assertReady();
	}
	function updateFileBackend() {
		if (fskit) void fskit.update([...state.scopes, ...systemScopes]).catch(error => { fskitFailure = error; });
	}
	function currentMountsCompatible(mounts: RunningTarget["mounts"]): boolean {
		requireFileBackend();
		return mounts.every(m => m.permissionSession === fskitSession && m.hostPath === fskit!.path("/") && m.logicalHostPath === "/");
	}

	// Session state. Deliberately not stored in tool-result details: grants are
	// real-world authorizations and must not rewind when the conversation does.
	const state: State = { scopes: [], vms: [], execGrants: [], sshTargets: [], network: "deny", targets: [targets.localTarget(LOCAL_TARGET)] };
	let permissionController: PermissionController | undefined;
	let delegationState: DelegationState | undefined;
	// Extension modules are shared by actors; system authority must not be.
	let systemScopes: SystemScope[] = piDocsReadRoots().map((path) => ({ path, mode: "ro", label: "pi docs" }));

	function refreshSessionSystemPaths(ctx: ExtensionContext): void {
		systemScopes = prepareSessionSystemScopes(ctx);
		updateFileBackend();
	}

	function ensureCurrentPermissions(): void {
		if (!permissionController) throw new Error("Permission state is not initialized.");
		permissionController.changed();
	}

	function mountsForCurrentScopes() {
		requireFileBackend();
		return [{ hostPath: fskit!.path("/"), guestPath: "/mnt/pi-host", mode: "rw" as const, logicalHostPath: "/", permissionSession: fskitSession }];
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

	/**
	 * `state.targets` is the authorization snapshot. Resolve through the target
	 * registry before use so a subagent never treats copied VM metadata as a
	 * connection: managed targets must still be live in the shared registry.
	 */
	function target(id: string): RunningTarget | undefined {
		const granted = state.targets.find((t) => t.id === id);
		if (!granted) return undefined;
		const connected = targets.resolveTarget(id);
		return connected ?? (granted.kind === "local" || granted.kind === "remote" ? granted : undefined);
	}

	type PersistedPermissions = Pick<State, "scopes" | "vms" | "execGrants" | "sshTargets" | "network"> & { delegation?: DelegationState };

	function permissionsStatePath(ctx: ExtensionContext): string {
		return join(ctx.sessionManager.getSessionDir(), "extension-state", "permissions", `${ctx.sessionManager.getSessionId()}.json`);
	}

	function loadPermissionsState(ctx: ExtensionContext): void {
		const path = permissionsStatePath(ctx);
		if (!existsSync(path)) return;
		try {
			const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedPermissions>;
			const delegation = parseDelegationState(saved.delegation);
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
			delegationState = delegation;
		} catch {
			// Ignore corrupt session permission state. The user can re-add grants.
		}
	}

	function persistPermissionsState(ctx: ExtensionContext): void {
		const path = permissionsStatePath(ctx);
		const saved = permissionController?.getPersistableSnapshot() ?? state;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ scopes: saved.scopes, vms: saved.vms, execGrants: saved.execGrants, sshTargets: saved.sshTargets, network: saved.network, delegation: permissionController?.getDelegationState() ?? delegationState } satisfies PersistedPermissions, null, 2));
	}

	async function savePermissionsState(ctx: ExtensionContext): Promise<void> {
		permissionController?.changed();
		// An explicit local grant can change provenance without changing its mode.
		persistPermissionsState(ctx);
		if (fskit) await fskit.update([...state.scopes, ...systemScopes]);
	}

	function ensureExecGrant(targetId: string, command = "*", mode: "allow" | "ask" = "allow"): void {
		const existing = state.execGrants.find((g) => g.target === targetId && g.command === command);
		if (existing) {
			existing.mode = weakerExecMode(existing.mode, mode);
			return;
		}
		state.execGrants.push({ target: targetId, command, mode });
		permissionController?.markLocal("exec", execGrantKey(targetId, command));
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
		permissionController?.changed();
		pi.setActiveTools(mergedActiveToolNames());
	}

	async function ask(ctx: ExtensionContext, req: AskRequest): Promise<boolean> {
		// Nobody there to answer: decline rather than hang.
		if (!ctx.hasUI) return false;
		const controller = permissionController;
		const revision = controller?.getRevision();
		const body = [...(req.detail ?? []).map((d) => `  • ${d}`), req.onDecline ? `\nIf declined: ${req.onDecline}` : ""]
			.filter(Boolean)
			.join("\n");
		const approved = await ctx.ui.confirm(req.operation, body);
		if (approved && (!controller || controller !== permissionController || controller.getRevision() !== revision)) {
			throw new Error("Permissions changed while awaiting approval. Retry the operation against the current permissions.");
		}
		return approved;
	}

	async function approve(ctx: ExtensionContext, op: VmOp): Promise<boolean> {
		if (!requiresApproval(op)) return true;
		return ask(ctx, describeOp(op));
	}

	function targetAuthority(ctx: ExtensionContext): TargetAuthority {
		return {
			current() { ensureCurrentPermissions(); return { state, systemScopes, proxy: fskit }; },
			target,
			checkpoint() {
				ensureCurrentPermissions();
				const controller = permissionController, revision = controller?.getRevision();
				const systemFingerprint = JSON.stringify(systemScopes);
				return () => {
					ensureCurrentPermissions();
					if (!controller || controller !== permissionController || revision !== controller.getRevision() || systemFingerprint !== JSON.stringify(systemScopes)) {
						throw new Error("Permissions changed during this operation. Retry against current permissions.");
					}
				};
			},
			ask: request => ask(ctx, request),
			async readyFiles() {
				ensureCurrentPermissions();
				if (fskit) await fskit.update([...state.scopes, ...systemScopes]);
				requireFileBackend();
			},
			assertFiles: requireFileBackend,
			mountsCompatible: currentMountsCompatible,
		};
	}

	async function authorizeExec(ctx: ExtensionContext, params: { target: string; command: string }) {
		return { t: await targets.access(params.target, targetAuthority(ctx)).exec(params.command) };
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
			const running = state.targets.map((t) => {
				const vmGrant = vmScope(state, t.vm?.id);
				const vmMode = vmGrant?.mode ?? "deny";
				const execGrant = state.execGrants.find((grant) => grant.target === t.id && grant.command === "*");
				const vmExec = t.exec && t.vm && canWriteMode(vmMode)
					? (fskitFailure || !fskit || !currentMountsCompatible(t.mounts)) ? " [access blocked: mounts exceed permissions]"
						: t.network && !vmGrant?.network && state.network !== "allow" && state.network !== "ask" ? " [access blocked: network denied]"
						: asksForVerb(vmMode, "write") || execGrant?.mode === "ask" || (t.network && !vmGrant?.network && state.network === "ask") ? " [exec requires approval]" : " [exec allowed]"
					: "";
				return `  ${t.id}${t.exec ? " [exec-capable]" : ""}${vmExec}${t.kind === "remote" ? " [ssh]" : ""}${t.network ? " [network]" : ""}` +
					(t.mounts.length ? `\n${t.mounts.map((m) => `      ${m.hostPath} → ${m.guestPath} (${m.mode})`).join("\n")}` : "");
			});
			const systemRoots = systemScopes;
			const lines = [
				`file access: session proxy; local shell is NOT isolated${fskitFailure ? ` (blocked: ${fskitFailure.message})` : ""}`,
				"files:",
				...(state.scopes.length ? state.scopes.map((s) => `  ${s.mode.padEnd(9)} ${s.path}`) : ["  none"]),
				...(systemRoots.length ? ["system:", ...systemRoots.map((s) => `  ${s.mode.padEnd(9)} ${s.path}  (${s.label})`)] : []),
				`network: ${state.network ?? "deny"}`,
				"vms:",
				...(state.vms.length ? state.vms.map((v) => {
					const run = state.targets.find((t) => t.vm?.id === v.vmId);
					return `  ${v.mode.padEnd(9)} ${v.vmId}${v.network ? " +network" : ""} ${run ? `running${run.exec ? " [exec]" : ""}${run.network ? " [network]" : ""}` : "not attached"}`;
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
			if (!verbs.includes("bash")) modelLines.push("hint: bash/bg_start need a running exec-capable target with an exec grant or current writable VM access; ask permissions require approval.");
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
			"Create a fresh VM and start it as a running exec target. Unnamed scratch creation itself needs no approval, but networking may require it. The default Linux base is minimal ubuntu:latest: basic shell/userland only, with no scripting runtimes. Linux networking is optional; macOS always requires network permission.",
		promptSnippet: "Create and start a VM target",
		promptGuidelines: [
			"Use vm_create when you need an executable target and no suitable exec-enabled target is already available.",
			"Prefer an unnamed vm_create — scratch creation itself is free and needs no approval; network authorization still applies.",
			"The default VM is intentionally minimal Ubuntu: basic shell/userland only, not much else — in particular, no scripting runtimes unless you install them.",
			"For Linux, if you only need network to install or fetch dependencies, keep that phase short, then vm_stop and vm_start without network before reading or processing user files. macOS VMs cannot run without networking.",
		],
		parameters: Type.Object({
			os: Type.Optional(Type.Union([Type.Literal("linux"), Type.Literal("macos")], { description: "VM operating system; Linux is the default. macOS requires Apple Silicon macOS 27+ and network permission for every boot." })),
			name: Type.Optional(Type.String({ description: "Only for a durable, reusable VM. Omit for a generated scratch id." })), 
			base: Type.Optional(Type.String({ description: "Existing VM to fork from. Omit this field to use the built-in minimal ubuntu:latest base." })),
			network: Type.Optional(Type.Boolean({ description: "Request Linux networking. macOS always uses networking, even if false or omitted. Requires approval unless network is already allowed." })),
			options: Type.Optional(Type.Object({
				ramMiB: Type.Optional(Type.Integer({ minimum: 1, description: "RAM allocation for this macOS VM boot, in MiB." })),
			})),
		}),
		renderCall(args: any, theme: any) {
			return toolCallLine(["vm_create", args?.os ? `os=${args.os}` : undefined, args?.name, args?.base ? `base=${args.base}` : undefined, args?.network ? "network" : undefined], theme);
		},
		async execute(_id, params, _signal, onUpdate, ctx) {
			// Authorize actual backend behavior, including macOS base/provisioning boots.
			const wantsNetwork = params.os === "macos" || (params.network ?? false);
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
			if (baseId) {
				const baseGrant = vmScope(state, baseId);
				// An explicit restriction wins even if the base is published.
				if (baseGrant) {
					if (!canReadMode(baseGrant.mode)) return bad(`Permission denied: base VM ${baseId} is not readable in this session.`);
					if (asksForVerb(baseGrant.mode, "read") && !(await ask(ctx, {
						operation: `Read base VM ${baseId} to create a new VM`,
						detail: [`VM permission: ${baseGrant.mode}`, "Cloning copies the base VM's filesystem."],
						onDecline: "the base is not copied and no VM is created",
					}))) return bad("Permission denied: reading the base VM was not approved.");
				} else if (!targets.isPublished(baseId)) {
					return bad(
						`Permission denied: base VM ${baseId} is private and has not been added to this session. ` +
							`If you wanted the default Ubuntu base, omit the base parameter. ` +
							`Otherwise use /permissions add vm ro ${baseId} to allow temporary access.`,
					);
				}
			}
			try {
				let progress = "";
				const onOutput = (chunk: string) => {
					progress = appendStreamingText(progress, chunk);
					onUpdate?.(ok(progress));
				};
				const vm = await targets.createVm({ os: params.os, name: createName, base: baseId, network: wantsNetwork, options: params.options, onOutput });
				state.vms.push({ vmId: vm.id, mode: "rw" });
				permissionController?.markLocal("vm", vm.id);
				await savePermissionsState(ctx);
				refreshSessionSystemPaths(ctx);
				const run = await targets.start(vm.id, {
					mounts: mountsForCurrentScopes(),
					network: wantsNetwork,
				});
				state.targets = state.targets.filter((t) => t.id !== run.id);
				state.targets.push(run);
				permissionController?.markLocal("target", run.id);
				ensureExecGrant(run.id);
				await savePermissionsState(ctx);
				syncTools();
				const networkNote = vmNetworkNote(run);
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
			"Adopt an added VM into this session by starting it as a running target. " +
			"Host files are exposed only through this session's policy-enforcing FSKit proxy; nested rules and reverse approvals stay live. " +
			"For macOS, sip requests a persisted SIP state; a mismatch is privately reprovisioned before this visible boot. Linux networking is off by default; macOS always requires network permission, including private provisioning boots. Networking requires approval or an existing session/VM network permission. Only Linux can be restarted without network.",
		promptSnippet: "Start/adopt an added VM as a running target",
		parameters: Type.Object({
			vmId: Type.String({ description: "VM id to start, e.g. scratch-abc123" }),
			network: Type.Optional(Type.Boolean({ description: "Request Linux networking. macOS always uses networking, even if false or omitted. Requires approval or an existing session/VM network permission." })),
			sip: Type.Optional(StringEnum(["enabled", "disabled"] as const, { description: "Desired persisted SIP state for a macOS VM. Omit to retain its current state." })),
		}),
		renderCall(args: any, theme: any) {
			return toolCallLine(["vm_start", args?.vmId, args?.sip ? `sip=${args.sip}` : undefined, args?.network ? "network" : undefined], theme);
		},
		async execute(_id, params, _signal, onUpdate, ctx) {
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
			const wantsNetwork = targets.getVm(vmId)?.kind === "macos" || (params.network ?? false);
			if (wantsNetwork && state.network !== "allow" && !grant.network) {
				if (state.network !== "ask") return bad(`Permission denied: network access is not enabled for this session or VM ${vmId}. Use /permissions add network ask|allow or /permissions add vm network ${vmId} to allow it.`);
				if (!(await approve(ctx, { op: "start", vmId, network: true }))) {
					return bad("Permission denied: starting this VM with network was not approved.");
				}
			}
			const existing = targets.resolveTarget(vmId);
			if (existing?.vm && !currentMountsCompatible(existing.mounts)) {
				return bad(`Permission denied: VM ${vmId} is already running with file mounts broader than this session permits. Its mounts were left unchanged; use a fresh VM or have its owner stop it first.`);
			}
			try {
				let progress = "";
				const run = await targets.start(vmId, {
					mounts: mountsForCurrentScopes(),
					network: wantsNetwork,
					sip: params.sip,
					onOutput: (chunk) => {
						progress = appendStreamingText(progress, chunk);
						onUpdate?.(ok(progress));
					},
				});
				state.targets = state.targets.filter((t) => t.id !== run.id);
				state.targets.push(run);
				if (!existing?.vm) permissionController?.markLocal("target", run.id);
				syncTools();
				const networkNote = vmNetworkNote(run);
				return ok(`Started ${vmId}${run.vm?.sip ? ` with SIP ${run.vm.sip}` : ""}.${networkNote}`, {
					display: [
						`Started ${vmId}${run.vm?.sip ? ` (SIP ${run.vm.sip})` : ""}`,
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
				permissionController?.forgetLocal("target", targetId);
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
					return `${v.id}${v.name ? ` (${v.name})` : ""} ${run ? "running" : "stopped"}${v.sip ? ` [sip=${v.sip}]` : ""}${v.published ? " [published]" : ""}`;
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
				permissionController?.forgetLocal("vm", vmId);
				permissionController?.forgetLocal("vmNetwork", vmId);
				for (const t of state.targets) if (t.vm?.id === vmId) permissionController?.forgetLocal("target", t.id);
				for (const grant of state.execGrants) if (grant.target === vmId) permissionController?.forgetLocal("exec", execGrantKey(grant.target, grant.command));
				state.vms = state.vms.filter((v) => v.vmId !== vmId);
				state.targets = state.targets.filter((t) => t.vm?.id !== vmId);
				state.execGrants = state.execGrants.filter((g) => g.target !== vmId);
				await savePermissionsState(ctx);
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
			const grant = vmScope(state, t.vm.id);
			if (!grant || !canReadMode(grant.mode)) return bad(`Permission denied: VM ${t.vm.id} is not readable in this session.`);
			if (publishId === t.vm.id && !canWriteMode(grant.mode)) return bad(`Permission denied: updating VM ${t.vm.id} in place requires write access.`);
			// Publishing always asks, which also covers any ask-only read/write grant.
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

	function registerBuiltInFsTool(
		verb: Exclude<Verb, "bash">,
		factory: (cwd: string, options?: any) => any,
		makeOperations: (files: TargetFiles, signal?: AbortSignal) => any,
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
				const authorized = await targets.access(params.target, targetAuthority(ctx)).files(verb, params.path ?? ".", ctx.cwd);
				const { target: selected, path: pathForDecision, files } = authorized;
				try {
					const factoryCwd = authorized.cwd;
					const recursive = verb === "find" || verb === "grep";
					if (recursive) signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
					const base = factory(factoryCwd, { operations: makeOperations(files, signal) });
					const { target: _target, ...innerParams } = params;
					const execute = (path?: string) => base.execute(id, path ? { ...innerParams, path } : innerParams, signal, onUpdate, factoryContextWithCwd(ctx, factoryCwd));
					if (recursive) {
						return await files.search(verb === "find" ? "fd" : "rg", pathForDecision, signal, execute);
					}
					// Pass the normalized host name into Pi too: its own argument
					// resolver must not lexically collapse an original symlink/.. spelling.
					return await execute(selected.kind === "local" ? pathForDecision : undefined);
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

	registerBuiltInFsTool("read", createReadToolDefinition, (files, signal): ReadOperations => {
		let cachedPath: string | undefined, cachedBytes: Buffer | undefined;
		const readBytes = async (path: string) => {
			if (cachedPath !== path || !cachedBytes) { cachedBytes = await readBuffer(files, path, signal); cachedPath = path; }
			return cachedBytes;
		};
		return {
			access: async (path) => { await files.stat(path, signal); },
			readFile: readBytes,
			detectImageMimeType: async (path) => detectPiImageMimeType(await readBytes(path)),
		};
	});
	registerBuiltInFsTool("ls", createLsToolDefinition, (files, signal): LsOperations => {
		return { exists: path => files.exists(path, signal), stat: path => files.stat(path, signal), readdir: path => files.readdir(path, signal) };
	});
	// No custom glob: Pi's actual fd launcher and parser must run inside the seam.
	registerBuiltInFsTool("find", createFindToolDefinition, () => undefined);
	registerBuiltInFsTool("grep", createGrepToolDefinition, (files, signal) => {
		return {
			isDirectory: (path: string) => files.searchIO(async () => (await files.stat(path, signal)).isDirectory()),
			readFile: (path: string) => files.searchIO(async () => (await readBuffer(files, path, signal)).toString("utf8")),
		};
	});
	registerBuiltInFsTool("write", createWriteToolDefinition, (files, signal): WriteOperations => {
		return { mkdir: path => files.mkdirParents(path, signal), writeFile: (path, content) => writeBuffer(files, path, Buffer.from(content), signal) };
	}, params => ({ ...params, content: params.content ?? params.contents }));
	registerBuiltInFsTool("edit", createEditToolDefinition, (files, signal): EditOperations => {
		return { access: async path => { await files.stat(path, signal); }, readFile: path => readBuffer(files, path, signal), writeFile: (path, content) => writeBuffer(files, path, Buffer.from(content), signal) };
	});


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
		async execute(_id, params, signal, onUpdate, ctx) {
			refreshSessionSystemPaths(ctx);
			const source = await targets.access(params.sourceTarget, targetAuthority(ctx)).files("read", params.sourcePath, ctx.cwd);
			const destination = await targets.access(params.destTarget, targetAuthority(ctx)).files("write", params.destPath, ctx.cwd);
			const sourceTarget = source.target, destTarget = destination.target;
			const sourceDecision = source.path, destDecision = destination.path;
			try {
				if (sourceTarget.id === destTarget.id && isUnder(destDecision, sourceDecision) && (await source.files.stat(params.sourcePath, signal)).isDirectory()) throw new Error("cannot copy a directory into itself or one of its descendants");
				const { files, dirs } = await source.files.copyTo(destination.files, { ...params, sameTarget: sourceTarget.id === destTarget.id }, signal, (from, to, transferred, total) => onUpdate?.(ok(`Copying ${from} → ${to}\n${transferred}/${total} bytes`)));
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
	function renderBackgroundOutput(job: BackgroundJob, tailChars = 8000) {
		const output = job.output.length > tailChars ? `[output truncated: showing last ${tailChars} chars]\n${job.output.slice(-tailChars)}` : job.output;
		return `${output || "(no output yet)"}${job.error ? `\n\nerror: ${job.error}` : ""}`;
	}
	function renderBackgroundJob(job: BackgroundJob, tailChars = 8000) {
		const runtime = job.status === "running" ? `running for ${Math.max(0, Math.round((Date.now() - job.startedAt) / 1000))}s` : job.status;
		const exit = job.exitCode === undefined ? "" : ` exit=${job.exitCode}`;
		const header = `${job.id} [${runtime}${exit}] target=${job.target} cwd=${job.cwd}\n$ ${job.command}`;
		return `${header}\n\n${renderBackgroundOutput(job, tailChars)}`;
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
	async function authorizeRemoteBackgroundJob(ctx: ExtensionContext, job: BackgroundJob): Promise<SshTargetConfig> {
		// Status/stop open new SSH connections: the original launch approval is not enough.
		const g = await authorizeExec(ctx, { target: job.target, command: job.command });
		if (g.t.kind !== "remote") return bad(`SSH target is no longer available: ${job.target}`);
		const cfg = sshConfig(g.t.id);
		if (!cfg) return bad(`SSH target is no longer configured: ${job.target}`);
		return cfg;
	}
	async function syncRemoteBackgroundJob(ctx: ExtensionContext, job: BackgroundJob, tailChars = 8000) {
		if (!job.remote || job.status !== "running") return;
		const cfg = await authorizeRemoteBackgroundJob(ctx, job);
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
	async function stopBackgroundJob(ctx: ExtensionContext, job: BackgroundJob) {
		if (job.status === "running") {
			if (job.remote) {
				const cfg = await authorizeRemoteBackgroundJob(ctx, job);
				await targets.stopRemoteJob(cfg, job.remote);
			}
			// Local/VM cancellation only aborts existing work; it opens no new connection.
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
		const counts = {
			running,
			done: jobs.filter((job) => job.status === "done").length,
			failed: jobs.filter((job) => job.status === "failed" || job.status === "stopped").length,
		};
		const parts = [
			ctx.ui.theme.fg("accent", `[${jobs.length} bg`),
			counts.running ? ctx.ui.theme.fg("accent", `${counts.running} running`) : undefined,
			counts.done ? ctx.ui.theme.fg("success", `${counts.done} done`) : undefined,
			counts.failed ? ctx.ui.theme.fg("error", `${counts.failed} failed`) : undefined,
		].filter((part): part is string => part !== undefined);
		if (parts.length > 0) parts[parts.length - 1] += "]";
		ctx.ui.setStatus("background", parts.join(" • "));
		ctx.ui.setWidget("background", undefined);
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
			if (stopSelected) {
				const job = jobs[this.selected];
				if (job) void stopBackgroundJob(this.ctx, job).catch((error) => {
					this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
				this.tui.requestRender();
				return;
			}
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
					lines.push(this.ctx.ui.theme.fg("dim", `${job.target} · ${job.cwd}`));
					lines.push(this.ctx.ui.theme.fg("dim", "─".repeat(innerWidth)));
					const logLines = [`$ ${job.command}`, "", ...renderBackgroundOutput(job, 40_000).split("\n")]
						.flatMap((line) => wrapTextWithAnsi(line || " ", innerWidth).map((wrapped) => truncateToWidth(wrapped, innerWidth)));
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
			const g = await authorizeExec(ctx, params);
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
					const text = `${output}${suffix}` || "(no output)";
					if (result.exitCode !== undefined && result.exitCode !== 0) return bad(text);
					return ok(text) as any;
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
			const factoryCwd = g.t.kind === "local" ? ctx.cwd : "/";
			const base = createBashToolDefinition(factoryCwd, { operations, exposeSessionEnvironment: false });
			return base.execute(id, { command: params.command, timeout: timeoutMs / 1000 }, signal, onUpdate, factoryContextWithCwd(ctx, factoryCwd));
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
			const g = await authorizeExec(ctx, params);
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			for (const job of backgroundJobs.values()) if (job.remote) await syncRemoteBackgroundJob(ctx, job, 2000);
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!params.id) {
				return ok("bg_status is for deliberate inspection of one job's buffered output. Pass an id, or use bg_list for compact mailbox/status inspection.");
			}
			const job = backgroundJobs.get(params.id);
			if (!job) return bad(`Unknown background command: ${params.id}`);
			if (job.remote) await syncRemoteBackgroundJob(ctx, job, params.tailChars ?? 2000);
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const job = backgroundJobs.get(params.id);
			if (!job) return bad(`Unknown background command: ${params.id}`);
			if (job.status === "running") await stopBackgroundJob(ctx, job);
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

	function canonicalExistingPath(cwd: string, what: string): { requested: string; real: string } {
		const requested = nfc(resolve(cwd, expandUser(what)));
		return { requested, real: resolveReal(requested) };
	}

	/**
	 * Resolve a permission path without requiring it to still exist.  Grants are
	 * stored as real paths when added; once one is deleted, its normalized
	 * lexical path is the same stored path and lets `/permissions remove` revoke
	 * the stale grant.
	 */
	function canonicalPathForRemoval(cwd: string, what: string): { requested: string; real: string } {
		const requested = nfc(resolve(cwd, expandUser(what)));
		return { requested, real: realIfExists(requested) };
	}

	function parseSshDestination(spec: string): { destination: string; port?: number } {
		const m = spec.match(/^(.+):(\d+)$/);
		const destination = m?.[1] ?? spec;
		const port = m?.[2] === undefined ? undefined : Number(m[2]);
		if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) throw new Error("SSH port must be an integer from 1 to 65535");
		return { destination, port };
	}

	async function offerRestartWithoutNetwork(ctx: ExtensionContext, vmIds?: Set<string>): Promise<string> {
		const networkedTargets = state.targets.filter((t) => t.network && t.vm && (!vmIds || vmIds.has(t.vm.id)));
		const macosTargets = networkedTargets.filter((t) => t.kind === "macos");
		const macosNote = macosTargets.length
			? `\nmacOS target(s) ${macosTargets.map((t) => t.id).join(", ")} cannot run without networking and were left running. Stop them to end their network access.`
			: "";
		const runningTargets = networkedTargets.filter((t) => t.kind !== "macos");
		if (!runningTargets.length) return macosNote;
		const okToRestart = await ask(ctx, {
			operation: "Restart running networked VM target(s) without network now?",
			detail: runningTargets.map((t) => t.id),
			onDecline: "network remains active in already-running targets until they are stopped",
		});
		if (!okToRestart) return `\nExisting Linux networked target(s) were left running; stop/restart them to drop network.${macosNote}`;
		const restarted: string[] = [];
		for (const t of runningTargets) {
			const vmId = t.vm?.id;
			if (!vmId) continue;
			await targets.stop(t.id);
			state.targets = state.targets.filter((x) => x.id !== t.id);
			permissionController?.forgetLocal("target", t.id);
			await savePermissionsState(ctx);
			refreshSessionSystemPaths(ctx);
			const run = await targets.start(vmId, { mounts: mountsForCurrentScopes(), network: false });
			state.targets.push(run);
			permissionController?.markLocal("target", run.id);
			await savePermissionsState(ctx);
			restarted.push(run.id);
		}
		return (restarted.length ? `\nRestarted without network: ${restarted.join(", ")}` : "") + macosNote;
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
			"  /permissions add network <ask|allow|deny>",
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
		if (action === "add" && kind === "network") return filter([item("ask", "ask before network use"), item("allow", "allow network use"), item("deny", "deny new network use")]);
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
			ensureCurrentPermissions();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const [action, kind, ...rest] = parts;
			if (!action || action === "list" || action === "show") return ctx.ui.notify(permsText(), "info");

			if (action !== "add" && action !== "remove" && action !== "deny") {
				return ctx.ui.notify(permissionsUsage(), "warning");
			}
			if (kind !== "file" && kind !== "vm" && kind !== "ssh" && kind !== "network" && kind !== "exec") return ctx.ui.notify(permissionsUsage(), "warning");
			if (action === "deny" && kind !== "file") return ctx.ui.notify("usage: /permissions deny file <path>", "warning");

			if (kind === "network") {
				try { state.network = parseNetworkPermission(action, rest); }
				catch (error) { return ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
				permissionController?.markLocalNetwork();
				// Publish revocation before offering any asynchronous VM restart UI.
				await savePermissionsState(ctx);
				let note = "";
				if (action === "remove") {
					try {
						note = await offerRestartWithoutNetwork(ctx);
					} catch (err) {
						note = `\nCould not restart networked targets: ${(err as Error).message}`;
					}
				}
				await savePermissionsState(ctx);
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
					if (state.network === "deny") {
						// Permission changes belong to this user-issued command, not
						// the tool-operation approval path.
						const allowNetwork = ctx.hasUI && await ctx.ui.confirm(
							"Allow network access for this session?",
							`Adding SSH target ${sshId} (${destinationSpec}) requires network access.\n\n` +
							"This changes network permission from deny to allow for the entire session, not just this SSH target. Data Pi can read may be sent over the network.\n\n" +
							"Allow network access and continue adding this target?",
						);
						if (!allowNetwork) return ctx.ui.notify("SSH target not added; network permission unchanged.", "info");
						state.network = "allow";
						permissionController?.markLocalNetwork();
						await savePermissionsState(ctx);
						syncTools();
					}
					const ssh = { id: sshId, ...parsed } satisfies SshTarget;
					try { await targets.probeRemote(ssh); }
					catch (err) { return ctx.ui.notify(`SSH target rejected: ${err instanceof Error ? err.message : String(err)}`, "warning"); }
					state.sshTargets = state.sshTargets.filter((s) => s.id !== sshId);
					state.sshTargets.push(ssh);
					targets.configureRemote(ssh);
					state.targets = state.targets.filter((t) => t.id !== sshId);
					state.targets.push(sshRunningTarget(ssh));
					permissionController?.markLocal("ssh", sshId);
					permissionController?.markLocal("target", sshId);
					await savePermissionsState(ctx);
					syncTools();
					return ctx.ui.notify(`Added SSH target ${sshId} (${parsed.destination}${parsed.port !== undefined ? `:${parsed.port}` : ""}).\n${permsText()}`, "info");
				}
				const [id] = rest;
				if (!id) return ctx.ui.notify(permissionsUsage(), "warning");
				let sshId: string;
				try { sshId = normalizeVmId(id); }
				catch (err) { return ctx.ui.notify((err as Error).message, "warning"); }
				permissionController?.forgetLocal("ssh", sshId);
				permissionController?.forgetLocal("target", sshId);
				for (const grant of state.execGrants) if (grant.target === sshId) permissionController?.forgetLocal("exec", execGrantKey(grant.target, grant.command));
				state.sshTargets = state.sshTargets.filter((s) => s.id !== sshId);
				targets.removeRemote(sshId);
				state.targets = state.targets.filter((t) => t.id !== sshId);
				state.execGrants = state.execGrants.filter((g) => g.target !== sshId);
				await savePermissionsState(ctx);
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
					if (!networkOnly || !existing) permissionController?.markLocal("vm", vmId);
					if (networkOnly || rest.includes("network")) permissionController?.markLocal("vmNetwork", vmId);
					await savePermissionsState(ctx);
					syncTools();
					return ctx.ui.notify(`Added VM ${vmId}${network ? " with network permission" : ""}.\n${permsText()}`, "info");
				}

				if (networkOnly && existing) {
					state.vms = state.vms.map((v) => (v.vmId === vmId ? { ...v, network: false } : v));
					permissionController?.markLocal("vmNetwork", vmId);
					await savePermissionsState(ctx);
					let note = "";
					try {
						note = await offerRestartWithoutNetwork(ctx, new Set([vmId]));
					} catch (err) {
						note = `\nCould not restart networked target: ${(err as Error).message}`;
					}
					await savePermissionsState(ctx);
					syncTools();
					return ctx.ui.notify(`Removed network permission for VM ${vmId}.${note}\n${permsText()}`, "info");
				}

				state.vms = state.vms.filter((v) => v.vmId !== vmId);
				permissionController?.forgetLocal("vm", vmId);
				permissionController?.forgetLocal("vmNetwork", vmId);
				await savePermissionsState(ctx);
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
					permissionController?.markLocal("exec", execGrantKey(targetId, command));
					await savePermissionsState(ctx);
					syncTools();
					return ctx.ui.notify(`Added exec permission (${mode}) for ${targetId}: ${command}\n${permsText()}`, "info");
				}
				const m = args.match(/^\s*remove\s+exec\s+(\S+)\s+([\s\S]+)$/);
				if (!m) return ctx.ui.notify(permissionsUsage(), "warning");
				const [, targetId, command] = m;
				if (!targetId || !command) return ctx.ui.notify(permissionsUsage(), "warning");
				state.execGrants = state.execGrants.filter((g) => !(g.target === targetId && g.command === command));
				permissionController?.forgetLocal("exec", execGrantKey(targetId, command));
				await savePermissionsState(ctx);
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
				({ requested, real: path } = action === "remove"
					? canonicalPathForRemoval(ctx.cwd, what)
					: canonicalExistingPath(ctx.cwd, what));
			} catch (err) {
				return ctx.ui.notify(`Cannot ${action} ${what}: ${(err as Error).message}`, "warning");
			}

			state.scopes = state.scopes.filter((s) => s.path !== path);
			if (action === "remove") permissionController?.forgetLocal("scope", path);
			else permissionController?.markLocal("scope", path);
			if (action === "add") {
				state.scopes.push({ path, mode: parseMode(mode, "ro") });
				await savePermissionsState(ctx);
				syncTools();
				return ctx.ui.notify(`Added file permission for ${displayPath(path, requested)}.\n${permsText()}`, "info");
			}
			if (action === "deny") {
				state.scopes.push({ path, mode: "deny" });
				await savePermissionsState(ctx);
				syncTools();
				return ctx.ui.notify(`Denied file path ${displayPath(path, requested)}.\n${permsText()}`, "info");
			}

			await savePermissionsState(ctx);
			syncTools();
			return ctx.ui.notify(`Removed file permission for ${displayPath(path, requested)}.\n${permsText()}`, "info");
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

	pi.on("session_start", async (_e, ctx) => {
		if (fskit) { await fskit.stop(); fskit = undefined; }
		fskitFailure = undefined;
		if (permissionController) {
			// Switching sessions must not promote the old session's leased grants
			// into independent authority when the new permission file is absent.
			Object.assign(state, permissionController.getPersistableSnapshot());
			delegationState = permissionController.getDelegationState();
			permissionController.dispose();
			permissionController = undefined;
		}
		loadPermissionsState(ctx);
		targets.setRemoteConfigs(state.sshTargets);
		for (const id of delegationState?.local.target ?? []) {
			const run = targets.resolveTarget(id);
			if (run && !state.targets.some((target) => target.id === id)) state.targets.push(run);
		}
		refreshSessionSystemPaths(ctx);
		setBackgroundContext(ctx);
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionBuiltInScopes = systemScopes.map((scope) => ({ ...scope }));
		// Replacing a session bridge invalidates old leases rather than renewing them.
		permissionsBridge().instances.get(sessionId)?.dispose?.();
		permissionController = new PermissionController(
			sessionId, state, sessionBuiltInScopes,
			(subset) => reducePermissionsSnapshot(state, subset, sessionBuiltInScopes),
			() => {
				targets.setRemoteConfigs(state.sshTargets);
				state.targets = state.targets.flatMap((target) => {
					const connected = targets.resolveTarget(target.id);
					if (connected) return [connected];
					return target.kind === "local" || target.kind === "remote" ? [target] : [];
				});
				updateFileBackend();
				// Do not call syncTools/savePermissionsState here: those publish changes.
				pi.setActiveTools(mergedActiveToolNames());
				persistPermissionsState(ctx);
			},
			delegationState,
		);
		permissionsBridge().instances.set(sessionId, permissionController);
		syncTools();
		fskitSession = sessionId;
		const controller = new FSKitController(new NativeMountDriver(), async (request, signal) => {
			if (!ctx.hasUI || fskitSession !== sessionId || signal.aborted) return false;
			const revision = permissionController?.getRevision();
			const allowed = await ctx.ui.confirm(`Allow FSKit ${request.access}?`, `${request.path}\nApplies to native item access until close or policy change.`, { signal });
			return allowed && !signal.aborted && fskitSession === sessionId && revision === permissionController?.getRevision();
		});
		try {
			await ensureFSKitSetup(pi, ctx);
			if (ctx.hasUI) ctx.ui.notify("FSKit: Mounting the session view and waiting for the initial policy acknowledgment…", "info");
			await controller.start([...state.scopes, ...systemScopes]);
			fskit = controller;
			if (ctx.hasUI) ctx.ui.notify("FSKit: Session filesystem ready.", "info");
		}
		catch (error) { fskitFailure = error as Error; ctx.ui.notify(`FSKit unavailable; file/VM tools blocked: ${fskitFailure.message}`, "error"); }
	});

	pi.on("tool_call", async () => {
		try {
			ensureCurrentPermissions();
			// Each target owns operation admission and filesystem readiness.
		}
		catch (error) {
			return { block: true, reason: `Permission refresh failed closed: ${error instanceof Error ? error.message : String(error)}` };
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		fskitSession = undefined;
		const controller = fskit; fskit = undefined;
		if (controller) await controller.stop().catch(error => ctx.ui.notify(`FSKit cleanup failed (IPC closed, access revoked): ${error.message}`, "error"));
		delete idleStatusBridge().backgroundActiveCount;
		if (permissionController) {
			Object.assign(state, permissionController.getPersistableSnapshot());
			delegationState = permissionController.getDelegationState();
			permissionController.dispose();
			permissionController = undefined;
		}
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
		ensureCurrentPermissions();
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
