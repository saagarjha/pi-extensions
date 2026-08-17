import { remoteUI, setOwnedStatus } from "../../shared/owned-ui.ts";
import { openBackgroundPanel } from "./background-panel.ts";
import { applyPermissionMutation, applySshPermissionMutation, assertPermissionRevision, validatePermissionMutation } from "./mutations.ts";
import { bindIdleStatus } from "../../shared/idle-status.ts";
import { randomUUID } from "node:crypto";
import { approvalRouter, publishService, type PermissionPort } from "../../shared/control-plane.ts";
import {
	createBackgroundTaskPort,
	backgroundOutput as renderBackgroundOutput,
} from "../../shared/background-activity.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { ensurePiFSSetup } from "../pifs/setup.ts";
import { PiFSController, NativeMountDriver } from "../pifs/index.ts";
import { TargetFiles } from "../../targets/files.ts";
import { copyWithRsync } from "../../targets/copy.ts";
import type { TargetAuthority } from "../../targets/access.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
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
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AskRequest } from "./ask.ts";
import { bindSharedPermissions, PermissionController, permissionsBridge, type PermissionInstance, type PermissionTool, type PermissionCommand, type PermissionRuntime, type PermissionNotification } from "./bridge.ts";
import { DeniedError } from "./fsops.ts";
import { createStructuredLsToolDefinition, type StructuredLsOperations } from "./structured-ls.ts";
import { withStructuredFind } from "./structured-find.ts";
import type { FindCapture, GrepCapture } from "../../targets/search.ts";
import { withStructuredGrep } from "./structured-grep.ts";
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
import { newestFirst, transitionTaskStatus } from "../../shared/task-lifecycle.ts";
import { sessionSystemRoot, syncTranscriptLink } from "../../shared/session-system.ts";
import { registerToolRenderers, type ToolRenderers } from "../../shared/tool-renderers.ts";
import { quiesceSubagents } from "../../subagents/quiesce.ts";

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

function sessionTranscriptPath(ctx: ExtensionContext): string {
	return join(sessionSystemRoot(ctx), "transcripts", "current.jsonl");
}

function prepareSessionSystemScopes(ctx: ExtensionContext): SystemScope[] {
	const root = sessionSystemRoot(ctx);
	const scratch = join(root, "scratch");
	const transcripts = join(root, "transcripts");
	const subagents = join(root, "subagents");
	mkdirSync(scratch, { recursive: true });
	mkdirSync(transcripts, { recursive: true });
	mkdirSync(subagents, { recursive: true });
	writeFileSync(join(root, "README.md"), [
		"# Pi session system directory",
		"",
		"scratch/ is a session-local writable workspace for temporary notes/files.",
		"transcripts/ contains read-only hardlinks/copies of this session's JSONL transcript so older history can be inspected after compaction.",
		"subagents/ contains read-only hardlinks/copies of this session's subagent transcripts, named <subagent-id>.jsonl, including dismissed subagents.",
		"",
	].join("\n"));
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile && existsSync(sessionFile)) {
		for (const name of ["current.jsonl", basename(sessionFile)]) {
			syncTranscriptLink(sessionFile, join(transcripts, name));
		}
	}
	return [
		...piDocsReadRoots().map((path) => ({ path, mode: "ro" as const, label: "pi docs" })),
		{ path: realIfExists(root), mode: "ro", label: "session system" },
		{ path: realIfExists(scratch), mode: "rw", label: "session scratch" },
		{ path: realIfExists(transcripts), mode: "ro", label: "session transcripts" },
		{ path: realIfExists(subagents), mode: "ro", label: "subagent transcripts" },
	];
}

function appendStreamingText(current: string, chunk: string): string {
	const maxChars = 20_000;
	const next = current + chunk;
	return next.length > maxChars ? `[output truncated: showing last ${maxChars} chars]\n${next.slice(-maxChars)}` : next;
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


/** Validate the entire command before its caller mutates permission state. */
function parseNetworkPermission(action: string, args: readonly string[]): NonNullable<State["network"]> {
	if (action === "remove" && args.length === 0) return "deny";
	const mode = args[0];
	if (action === "add" && args.length === 1 && (mode === "allow" || mode === "ask" || mode === "deny")) return mode;
	throw new Error("usage: /permissions add network <ask|allow|deny> | /permissions remove network");
}

export default function extension(pi: ExtensionAPI) {
	const idleStatusBridge = () => bridge;
	const bridge = bindIdleStatus(pi.events);
	const approvals = approvalRouter();
	let withdrawPort: (() => void) | undefined;
	let targets: TargetManager;
	let shuttingDown = false;
	let quiescence = new AbortController();
	let shutdown: Promise<void> | undefined;
	const sessionOperations = new Set<Promise<unknown>>();
	// Track our implementations, not Pi internals. ctx.abort() only signals
	// cancellation; join tools and mutating commands, but not UI-only monitors.
	function sessionOperation<T>(run: () => T | Promise<T>): Promise<T> {
		if (shuttingDown) return Promise.reject(new Error("Session is quiescing; operation admission is closed."));
		const signal = quiescence.signal;
		const operation = Promise.resolve().then(() => { signal.throwIfAborted(); return run(); });
		sessionOperations.add(operation);
		void operation.then(() => sessionOperations.delete(operation), () => sessionOperations.delete(operation));
		return operation;
	}
	let sharedPermissions: PermissionInstance | undefined;
	let ownerContext: ExtensionContext | undefined;
	const tools = new Map<string, PermissionTool>();
	const commands = new Map<string, PermissionCommand>();
	const operationOrigin = new AsyncLocalStorage<{ signal?: AbortSignal; notify?: PermissionNotification; toolNames?: string[]; notifyUi?: ExtensionContext["ui"]["notify"] }>();
	function operationSignal(): AbortSignal {
		const child = operationOrigin.getStore()?.signal;
		return child ? AbortSignal.any([child, quiescence.signal]) : quiescence.signal;
	}
	const runtime: PermissionRuntime = {
		executeTool: (name, args, notify, toolNames, notifyUi) => {
			const tool = tools.get(name);
			if (!tool || !ownerContext) throw new Error("Permission owner not initialized.");
			args[4] = ownerContext;
			return operationOrigin.run({ signal: args[2], notify, toolNames, notifyUi }, () => tool.execute(...args));
		},
		executeCommand: (name, args, signal, toolNames) => {
			const command = commands.get(name);
			if (!command || !ownerContext) throw new Error("Permission owner not initialized.");
			// Permission commands use only ExtensionContext fields, not session replacement actions.
			return operationOrigin.run({ signal, toolNames }, () => command.handler(args, ownerContext as Parameters<PermissionCommand["handler"]>[1]));
		},
		beforeAgentStart: (event) => sessionOperation(() => permissionPrompt(event, ownerContext!)),
	};
	const toolRenderers = new Map<string, ToolRenderers>();
	let unregisterRenderers: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		unregisterRenderers?.();
		unregisterRenderers = registerToolRenderers(ctx.sessionManager.getSessionId(), toolRenderers);
	});
	pi.on("session_shutdown", () => { unregisterRenderers?.(); unregisterRenderers = undefined; });
	const registerTool: ExtensionAPI["registerTool"] = (definition) => {
		toolRenderers.set(definition.name, { renderCall: definition.renderCall, renderResult: definition.renderResult, renderShell: definition.renderShell } as unknown as ToolRenderers);
		const tool: typeof definition = {
			...definition,
			execute: (...args) => {
				const creatorContext = args[4];
				const signal = args[2];
				args[2] = signal ? AbortSignal.any([signal, quiescence.signal]) : quiescence.signal;
				return sessionOperation(() => sharedPermissions
					? sharedPermissions.getOwner().runtime.executeTool(definition.name, args, (message, options) => {
						if (shuttingDown) return false;
						try { pi.sendMessage(message, options); return true; } catch { return false; }
					}, pi.getActiveTools(), (...notice) => {
						if (!shuttingDown && creatorContext.hasUI) creatorContext.ui.notify(...notice);
					})
					: operationOrigin.run({ ...operationOrigin.getStore(), signal: args[2] }, () => definition.execute(...args)));
			},
		};
		tools.set(definition.name, tool as unknown as PermissionTool);
		pi.registerTool(tool);
	};
	const registerPermissionCommand: ExtensionAPI["registerCommand"] = (name, definition) => {
		const command: PermissionCommand = { ...definition, handler: (...args) => {
			const run = () => sharedPermissions ? sharedPermissions.getOwner().runtime.executeCommand(name, args[0], quiescence.signal, pi.getActiveTools()) : definition.handler(...args);
			if (name === "background") return shuttingDown ? Promise.resolve() : run();
			return sessionOperation(run);
		} };
		commands.set(name, command);
		pi.registerCommand(name, command);
	};
	function vmOS(vmId: string, run?: RunningTarget): string {
		if (run?.kind === "linux" || run?.kind === "macos") return run.kind;
		const vm = targets.getVm(vmId);
		// Linux VM records can omit kind; macOS records always include it.
		return vm ? vm.kind ?? "linux" : "unknown";
	}
	let pifs: PiFSController | undefined;
	let pifsStarting: PiFSController | undefined;
	let pifsFailure: Error | undefined;
	let pifsSession: string | undefined;
	function requireFileBackend() {
		if (pifsFailure) throw pifsFailure;
		if (!pifs) throw new Error("The pifs session filesystem is not ready. Complete first-use helper setup.");
		pifs.assertReady();
	}
	function updateFileBackend() {
		const controller = pifs ?? pifsStarting;
		if (controller) void controller.update([...state.scopes, ...systemScopes]).catch(error => {
			if (!shuttingDown && (pifs === controller || pifsStarting === controller)) pifsFailure = error;
		});
	}
	function currentMountsCompatible(mounts: RunningTarget["mounts"]): boolean {
		requireFileBackend();
		return mounts.every(m => m.permissionSession === pifs!.mountIdentity && m.hostPath === pifs!.path("/") && m.logicalHostPath === "/");
	}

	// Session state. Deliberately not stored in tool-result details: grants are
	// real-world authorizations and must not rewind when the conversation does.
	const state: State = { scopes: [], vms: [], execGrants: [], sshTargets: [], network: "deny", targets: [] };
	let permissionController: PermissionController | undefined;
	// Only the root initializes system authority; children forward to its live environment.
	let systemScopes: SystemScope[] = piDocsReadRoots().map((path) => ({ path, mode: "ro", label: "pi docs" }));

	function refreshSessionSystemPaths(ctx: ExtensionContext): void {
		systemScopes = prepareSessionSystemScopes(ctx);
		updateFileBackend();
	}

	function ensureCurrentPermissions(): void {
		if (sharedPermissions) { sharedPermissions.getRevision(); return; }
		if (!permissionController) throw new Error("Permission state is not initialized.");
		permissionController.changed();
	}

	function mountsForCurrentScopes() {
		requireFileBackend();
		return [{ hostPath: pifs!.path("/"), guestPath: "/mnt/pi-host", mode: "rw" as const, logicalHostPath: "/", permissionSession: pifs!.mountIdentity }];
	}

	async function readyFileBackend(): Promise<void> {
		const controller = pifs;
		if (!controller) { requireFileBackend(); return; }
		// Every family member boots against the same stable root mount.
		await controller.waitForAck();
		quiescence.signal.throwIfAborted();
		if (pifs !== controller) throw new Error("Filesystem owner changed before VM boot");
		requireFileBackend();
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

	type PersistedPermissions = Pick<State, "scopes" | "vms" | "execGrants" | "sshTargets" | "network">;

	function permissionsStatePath(ctx: ExtensionContext): string {
		return join(ctx.sessionManager.getSessionDir(), "extension-state", "permissions", `${ctx.sessionManager.getSessionId()}.json`);
	}

	function loadPermissionsState(ctx: ExtensionContext): void {
		const path = permissionsStatePath(ctx);
		if (!existsSync(path)) return;
		try {
			const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedPermissions>;
			if ("delegation" in saved && saved.delegation !== undefined) return; // Never revive obsolete child authority.
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

	function persistPermissionsState(ctx: ExtensionContext): void {
		const path = permissionsStatePath(ctx);
		const saved = permissionController?.getPersistableSnapshot() ?? state;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ scopes: saved.scopes, vms: saved.vms, execGrants: saved.execGrants, sshTargets: saved.sshTargets, network: saved.network } satisfies PersistedPermissions, null, 2));
	}

	async function savePermissionsState(ctx: ExtensionContext): Promise<void> {
		quiescence.signal.throwIfAborted();
		permissionController?.changed();
		// Publish changes before subsequent operations are admitted.
		persistPermissionsState(ctx);
		if (pifs) await pifs.update([...state.scopes, ...systemScopes]);
		quiescence.signal.throwIfAborted();
	}

	function ensureExecGrant(targetId: string, command = "*", mode: "allow" | "ask" = "allow"): void {
		const existing = state.execGrants.find((g) => g.target === targetId && g.command === command);
		if (existing) {
			if (mode === "ask" && existing.mode === "allow") throw new Error("Cannot replace ask exec permission with allow");
			existing.mode = existing.mode === "ask" || mode === "ask" ? "ask" : "allow";
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
		permissionController?.changed();
		pi.setActiveTools(mergedActiveToolNames());
	}

	async function ask(ctx: ExtensionContext, req: AskRequest): Promise<boolean> {
		// Nobody there to answer, or admission already closed: decline.
		if (shuttingDown) return false;
		const controller = permissionController;
		const revision = controller?.getRevision();
		const body = [...(req.detail ?? []).map((d) => `  • ${d}`), req.onDecline ? `\nIf declined: ${req.onDecline}` : ""]
			.filter(Boolean)
			.join("\n");
		const signal = operationSignal();
		const approved = await approvals.confirm(req, signal, () =>
			ctx.hasUI ? ctx.ui.confirm(req.operation, body, { signal }) : Promise.resolve(false),
		);
		if (signal.aborted) return false;
		if (shuttingDown) return false;
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
			current() { ensureCurrentPermissions(); return { state, systemScopes, proxy: pifs }; },
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
				if (pifs) await pifs.update([...state.scopes, ...systemScopes]);
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

	registerTool({
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
			// Explicit value-only snapshot: never expose backend objects or retain live state arrays.
			const capabilities = {
				files: state.scopes.map(({ path, mode }) => ({ path, mode })),
				systemPaths: systemScopes.map(({ path, mode, label }) => ({ path, mode, label })),
				network: state.network ?? "deny",
				vms: state.vms.map((v) => {
					const run = state.targets.find((t) => t.vm?.id === v.vmId);
					return { id: v.vmId, os: vmOS(v.vmId, run), mode: v.mode, networkGrant: !!v.network,
						attachment: run ? "running" : "not-attached", execCapable: run ? !!run.exec : null, network: run ? !!run.network : null };
				}),
				sshTargets: state.sshTargets.map(({ id, destination, port }) => ({ id, destination, ...(port !== undefined ? { port } : {}) })),
				execGrants: state.execGrants.map(({ target, command, mode }) => ({ target, command, mode })),
				runningTargets: state.targets.map((t) => {
					const vmGrant = vmScope(state, t.vm?.id);
					const vmMode = vmGrant?.mode ?? "deny";
					const execGrant = state.execGrants.find((grant) => grant.target === t.id && grant.command === "*");
					// Match the existing VM-only display predicate; no inferred non-VM exec permission.
					const vmExec: { status: "allowed" | "approval-required" | "blocked"; blockedReason?: "mounts-exceed-permissions" | "network-denied" } | null = t.exec && t.vm && canWriteMode(vmMode)
						? (pifsFailure || !pifs || !currentMountsCompatible(t.mounts)) ? { status: "blocked", blockedReason: "mounts-exceed-permissions" }
							: t.network && !vmGrant?.network && state.network !== "allow" && state.network !== "ask" ? { status: "blocked", blockedReason: "network-denied" }
							: asksForVerb(vmMode, "write") || execGrant?.mode === "ask" || (t.network && !vmGrant?.network && state.network === "ask") ? { status: "approval-required" } : { status: "allowed" }
						: null;
					return { id: t.id, kind: t.kind, execCapable: !!t.exec, network: !!t.network,
						vmId: t.vm?.id ?? null, vmExec,
						mounts: t.mounts.map(({ hostPath, guestPath, mode }) => ({ hostPath, guestPath, mode })) };
				}),
				tools: [...(operationOrigin.getStore()?.toolNames ?? mergedActiveToolNames())],
			};
			const running = capabilities.runningTargets.map((t) => {
				const vmExec = t.vmExec?.status === "blocked"
					? t.vmExec.blockedReason === "mounts-exceed-permissions" ? " [access blocked: mounts exceed permissions]" : " [access blocked: network denied]"
					: t.vmExec?.status === "approval-required" ? " [exec requires approval]" : t.vmExec?.status === "allowed" ? " [exec allowed]" : "";
				return `  ${t.id}${t.execCapable ? " [exec-capable]" : ""}${vmExec}${t.kind === "remote" ? " [ssh]" : ""}${t.network ? " [network]" : ""}` +
					(t.mounts.length ? `\n${t.mounts.map((m) => `      ${m.hostPath} → ${m.guestPath} (${m.mode})`).join("\n")}` : "");
			});
			const systemRoots = capabilities.systemPaths;
			const lines = [
				"files:",
				...(capabilities.files.length ? capabilities.files.map((s) => `  ${s.mode.padEnd(9)} ${s.path}`) : ["  none"]),
				...(systemRoots.length ? ["system:", ...systemRoots.map((s) => `  ${s.mode.padEnd(9)} ${s.path}  (${s.label})`)] : []),
				`network: ${capabilities.network}`,
				"vms:",
				...(capabilities.vms.length ? capabilities.vms.map((v) =>
					`  ${v.mode.padEnd(9)} ${v.id} [${v.os}]${v.networkGrant ? " +network" : ""} ${v.attachment === "running" ? `running${v.execCapable ? " [exec]" : ""}${v.network ? " [network]" : ""}` : "not attached"}`
				) : ["  none"]),
				"ssh targets:",
				...(capabilities.sshTargets.length ? capabilities.sshTargets.map((s) => `  ${s.id} ${s.destination}${s.port !== undefined ? `:${s.port}` : ""}`) : ["  none"]),
				"exec grants:",
				...(capabilities.execGrants.length ? capabilities.execGrants.map((g) => `  ${g.mode.padEnd(5)} ${g.target} ${g.command}`) : ["  none"]),
				"running:",
				...(running.length ? running : ["  none"]),
				`tools: ${capabilities.tools.join(", ") || "none"}`,
			];
			const hints: string[] = [];
			if (!verbs.some((v) => v === "read" || v === "ls" || v === "find" || v === "grep")) hints.push("read/ls/find/grep need readable file or VM access.");
			if (!verbs.some((v) => v === "write" || v === "edit")) hints.push("write/edit need writable file or VM access.");
			if (!verbs.includes("bash")) hints.push("bash/bg_start need a running exec-capable target with an exec grant or current writable VM access; ask permissions require approval.");
			const modelLines = [...lines, ...hints.map((hint) => `hint: ${hint}`)];
			return ok(modelLines.join("\n"), { display: lines.join("\n"), capabilities });
		},
		renderResult(result: any) {
			const text = result.details?.display ?? result.content?.map((part: any) => part.text ?? "").join("\n") ?? "";
			return { invalidate() {}, render: (width: number) => text.split("\n").map((line: string) => truncateToWidth(line, width)) };
		},
	});

	const macOSBootOptionsParam = Type.Optional(Type.Object({
		cpuCount: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Virtual CPUs for this macOS boot only. Omit to use the OS minimum; stop a running VM before changing resources." })),
		ramMiB: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "RAM for this macOS boot only, in MiB. Omit to use the OS minimum. Not persisted across stops or reloads." })),
	}));

	registerTool({
		name: "vm_create",
		label: "Create VM",
		description:
			"Create a fresh VM and start it as a running exec target. Unnamed scratch creation itself needs no approval, but networking may require it. The default Linux base is minimal ubuntu:latest: basic shell/userland only, with no scripting runtimes. Linux networking is optional; macOS always requires network permission.",
		promptSnippet: "Create and start a VM target",
		promptGuidelines: [
			"Use vm_create when you need an executable target and no suitable exec-enabled target is already available.",
			"Session-owned VMs are stopped and saved on shutdown/reload. Their grants are restored inactive; use vm_start explicitly to boot them again.",
			"Prefer an unnamed vm_create — scratch creation itself is free and needs no approval; network authorization still applies.",
			"The default VM is intentionally minimal Ubuntu: basic shell/userland only, not much else — in particular, no scripting runtimes unless you install them.",
			"For Linux, if you only need network to install or fetch dependencies, keep that phase short, then vm_stop and vm_start without network before reading or processing user files. macOS VMs cannot run without networking.",
		],
		parameters: Type.Object({
			os: Type.Optional(Type.Union([Type.Literal("linux"), Type.Literal("macos")], { description: "VM operating system; Linux is the default. macOS requires Apple Silicon macOS 27+ and network permission for every boot." })),
			name: Type.Optional(Type.String({ description: "Only for a durable, reusable VM. Omit for a generated scratch id." })), 
			base: Type.Optional(Type.String({ description: "Existing VM to fork from. Omit this field to use the built-in minimal ubuntu:latest base." })),
			network: Type.Optional(Type.Boolean({ description: "Request Linux networking. macOS always uses networking, even if false or omitted. Requires approval unless network is already allowed." })),
			options: macOSBootOptionsParam,
		}),
		renderCall(args: any, theme: any) {
			return toolCallLine(["vm_create", args?.os ? `os=${args.os}` : undefined, args?.name, args?.base ? `base=${args.base}` : undefined, args?.options?.cpuCount !== undefined ? `cpus=${args.options.cpuCount}` : undefined, args?.options?.ramMiB !== undefined ? `ramMiB=${args.options.ramMiB}` : undefined, args?.network ? "network" : undefined], theme);
		},
		async execute(_id, params, _signal, onUpdate, ctx) {
			// Resources configure the initial boot, not the created filesystem.
			if (params.os !== "macos" && (params.options?.cpuCount !== undefined || params.options?.ramMiB !== undefined)) return bad("CPU/RAM boot options are currently supported only for macOS VMs.");
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
				await readyFileBackend();
				const vm = await targets.createVm({ os: params.os, name: createName, base: baseId, network: wantsNetwork, onOutput });
				state.vms.push({ vmId: vm.id, mode: "rw" });
				await savePermissionsState(ctx);
				refreshSessionSystemPaths(ctx);
				await readyFileBackend();
				const run = await targets.start(vm.id, {
					mounts: mountsForCurrentScopes(),
					network: wantsNetwork,
					options: params.options,
					onOutput,
				});
				state.targets = state.targets.filter((t) => t.id !== run.id);
				state.targets.push(run);
				ensureExecGrant(run.id);
				await savePermissionsState(ctx);
				syncTools();
				const networkNote = vmNetworkNote(run);
				return ok(`Created and started ${vm.id}.${networkNote}`, {
					vm: { id: vm.id, os: vm.kind ?? run.kind },
					target: { id: run.id, network: run.network, execCapable: run.exec },
					parameters: {
						os: vm.kind ?? run.kind,
						...(createName !== undefined ? { name: createName } : {}),
						...(baseId !== undefined ? { base: baseId } : {}),
						network: run.network,
						// Requested initial-boot resources, not measured allocations or defaults.
						...(params.options !== undefined ? { options: {
							...(params.options.cpuCount !== undefined ? { cpuCount: params.options.cpuCount } : {}),
							...(params.options.ramMiB !== undefined ? { ramMiB: params.options.ramMiB } : {}),
						} } : {}),
					},
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

	registerTool({
		name: "vm_start",
		label: "Start VM",
		description:
			"Adopt an added VM into this session by starting it as a running target. Session-owned VMs are stopped/saved on shutdown or reload; restarting them remains explicit. " +
			"Host files are exposed only through this session's policy-enforcing pifs proxy; nested rules and reverse approvals stay live. " +
			"For macOS, sip requests a persisted SIP state; a mismatch is privately reprovisioned before this visible boot. Linux networking is off by default; macOS always requires network permission, including private provisioning boots. Networking requires approval or an existing session/VM network permission. Only Linux can be restarted without network.",
		promptSnippet: "Start/adopt an added VM as a running target",
		parameters: Type.Object({
			vmId: Type.String({ description: "VM id to start, e.g. scratch-abc123" }),
			network: Type.Optional(Type.Boolean({ description: "Request Linux networking. macOS always uses networking, even if false or omitted. Requires approval or an existing session/VM network permission." })),
			sip: Type.Optional(StringEnum(["enabled", "disabled"] as const, { description: "Desired persisted SIP state for a macOS VM. Omit to retain its current state." })),
			options: macOSBootOptionsParam,
		}),
		renderCall(args: any, theme: any) {
			return toolCallLine(["vm_start", args?.vmId, args?.sip ? `sip=${args.sip}` : undefined, args?.options?.cpuCount !== undefined ? `cpus=${args.options.cpuCount}` : undefined, args?.options?.ramMiB !== undefined ? `ramMiB=${args.options.ramMiB}` : undefined, args?.network ? "network" : undefined], theme);
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
				await readyFileBackend();
				const run = await targets.start(vmId, {
					mounts: mountsForCurrentScopes(),
					network: wantsNetwork,
					sip: params.sip,
					options: params.options,
					onOutput: (chunk) => {
						progress = appendStreamingText(progress, chunk);
						onUpdate?.(ok(progress));
					},
				});
				state.targets = state.targets.filter((t) => t.id !== run.id);
				state.targets.push(run);
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

	registerTool({
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

	registerTool({
		name: "vm_list",
		label: "List VMs",
		description: "List managed VMs and whether they are attached to this session; unattached does not prove backend shutdown.",
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return toolCallLine(["vm_list"], theme);
		},
		async execute() {
			try {
				const vms = targets.listVms();
				return ok(vms.length ? vms.map((v) => {
					const run = state.targets.find((t) => t.vm?.id === v.id);
					return `${v.id}${v.name ? ` (${v.name})` : ""} [${v.kind ?? "linux"}] ${run ? "attached" : "not attached"}${v.sip ? ` [sip=${v.sip}]` : ""}${v.published ? " [published]" : ""}`;
				}).join("\n") : "(none)");
			} catch (err) {
				return bad(`vm_list failed: ${(err as Error).message}`);
			}
		},
	});

	registerTool({
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
				await savePermissionsState(ctx);
				syncTools();
				return ok(`Destroyed ${vmId}.`);
			} catch (err) {
				return bad(`vm_destroy failed: ${(err as Error).message}`);
			}
		},
	});

	registerTool({
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
		makeOperations: (files: TargetFiles, signal?: AbortSignal, grepCapture?: GrepCapture) => any,
		massageParams: (params: any) => any = (params) => params,
	) {
		const shell = factory("/");
		registerTool({
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
					const grepCapture: GrepCapture | undefined = verb === "grep" ? { limit: Math.max(1, params.limit ?? 100), matchCount: 0, matches: [], files: new Map(), incomplete: false } : undefined;
					const base = factory(factoryCwd, { operations: makeOperations(files, signal, grepCapture), target: params.target });
					const { target: _target, ...innerParams } = params;
					const execute = (path?: string): Promise<any> => base.execute(id, path ? { ...innerParams, path } : innerParams, signal, onUpdate, factoryContextWithCwd(ctx, factoryCwd));
					if (recursive) {
						const capture: FindCapture | undefined = verb === "find" ? { records: [], incomplete: false } : undefined;
						const result = await files.search(verb === "find" ? "fd" : "rg", pathForDecision, signal, execute, capture, grepCapture);
						if (grepCapture) return withStructuredGrep(result, grepCapture, params.target, params.pattern, params.context);
						return capture ? withStructuredFind(result, capture, params.target, params.pattern) : result;
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
	registerBuiltInFsTool("ls", createStructuredLsToolDefinition, (files, signal): StructuredLsOperations => {
		return { exists: path => files.exists(path, signal), stat: path => files.stat(path, signal), readdir: path => files.readdir(path, signal), lstat: path => files.lstat(path, signal) };
	});
	// No custom glob: Pi's actual fd launcher and parser must run inside the seam.
	registerBuiltInFsTool("find", createFindToolDefinition, () => undefined);
	registerBuiltInFsTool("grep", createGrepToolDefinition, (files, signal, capture) => {
		return {
			isDirectory: (path: string) => files.searchIO(async () => {
				const value = (await files.stat(path, signal)).isDirectory();
				if (capture) capture.isDirectory = value;
				return value;
			}),
			readFile: (path: string) => files.searchIO(async () => {
				const content = (await readBuffer(files, path, signal)).toString("utf8");
				capture?.files.set(path, content);
				return content;
			}),
		};
	});
	registerBuiltInFsTool("write", createWriteToolDefinition, (files, signal): WriteOperations => {
		return { mkdir: path => files.mkdirParents(path, signal), writeFile: (path, content) => writeBuffer(files, path, Buffer.from(content), signal) };
	}, params => ({ ...params, content: params.content ?? params.contents }));
	registerBuiltInFsTool("edit", createEditToolDefinition, (files, signal): EditOperations => {
		return { access: async path => { await files.stat(path, signal); }, readFile: path => readBuffer(files, path, signal), writeFile: (path, content) => writeBuffer(files, path, Buffer.from(content), signal) };
	});

	registerTool({
		name: "copy",
		label: "Copy",
		description: "Copy files, symlinks, or directory contents between targets using rsync. Copies permitted portions of directory trees; denied paths are skipped. Symlinks are copied as links. Requires read permission on non-SSH sources and write permission on non-SSH destinations; SSH sources/destinations require exec '*' on that SSH target. The effective destination must not exist unless overwrite is true; merging into an existing directory requires overwrite. Requires rsync on the participating targets.",
		promptSnippet: "Copy files/directories between targets with read permission on the source and write permission on the destination",
		parameters: Type.Object({
			sourceTarget: targetParam,
			sourcePath: Type.String({ description: "Source file or directory path on sourceTarget." }),
			destTarget: targetParam,
			destPath: Type.String({ description: "Destination path on destTarget. For directory sources, source contents are copied into this directory." }),
			overwrite: Type.Optional(Type.Boolean({ description: "Allow replacing existing entries and merging into existing directories. Otherwise the effective destination must not exist. Defaults to false." })),
		}),
		renderCall(args: any, theme: any) {
			const source = `${args?.sourceTarget ?? "?"}:${args?.sourcePath ?? "?"}`;
			const dest = `${args?.destTarget ?? "?"}:${args?.destPath ?? "?"}`;
			const flags = args?.overwrite ? "overwrite" : "";
			const name = theme.fg("toolTitle", theme.bold?.("copy") ?? "copy");
			const line = `${name} ${theme.fg("toolOutput", source)} ${theme.fg("muted", "→")} ${theme.fg("toolOutput", dest)}${flags ? theme.fg("muted", ` (${flags})`) : ""}`;
			return { invalidate() {}, render: (width: number) => [truncateToWidth(line, width)] };
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			refreshSessionSystemPaths(ctx);
			try {
				const authority = targetAuthority(ctx);
				const source = await targets.access(params.sourceTarget, authority).copy("read", params.sourcePath, ctx.cwd);
				const destination = await targets.access(params.destTarget, authority).copy("write", params.destPath, ctx.cwd);
				const asks = [...source.asks, ...destination.asks];
				if (asks.length && !await authority.ask({ operation: "Allow filesystem access for this copy?", detail: asks })) return bad("Copy was not approved.");
				source.assertReady(); destination.assertReady();
				const requestDetails = {
					source: { target: source.target.id, requestedPath: params.sourcePath },
					destination: { target: destination.target.id, requestedPath: params.destPath },
					overwrite: params.overwrite ?? false,
				};
				const { skipped, sourcePath, destinationPath, sourceIsDirectory } = await copyWithRsync(
					{ endpoint: targets.copyEndpoint(source.target), path: source.path, scopes: source.scopes },
					{ endpoint: targets.copyEndpoint(destination.target), path: destination.path, scopes: destination.scopes },
					params, signal, text => onUpdate?.(ok(text, requestDetails)),
				);
				return ok(`Copy completed.${skipped ? " Restricted paths were excluded from this copy." : ""}`, {
					display: `Copy completed${skipped ? " (permission-filtered)" : ""}`,
					source: { target: source.target.id, path: sourcePath, requestedPath: params.sourcePath },
					destination: { target: destination.target.id, path: destinationPath, requestedPath: params.destPath },
					sourceIsDirectory,
					overwrite: params.overwrite ?? false,
					permissionFiltered: Boolean(skipped),
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

	type BackgroundJobRecord = {
		id: string;
		target: string;
		command: string;
		cwd: string;
		timeoutMs?: number;
		status: "running" | "done" | "failed" | "stopped" | "interrupted";
		startedAt: number;
		updatedAt: number;
		exitCode?: number;
		error?: string;
		output: string;
		completionRead?: boolean;
		completionNotified?: boolean;
		remote?: RemoteSshJob;
	};
	type BackgroundJob = BackgroundJobRecord & {
		notify?: PermissionNotification;
		notifyUi?: ExtensionContext["ui"]["notify"];
		controller?: AbortController;
		launch?: Promise<void>;
		run?: Promise<void>;
		stop?: Promise<void>;
	};
	const backgroundJobs = new Map<string, BackgroundJob>();
	const backgroundOperations = new Set<Promise<unknown>>();
	const foregroundSshControllers = new Set<AbortController>();
	let backgroundSessionId: string | undefined;
	let backgroundSession: ExtensionContext["sessionManager"] | undefined;
	let backgroundShuttingDown = false;
	let backgroundShutdown: Promise<void> | undefined;
	const BACKGROUND_ENTRY = "permissions.background-job";

	function trackBackgroundOperation<T>(operation: () => Promise<T>): Promise<T> {
		// Register before starting authorization, launch, or any asynchronous finalization.
		const pending = Promise.resolve().then(operation);
		backgroundOperations.add(pending);
		void pending.then(() => backgroundOperations.delete(pending), () => backgroundOperations.delete(pending));
		return pending;
	}
	function assertBackgroundAdmission(ctx: ExtensionContext) {
		if (backgroundShuttingDown || backgroundSessionId !== ctx.sessionManager.getSessionId()) {
			return bad("Background command admission is closed for this session.");
		}
	}
	function persistBackgroundJob(job: BackgroundJob) {
		if (!backgroundSessionId || backgroundSession?.getSessionId() !== backgroundSessionId) return;
		const { controller: _controller, launch: _launch, run: _run, stop: _stop, notify: _notify, notifyUi: _notifyUi, ...record } = job;
		pi.appendEntry(BACKGROUND_ENTRY, { sessionId: backgroundSessionId, job: { ...record, remote: record.remote && { ...record.remote } } });
	}
	function restoreBackgroundJobs(ctx: ExtensionContext) {
		backgroundSession = ctx.sessionManager;
		backgroundSessionId = ctx.sessionManager.getSessionId();
		backgroundJobs.clear();
		// Scan the whole owning session, not getBranch(): /tree must not rewind jobs.
		// Forks copy entries but have a different session id and cannot adopt them.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== BACKGROUND_ENTRY) continue;
			const data = entry.data as { sessionId?: string; job?: Partial<BackgroundJobRecord> } | undefined;
			const record = data?.job;
			if (data?.sessionId !== backgroundSessionId || !record
				|| typeof record.id !== "string" || typeof record.target !== "string"
				|| typeof record.command !== "string" || typeof record.cwd !== "string"
				|| typeof record.output !== "string" || typeof record.startedAt !== "number"
				|| typeof record.updatedAt !== "number"
				|| !["running", "done", "failed", "stopped", "interrupted"].includes(record.status ?? "")) continue;
			backgroundJobs.set(record.id, {
				id: record.id, target: record.target, command: record.command, cwd: record.cwd,
				timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
				status: record.status!, startedAt: record.startedAt, updatedAt: record.updatedAt,
				exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
				error: typeof record.error === "string" ? record.error : undefined, output: record.output,
				completionRead: record.completionRead === true, completionNotified: record.completionNotified === true,
				remote: record.remote && typeof record.remote.jobId === "string" && typeof record.remote.session === "string" && typeof record.remote.cwd === "string"
					? { jobId: record.remote.jobId, session: record.remote.session, cwd: record.remote.cwd } : undefined,
			});
		}
		for (const job of backgroundJobs.values()) {
			if (job.status !== "running") continue;
			// No reconnection or replay. An unconfirmed remote stop is not proof of termination.
			job.status = "interrupted";
			job.updatedAt = Date.now();
			job.completionRead = false;
			job.error = [job.error, "Inactive after session shutdown; no live command handle retained. Remote execution, if any, is unconfirmed."].filter(Boolean).join("\n");
			persistBackgroundJob(job);
		}
	}
	function shutdownBackgroundJobs(ctx: ExtensionContext): Promise<void> {
		backgroundShuttingDown = true;
		return backgroundShutdown ??= (async () => {
			for (const controller of foregroundSshControllers) controller.abort();
			const attempted = new Set<BackgroundJob>();
			do {
				for (const job of backgroundJobs.values()) {
					if (job.status !== "running") { job.controller?.abort(); continue; }
					if (attempted.has(job)) continue;
					attempted.add(job);
					void trackBackgroundOperation(async () => {
						try { await stopBackgroundJob(ctx, job); }
						catch (error) { ctx.ui.notify(`Background ${job.id} stop failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
						finally { job.controller?.abort(); }
					});
				}
				// Includes accepted launches, followers, stops, and their outcome persistence.
				await Promise.allSettled([...backgroundOperations]);
			} while (backgroundOperations.size || [...backgroundJobs.values()].some((job) => job.status === "running" && !attempted.has(job)));
			for (const job of backgroundJobs.values()) persistBackgroundJob(job);
		})();
	}
	const backgroundActiveCount = () => [...backgroundJobs.values()].filter((job) => job.status === "running").length;
	let backgroundUiCtx: ExtensionContext | undefined;
	const backgroundListeners = new Set<() => void>();
	let backgroundRevision = 0;
	const FOREGROUND_BASH_MAX_TIMEOUT_MS = 600_000;
	const backgroundId = () => `bg_${Math.random().toString(36).slice(2, 8)}`;
	function backgroundList() { return newestFirst(backgroundJobs.values(), (job) => job.updatedAt); }
	function notifyBackgroundChanged() {
		backgroundRevision++;
		for (const listener of backgroundListeners) listener();
		refreshBackgroundUi();
	}
	function notifyBackgroundCompletion(job: BackgroundJob) {
		if (backgroundShuttingDown || job.status === "running" || job.completionNotified) return;
		job.completionNotified = true;
		const exit = job.exitCode === undefined ? "" : ` (exit ${job.exitCode})`;
		const statusLabel = job.status === "done" ? "finished" : job.status;
		try {
			const message = {
				customType: "background.completion",
				display: true,
				content: `Background command ${job.id} ${statusLabel}${exit}.\n\nCommand: ${job.command}\n\nUse bg_status with id ${job.id} to view buffered output.`,
				details: { id: job.id, target: job.target, cwd: job.cwd, command: job.command, status: job.status, exitCode: job.exitCode, error: job.error },
			};
			const options = { triggerTurn: true, deliverAs: "followUp" as const };
			if (!job.notify?.(message, options)) pi.sendMessage(message, options);
		} catch {}
		finally { job.notify = undefined; }
		const ctx = backgroundUiCtx;
		try {
			const kind = job.status === "done" ? "info" : job.status === "stopped" ? "warning" : "error";
			const notice = `Background ${job.id} ${statusLabel}${exit}: ${job.command}`;
			// Shared resources keep their global monitor, but completion toasts belong
			// to the caller. An inactive child callback must not fall back to root UI.
			if (job.notifyUi) job.notifyUi(notice, kind);
			else if (ctx?.hasUI) ctx.ui.notify(notice, kind);
		} catch {
			if (!job.notifyUi) backgroundUiCtx = undefined;
		} finally { job.notifyUi = undefined; }
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
		if (markRead) for (const job of jobs) {
			job.completionRead = true;
			persistBackgroundJob(job);
		}
		return jobs;
	}
	function unreadBackgroundCompletions(markRead = false) {
		return unreadBackgroundCompletionJobs(markRead).map(backgroundCompletionSummary);
	}
	function unreadBackgroundCompletionDisplays() {
		return unreadBackgroundCompletionJobs(false).map(backgroundCompletionDisplay);
	}
	function transitionBackgroundJob(job: BackgroundJob, status: BackgroundJob["status"]) {
		if (job.status !== "running") return;
		return transitionTaskStatus(job, status);
	}
	function finishBackgroundJob(job: BackgroundJob, exitCode: number | null | undefined) {
		if (job.status !== "running") return;
		job.exitCode = exitCode ?? undefined;
		transitionBackgroundJob(job, exitCode === 0 || exitCode === undefined ? "done" : "failed");
		notifyBackgroundCompletion(job);
		persistBackgroundJob(job);
		notifyBackgroundChanged();
	}
	function failBackgroundJob(job: BackgroundJob, error: unknown) {
		if (job.status !== "running") return;
		job.error = error instanceof Error ? error.message : String(error);
		transitionBackgroundJob(job, "failed");
		notifyBackgroundCompletion(job);
		persistBackgroundJob(job);
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
	function syncRemoteBackgroundJob(ctx: ExtensionContext, job: BackgroundJob, tailChars = 8000) {
		return trackBackgroundOperation(async () => {
			if (backgroundShuttingDown || !job.remote || job.status !== "running") return;
			const cfg = await authorizeRemoteBackgroundJob(ctx, job);
			if (backgroundShuttingDown || job.status !== "running") return;
			const remote = await targets.remoteJobStatus(cfg, job.remote, tailChars);
			if (job.status !== "running") return;
			const previous = { output: job.output, error: job.error, exitCode: job.exitCode, status: job.status, updatedAt: job.updatedAt };
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
			// Reads can request different tail lengths. A matching suffix alone
			// isn't evidence of new output; live stream chunks track that activity.
			const sameOutputTail = job.output === previous.output || Boolean(job.output && previous.output
				&& (job.output.endsWith(previous.output) || previous.output.endsWith(job.output)));
			if (sameOutputTail && job.error === previous.error && job.exitCode === previous.exitCode && job.status === previous.status) {
				job.updatedAt = previous.updatedAt;
			}
			notifyBackgroundCompletion(job);
			persistBackgroundJob(job);
			notifyBackgroundChanged();
		});
	}
	function stopBackgroundJob(ctx: ExtensionContext, job: BackgroundJob): Promise<void> {
		return job.stop ??= trackBackgroundOperation(async () => {
			try {
				// A shutdown may arrive while the accepted SSH launch is still in flight.
				await job.launch?.catch(() => {});
				if (job.status !== "running") return;
				if (job.remote) {
					const cfg = await authorizeRemoteBackgroundJob(ctx, job);
					if (job.status !== "running") return;
					await targets.stopRemoteJob(cfg, job.remote);
				}
				// Local/VM cancellation only aborts existing work; it opens no new connection.
				job.controller?.abort();
				// Keep the owner visibly running until execution and its output pipes
				// have actually settled. An abort request is not a completed stop.
				await job.run;
				transitionBackgroundJob(job, "stopped");
				notifyBackgroundCompletion(job);
			} catch (error) {
				job.error = `Stop failed: ${error instanceof Error ? error.message : String(error)}`;
				job.updatedAt = Date.now();
				throw error;
			} finally {
				job.stop = undefined;
				persistBackgroundJob(job);
				notifyBackgroundChanged();
			}
		});
	}

	function backgroundPortFor(
		ctx: ExtensionContext,
		check: () => void,
		subscriptions?: Set<() => void>,
	) {
		const sessionId = ctx.sessionManager.getSessionId();
		return createBackgroundTaskPort({
			check: () => {
				check();
				if (backgroundSessionId !== sessionId) throw Error("Background service retired.");
			},
			revision: () => backgroundRevision,
			list: backgroundList,
			get: (id) => backgroundJobs.get(id),
			subscribe: (listener) => {
				backgroundListeners.add(listener);
				const off = () => {
					backgroundListeners.delete(listener);
					subscriptions?.delete(off);
				};
				subscriptions?.add(off);
				return off;
			},
			stop: (job) =>
				sessionOperation(async () => {
					check();
					ensureCurrentPermissions();
					if (backgroundJobs.get(job.id) !== job) throw Error("Background job retired.");
					if (job.status === "running") await stopBackgroundJob(ctx, job);
				}),
		});
	}

	function refreshBackgroundUi() {
		const ctx = backgroundUiCtx;
		try { if (!ctx?.hasUI) return; } catch { backgroundUiCtx = undefined; return; }
		const jobs = backgroundList();
		const running = jobs.filter((job) => job.status === "running").length;
		if (jobs.length === 0) {
			setOwnedStatus(ctx.ui, "background", undefined);
			ctx.ui.setWidget("background", undefined);
			return;
		}
		const counts = {
			running,
			done: jobs.filter((job) => job.status === "done").length,
			failed: jobs.filter((job) => job.status === "failed" || job.status === "stopped" || job.status === "interrupted").length,
		};
		setOwnedStatus(ctx.ui, "background", { kind: "background", total: jobs.length, ...counts });
		ctx.ui.setWidget("background", undefined);
	}


	class TargetBashCall extends Text {
		prompt = "$";
		override setText(text: string) {
			const dollar = text.indexOf("$");
			// Replace only Pi's prompt, before its Text component wraps/caches it.
			// Keep the original leading styles on the command, not our prompt.
			super.setText(dollar < 0 ? text : `${this.prompt}${text.slice(0, dollar)}${text.slice(dollar + 1)}`);
		}
	}

	const baseBashRenderCall = bashRenderer.renderCall;
	// prepareArguments is typed against the base bash schema ({ command, timeout }),
	// which does not include our target param. Drop it rather than inherit a shim
	// that would strip target if the base tool ever defines one.
	const { prepareArguments: _prepareBashArguments, ...bashRendererShared } = bashRenderer;
	registerTool({
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
				assertBackgroundAdmission(ctx);
				const cfg = sshConfig(g.t.id);
				if (!cfg) return bad(`ssh target not found: ${g.t.id}`);
				const controller = new AbortController();
				const abort = () => controller.abort();
				if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
				foregroundSshControllers.add(controller);
				return trackBackgroundOperation(async () => {
					const jobId = backgroundId();
					const cwd = "/";
					const startedAt = Date.now();
					let output = "";
					try {
						assertBackgroundAdmission(ctx);
						const remote = await targets.launchRemoteJob(cfg, jobId, params.command, cwd);
						if (backgroundShuttingDown) throw new SshJobContinuesError("Session shutdown during SSH launch", remote);
						const append = (chunk: Buffer) => {
							output = appendStreamingText(output, chunk.toString());
							onUpdate?.(ok(output) as any);
						};
						const result = await targets.followRemoteJob(cfg, remote, { signal: controller.signal, timeoutMs, onData: append });
						const suffix = result.exitCode === undefined || result.exitCode === 0 ? "" : `\n\n[ssh ${g.t.id} exited ${result.exitCode}]`;
						const text = `${output}${suffix}` || "(no output)";
						if (result.exitCode !== undefined && result.exitCode !== 0) return bad(text);
						return ok(text) as any;
					} catch (err) {
						if (err instanceof SshJobContinuesError) {
							const job: BackgroundJob = { id: jobId, target: g.t.id, command: params.command, cwd, timeoutMs, status: "running", startedAt, updatedAt: Date.now(), output, controller: new AbortController(), remote: err.remote, notify: operationOrigin.getStore()?.notify, notifyUi: operationOrigin.getStore()?.notifyUi };
							backgroundJobs.set(job.id, job);
							persistBackgroundJob(job);
							notifyBackgroundChanged();
							return ok(`SSH connection ended while waiting; command continues as background job ${job.id}.`, { display: `Continues as ${job.id} [running] target=${job.target}` }) as any;
						}
						return bad(`ssh bash failed: ${err instanceof Error ? err.message : String(err)}`);
					} finally {
						signal?.removeEventListener("abort", abort);
						foregroundSshControllers.delete(controller);
					}
				});
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
				const { target, timeoutMs, ...inner } = args ?? {};
				const call = context.lastComponent instanceof TargetBashCall ? context.lastComponent : new TargetBashCall("", 0, 0);
				call.prompt = theme.fg("dim", target ?? "?") + theme.fg("muted", "$");
				return baseBashRenderCall(
					{ ...inner, timeout: timeoutMs === undefined ? undefined : timeoutMs / 1000 },
					theme,
					{ ...context, lastComponent: call },
				);
			},
		}),
		renderResult: bashRenderer.renderResult,
	});

	registerTool({
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
			assertBackgroundAdmission(ctx);
			return trackBackgroundOperation(async () => {
				const g = await authorizeExec(ctx, params);
				assertBackgroundAdmission(ctx);
				const sshCfg = g.t.kind === "remote" ? sshConfig(g.t.id) : undefined;
				if (g.t.kind === "remote" && !sshCfg) return bad(`ssh target not found: ${g.t.id}`);
				const controller = new AbortController();
				const job: BackgroundJob = {
					id: backgroundId(), target: g.t.id, command: params.command,
					cwd: params.cwd ?? (g.t.kind === "local" ? ctx.cwd : "/"), timeoutMs: params.timeoutMs,
					status: "running", startedAt: Date.now(), updatedAt: Date.now(), output: "", controller, notify: operationOrigin.getStore()?.notify, notifyUi: operationOrigin.getStore()?.notifyUi,
				};
				backgroundJobs.set(job.id, job);
				persistBackgroundJob(job);
				notifyBackgroundChanged();
				job.launch = trackBackgroundOperation(async () => {
					if (backgroundShuttingDown) return;
					if (sshCfg) {
						try {
							job.remote = await targets.launchRemoteJob(sshCfg, job.id, params.command, job.cwd);
							persistBackgroundJob(job);
						} catch (error) {
							failBackgroundJob(job, error);
							return bad(`ssh bg_start failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					// The accepted launch is accounted for even if shutdown began during SSH setup.
					// Let shutdown use the existing stop path rather than open a fresh follower.
					if (backgroundShuttingDown) return;
					job.run = trackBackgroundOperation(async () => {
						try {
							const options = {
								cwd: job.cwd, signal: controller.signal, timeoutMs: job.timeoutMs,
								timeoutLabel: job.timeoutMs === undefined ? undefined : String(job.timeoutMs / 1000),
								onData: (chunk: unknown) => appendBackgroundOutput(job, chunk),
							};
							const result = sshCfg
								? await targets.followRemoteJob(sshCfg, job.remote!, options)
								: g.t.kind === "local" ? await targets.localExecStream(params.command, options)
								: await targets.execStream(g.t.id, params.command, options);
							if (!controller.signal.aborted) finishBackgroundJob(job, result.exitCode);
						} catch (error) {
							if (job.status !== "running") return;
							// The stop owner publishes stopped only after this run settles.
							if (controller.signal.aborted) {
								if (error instanceof Error && error.message === "aborted") return;
								// SSH stop was acknowledged before its follower was aborted.
								if (job.remote && error instanceof SshJobContinuesError) return;
								throw error;
							}
							if (error instanceof SshJobContinuesError) {
								job.error = [job.error, error.message].filter(Boolean).join("\n");
								transitionBackgroundJob(job, "running");
								persistBackgroundJob(job);
								notifyBackgroundChanged();
							} else {
								failBackgroundJob(job, error);
							}
						}
					});
				});
				await job.launch;
				return ok(
					`Started background command ${job.id} on ${job.target}. Use /background for live output or bg_list for mailbox/status inspection; completion notification will arrive asynchronously. Avoid polling bg_status.`,
					{ display: `Started ${job.id} [${job.status}] target=${job.target} cwd=${job.cwd}` },
				);
			});
		},
		...(baseBashRenderCall && {
			renderCall(args: { target: string; command: string; cwd?: string; timeoutMs?: number }, theme: Parameters<typeof baseBashRenderCall>[1], context: Parameters<typeof baseBashRenderCall>[2]) {
				return baseBashRenderCall({ command: args?.command ?? "", timeout: args?.timeoutMs === undefined ? undefined : args.timeoutMs / 1000 }, theme, context);
			},
		}),
		renderResult: renderDisplayResult,
	});

	registerTool({
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

	registerTool({
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

	registerTool({
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
			await savePermissionsState(ctx);
			refreshSessionSystemPaths(ctx);
			await readyFileBackend();
			const run = await targets.start(vmId, { mounts: mountsForCurrentScopes(), network: false });
			state.targets.push(run);
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
				return `  ${v.mode.padEnd(6)} ${v.vmId} [${vmOS(v.vmId, run)}]${v.network ? " [network]" : ""} ${run ? "running" : "not attached"}`;
			}).join("\n") : "  (no vms added)",
			"ssh targets:",
			state.sshTargets.length ? state.sshTargets.map((s) => `  ${s.id} ${s.destination}${s.port !== undefined ? `:${s.port}` : ""}`).join("\n") : "  (no ssh targets added)",
			"exec grants:",
			state.execGrants.length ? state.execGrants.map((g) => `  ${g.mode.padEnd(5)} ${g.target} ${g.command}`).join("\n") : "  (no exec grants added)",
			`tools: ${(operationOrigin.getStore()?.toolNames ?? mergedActiveToolNames()).join(", ") || "(none)"}`
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
		const policy = sharedPermissions?.getSnapshot() ?? state;
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
			item("show", "alias for list"),
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
		if (action === "add" && kind === "network" && tokens.length === 2) return filter([item("ask", "ask before network use"), item("allow", "allow network use"), item("deny", "deny new network use")]);
		if (action === "add" && kind === "file" && tokens.length === 2) return filter([item("ro", "read-only"), item("rw", "read-write"), item("ask-ro", "ask before reads"), item("ask-rw", "ask before reads/writes"), item("ro-ask-rw", "read now, ask before writes")]);
		const knownVmIds = () => [...new Set([...policy.vms.map((v) => v.vmId), ...(!sharedPermissions ? targets.listVms().map((v) => v.id) : [])])].sort();
		if (action === "add" && kind === "vm" && tokens.length === 2) return filter([item("ro", "read-only VM"), item("rw", "read-write VM"), item("ask-ro", "ask before VM reads"), item("ask-rw", "ask before VM reads/writes"), item("ro-ask-rw", "read VM now, ask before writes"), item("network", "allow network for this VM"), ...knownVmIds().map((id) => item(id, "VM id"))]);
		if (action === "add" && kind === "vm" && ((tokens.length === 3 && !isModeToken(tokens[2]) && tokens[2] !== "network") || (tokens.length === 4 && isModeToken(tokens[2])))) return filter([item("network", "allow network for this VM")]);
		if (kind === "vm" && ((action === "add" && tokens.length === 3) || (action === "remove" && tokens.length === 2) || (action === "remove" && tokens.length === 3 && tokens[2] === "network"))) {
			// Completion reads already-known state, never discovers/boots a target.
			const vmIds = action === "add" ? knownVmIds() : policy.vms.map((v) => v.vmId);
			return filter([...(action === "remove" && tokens.length === 2 ? [item("network", "remove VM-specific network permission")] : []), ...[...vmIds].sort().map((id) => item(id, "VM id"))]);
		}
		if (action === "add" && kind === "exec" && tokens.length === 2) return filter([item("ask", "ask before executing matching command"), item("allow", "allow matching command")]);
		if (action === "add" && kind === "exec" && tokens.length === 3) return filter(policy.targets.map((t) => item(t.id, "target id")));
		if (kind === "ssh" && action === "remove" && tokens.length === 2) return filter(policy.sshTargets.map((s) => item(s.id, "SSH target")));
		if (action === "remove" && kind === "exec" && tokens.length === 2) return filter([...new Set(policy.execGrants.map((grant) => grant.target))].map((id) => item(id, "target id")));
		if (action === "remove" && kind === "file") {
			const prefix = argumentPrefix.trimStart().slice("remove file ".length);
			return policy.scopes.filter((scope) => scope.path.startsWith(prefix)).map((scope) => ({ value: "remove file " + scope.path, label: scope.path }));
		}
		return null;
	}

	registerPermissionCommand("permissions", {
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
							{ signal: operationSignal() },
						);
						quiescence.signal.throwIfAborted();
						if (!allowNetwork) return ctx.ui.notify("SSH target not added; network permission unchanged.", "info");
						state.network = "allow";
						await savePermissionsState(ctx);
						syncTools();
					}
					const ssh = { id: sshId, ...parsed } satisfies SshTarget;
					try { await targets.probeRemote(ssh, operationSignal()); }
					catch (err) { return ctx.ui.notify(`SSH target rejected: ${err instanceof Error ? err.message : String(err)}`, "warning"); }
					quiescence.signal.throwIfAborted();
					state.sshTargets = state.sshTargets.filter((s) => s.id !== sshId);
					state.sshTargets.push(ssh);
					targets.configureRemote(ssh);
					state.targets = state.targets.filter((t) => t.id !== sshId);
					state.targets.push(sshRunningTarget(ssh));
					await savePermissionsState(ctx);
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
					await savePermissionsState(ctx);
					syncTools();
					return ctx.ui.notify(`Added VM ${vmId}${network ? " with network permission" : ""}.\n${permsText()}`, "info");
				}

				if (networkOnly && existing) {
					state.vms = state.vms.map((v) => (v.vmId === vmId ? { ...v, network: false } : v));
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
					await savePermissionsState(ctx);
					syncTools();
					return ctx.ui.notify(`Added exec permission (${mode}) for ${targetId}: ${command}\n${permsText()}`, "info");
				}
				const m = args.match(/^\s*remove\s+exec\s+(\S+)\s+([\s\S]+)$/);
				if (!m) return ctx.ui.notify(permissionsUsage(), "warning");
				const [, targetId, command] = m;
				if (!targetId || !command) return ctx.ui.notify(permissionsUsage(), "warning");
				state.execGrants = state.execGrants.filter((g) => !(g.target === targetId && g.command === command));
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

	registerPermissionCommand("background", {
		description: "Open the background command monitor.",
		handler: async (_args, ctx) => {
			if (shuttingDown) return;
			setBackgroundContext(ctx);
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/background requires the TUI", "warning");
				return;
			}
			const port = backgroundPortFor(ctx, () => {
				ensureCurrentPermissions();
				quiescence.signal.throwIfAborted();
				assertBackgroundAdmission(ctx);
			});
			const remote = remoteUI(ctx.ui);
			if (remote) await remote.present({ kind: "background", port });
			else await openBackgroundPanel(ctx.ui, port);
		},
	});

	// -------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_e, ctx) => {
		withdrawPort?.();
		withdrawPort = undefined;
		approvals.detach();
		sharedPermissions = bindSharedPermissions(ctx.sessionManager.getSessionId());
		if (sharedPermissions) {
			quiescence = new AbortController(); shuttingDown = false; shutdown = undefined;
			sharedPermissions.getOwner();
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...tools.keys()])]);
			return;
		}
		ownerContext = ctx;
		targets ??= new TargetManager();
		if (shutdown) {
			await shutdown.catch(() => {}); // Already reported and recorded by shutdown.
			targets = new TargetManager();
			quiescence = new AbortController();
			shutdown = undefined;
			shuttingDown = false;
			backgroundShuttingDown = false;
			backgroundShutdown = undefined;
		}
		idleStatusBridge().backgroundActiveCount = backgroundActiveCount;
		const previousFilesystem = pifs ?? pifsStarting;
		if (previousFilesystem) await previousFilesystem.stop();
		if (shuttingDown || quiescence.signal.aborted) return;
		pifs = undefined;
		pifsStarting = undefined;
		pifsFailure = undefined;
		if (permissionController) {
			// Preserve this owner's durable grants before replacing its runtime.
			Object.assign(state, permissionController.getPersistableSnapshot());
			permissionController.dispose();
			permissionController = undefined;
		}
		// VM grants already preserve session association. Restore them inactive;
		// never reconnect a previous runtime's target or filesystem proxy.
		state.targets = [targets.localTarget(LOCAL_TARGET)];
		loadPermissionsState(ctx);
		targets.setRemoteConfigs(state.sshTargets);
		refreshSessionSystemPaths(ctx);
		setBackgroundContext(ctx);
		restoreBackgroundJobs(ctx);
		refreshBackgroundUi();
		const sessionId = ctx.sessionManager.getSessionId();
		// Replacing a root invalidates old child aliases rather than reconnecting them.
		permissionsBridge().instances.get(sessionId)?.dispose?.();
		permissionController = new PermissionController(
			sessionId, state,
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
			runtime, ctx,
		);
		permissionsBridge().instances.set(sessionId, permissionController);
		syncTools();
		pifsSession = sessionId;
		const startupSignal = quiescence.signal;
		const controller = new PiFSController(new NativeMountDriver(), async (request, signal) => {
			if (shuttingDown || startupSignal.aborted || pifsSession !== sessionId || signal.aborted) return false;
			const revision = permissionController?.getRevision();
			// Cancel the dialog, not pifs IPC: a denial releases pending native IO
			// while leaving the mount alive until owned VMs have stopped.
			const approvalSignal = AbortSignal.any([signal, startupSignal]);
			let title = `Allow pifs ${request.access}?`;
			let description = `${JSON.stringify(request.path)}\nApplies only to this acquired item until its native owner is released or policy changes, not to replacements. NFS CLOSE may leave a cached metadata owner retained.`;
			if (request.reason === "effect") {
				const effect = request.effect;
				title = `Allow pifs ${effect.operation} once?`;
				const selectors = [effect.source && `Source: ${JSON.stringify(effect.source)}`, effect.destination && `Destination: ${JSON.stringify(effect.destination)}`].filter(Boolean);
				const lifecycle = effect.operation.startsWith("open-")
					? `\nAcquire native ${effect.operation.slice(5).replace("readwrite", "read/write")} access for ${effect.purpose === "metadata-owner" ? "retaining a metadata owner (no payload access)" : effect.purpose === "set-size" ? "changing file size" : "content access"}. Opening and releasing the native owner can have effects if the current entry is or becomes a FIFO or device, even if it is rejected afterward. This is one acquisition; any content rights bind only the acquired handle.`
					: effect.operation === "rename" ? "\nThe destination may be replaced. Directory coverage includes its subtree."
					: effect.operation === "create" ? "\nCreate the requested entry and apply requested attributes. Native opening requires separate authorization." : "";
				const attributes = effect.purpose === "content" && effect.footprint.some(item => item.access === "write")
					? "\nListed WRITE permissions also cover requested file-attribute changes, including truncation, on the acquired regular object." : "";
				const binding = effect.operation === "link"
					? "Links the already-held source object, originally selected at the source path—not a replacement at that name. The destination is a named entry in the held destination directory."
					: "Acts on these named entries in the held directories when executed, including entries replaced concurrently.";
				description = `${selectors.join("\n")}\n${binding}${lifecycle}${attributes}\nComplete permission footprint:\n${effect.footprint.map(item => `${item.access.toUpperCase()} ${JSON.stringify(item.path)}`).join("\n")}`;
			}
			const allowed = await approvals.confirm(
				{ operation: title, detail: [description] },
				approvalSignal,
				() => ctx.hasUI ? ctx.ui.confirm(title, description, { signal: approvalSignal }) : Promise.resolve(false),
			);
			return allowed && !approvalSignal.aborted && !shuttingDown && pifsSession === sessionId && revision === permissionController?.getRevision();
		}, 30_000, { sessionId });
		pifsStarting = controller;
		const ownsStartup = () => pifsStarting === controller && pifsSession === sessionId && !startupSignal.aborted && !shuttingDown;
		try {
			await ensurePiFSSetup(pi, ctx, startupSignal);
			if (!ownsStartup()) { await controller.stop(); return; }
			if (ctx.hasUI) ctx.ui.notify("pifs: Mounting the session view and waiting for the initial policy acknowledgment…", "info");
			await controller.start([...state.scopes, ...systemScopes]);
			await controller.update([...state.scopes, ...systemScopes]);
			if (!ownsStartup()) { await controller.stop(); return; }
			pifs = controller;
			pifsStarting = undefined;
			if (ctx.hasUI) ctx.ui.notify("pifs: Session filesystem ready.", "info");
		}
		catch (error) {
			let failure = error instanceof Error ? error : new Error(String(error));
			try { await controller.stop(); }
			catch (cleanup) { failure = new AggregateError([failure, cleanup], `${failure.message}; pifs cleanup failed: ${cleanup}`); }
			if (ownsStartup()) {
				pifsStarting = undefined;
				pifsFailure = failure;
				ctx.ui.notify(`pifs unavailable; file/VM tools blocked: ${failure.message}`, "error");
			}
		}
		if (!shuttingDown && permissionController) {
			const owner = permissionController;
			let live = true;
			const subscriptions = new Set<() => void>();
			const check = () => {
				if (!live || shuttingDown || owner !== permissionController) throw new Error("Permission service retired.");
				owner.getOwner();
			};
			const checkBackground = () => {
				check();
				quiescence.signal.throwIfAborted();
				assertBackgroundAdmission(ctx);
				if (backgroundSessionId !== sessionId) throw new Error("Background service retired.");
			};
			const port: PermissionPort = {
				mutate: async (revision, mutation, assertCurrent = () => {}) => {
					check();
					quiescence.signal.throwIfAborted();
					assertCurrent();
					assertPermissionRevision(revision, owner.getRevision());
					const edit = validatePermissionMutation(mutation);
					if (edit.kind === "ssh") {
						await applySshPermissionMutation(state, edit, {
							check: () => {
								check();
								quiescence.signal.throwIfAborted();
								assertCurrent();
								assertPermissionRevision(revision, owner.getRevision());
							},
							normalizeId: normalizeVmId,
							parseDestination: parseSshDestination,
							probe: ssh => targets.probeRemote(ssh, quiescence.signal),
							configure: ssh => targets.configureRemote(ssh),
							remove: id => targets.removeRemote(id),
							runningTarget: sshRunningTarget,
						});
						check();
					} else {
						applyPermissionMutation(state, revision, owner.getRevision(), edit,
							(path, removing) => (removing ? canonicalPathForRemoval(ctx.cwd, path) : canonicalExistingPath(ctx.cwd, path)).real,
							normalizeVmId);
					}
					// Network edits affect future admissions; never silently restart running VMs.
					// Publish/persist immediately, then refresh the existing live filesystem proxy.
					await savePermissionsState(ctx);
					check();
					syncTools();
					return { revision: owner.getRevision(), permissions: owner.getSnapshot() };
				},
				background: backgroundPortFor(ctx, checkBackground, subscriptions),
				snapshot: () => {
					check();
					const permissions = owner.getSnapshot();
					return { revision: owner.getRevision(), permissions };
				},
				subscribe: (listener) => {
					check();
					const off = owner.subscribe(listener);
					subscriptions.add(off);
					return () => {
						subscriptions.delete(off);
						off();
					};
				},
				attachPresenter: (presenter) => {
					check();
					return approvals.attach(presenter);
				},
			};
			const withdraw = publishService(pi.events, {
				version: 1,
				kind: "permissions",
				sessionId: ctx.sessionManager.getSessionId(),
				generation: randomUUID(),
				port,
			});
			withdrawPort = () => {
				live = false;
				approvals.detach();
				for (const off of subscriptions) off();
				subscriptions.clear();
				withdraw();
			};
		}
	});

	pi.on("tool_call", async () => {
		if (shuttingDown) return { block: true, reason: "Session is quiescing; tool admission is closed." };
		try {
			ensureCurrentPermissions();
			// Each target owns operation admission and filesystem readiness.
		}
		catch (error) {
			return { block: true, reason: `Permission refresh failed closed: ${error instanceof Error ? error.message : String(error)}` };
		}
	});

	pi.on("session_shutdown", (event, ctx) => {
		withdrawPort?.();
		withdrawPort = undefined;
		approvals.detach();
		if (sharedPermissions) {
			shuttingDown = true; quiescence.abort();
			return shutdown ??= (async () => {
				await Promise.allSettled([...sessionOperations]);
				sharedPermissions?.dispose();
			})();
		}
		shuttingDown = true;
		targets.closeAdmission();
		quiescence.abort();
		return shutdown ??= (async () => {
			const failures: unknown[] = [];
			try {
				try { ctx.abort(); } catch (error) { failures.push(error); }
				// Children share this owner. Drain their calls explicitly,
				// regardless of the order extension shutdown handlers are invoked.
				const drained = await Promise.allSettled([
					quiesceSubagents(ctx.sessionManager.getSessionId(), event.reason),
					shutdownBackgroundJobs(ctx),
					Promise.allSettled([...sessionOperations]),
				]);
				for (const result of drained) if (result.status === "rejected") failures.push(result.reason);
				try { await targets.quiesce(); }
				catch (error) { failures.push(error); }
				state.targets = state.targets.filter((target) => !target.vm);
				persistPermissionsState(ctx);
			} catch (error) { failures.push(error); }
			finally {
				// Stop/save the guest while its proxy still exists. Even a failed VM
				// stop must not leave native host-file authority alive after exit.
				pifsSession = undefined;
				const controller = pifs ?? pifsStarting;
				pifs = undefined;
				pifsStarting = undefined;
				if (controller) {
					try { await controller.stop(); }
					catch (error) { failures.push(error); }
				}
				if (idleStatusBridge().backgroundActiveCount === backgroundActiveCount) delete idleStatusBridge().backgroundActiveCount;
				if (permissionController) {
					Object.assign(state, permissionController.getPersistableSnapshot());
					permissionController.dispose();
					permissionController = undefined;
				}
			}
			if (failures.length) {
				const detail = failures.map((error) => error instanceof Error ? error.message : String(error)).join("\n");
				pi.appendEntry("permissions.cleanup-failed", { detail });
				ctx.ui.notify(`Session cleanup failed (filesystem authority revoked):\n${detail}`, "error");
				throw new AggregateError(failures, detail);
			}
		})();
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!sharedPermissions) refreshSessionSystemPaths(ctx);
		const transcript = sharedPermissions
			? join(sessionSystemRoot(sharedPermissions.getOwner().context), "transcripts", `${ctx.sessionManager.getSessionId()}.jsonl`)
			: sessionTranscriptPath(ctx);
		const source = ctx.sessionManager.getSessionFile();
		if (source) syncTranscriptLink(source, transcript);
		pi.sendMessage({
			customType: "permissions.compaction-transcript-pointer",
			display: false,
			content: [
				"The session was compacted.",
				`The full JSONL transcript, including pre-compaction history, is available at: ${transcript}`,
				"Use read/grep on that file if exact prior messages or tool results are needed.",
			].join("\n"),
			details: { compactionEntryId: event.compactionEntry.id, transcript },
		}, { triggerTurn: false });
	});

	// Re-derive rather than announce: conversation branching can rewind the
	// transcript, but grants are real-world state and must not rewind with it.
	pi.on("before_agent_start", (event, ctx) => sharedPermissions
		? sessionOperation(() => sharedPermissions!.getOwner().runtime.beforeAgentStart(event))
		: permissionPrompt(event, ctx));
	async function permissionPrompt(event: Parameters<PermissionRuntime["beforeAgentStart"]>[0], ctx: ExtensionContext) {
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
					return `  - ${v.vmId} (${vmOS(v.vmId, run)}, ${v.mode}${v.network ? ", network" : ""}, ${run ? "running" : "not attached"})`;
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
		return { systemPrompt: out };
	}
}
