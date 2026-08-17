import type { ScopeMode, State } from "./policy.ts";

/** User-issued edits only; system scopes and running target lifecycle are not editable. */
export type PermissionMutation =
	| { kind: "file"; action: "set"; path: string; mode: ScopeMode }
	| { kind: "file"; action: "remove"; path: string }
	| { kind: "files"; action: "set"; paths: string[]; mode: ScopeMode }
	| { kind: "vm"; action: "set"; vmId: string; mode: ScopeMode }
	| { kind: "vm"; action: "remove"; vmId: string }
	| { kind: "vmNetwork"; action: "set"; vmId: string; enabled: boolean }
	| { kind: "network"; action: "set"; mode: "deny" | "ask" | "allow" }
	| { kind: "exec"; action: "set"; target: string; command: string; mode: "ask" | "allow" }
	| { kind: "exec"; action: "remove"; target: string; command: string }
	| { kind: "ssh"; action: "set"; id: string; destination: string }
	| { kind: "ssh"; action: "remove"; id: string };
export type SynchronousPermissionMutation = Exclude<PermissionMutation, {kind: "ssh"}>;
const scopeModes = ["deny", "ask-ro", "ask-rw", "ro", "ro-ask-rw", "rw"];

/** Validate the complete transport input before resolving paths or touching policy. */
export function validatePermissionMutation(value: unknown): PermissionMutation {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("INVALID_PERMISSION_MUTATION");
	const v = value as Record<string, unknown>;
	const text = (key: string) => typeof v[key] === "string" && !!(v[key] as string).trim() && !(v[key] as string).includes("\0");
	const mode = (values: string[]) => typeof v.mode === "string" && values.includes(v.mode);
	let fields: string[] | undefined;
	if (v.action !== "set" && v.action !== "remove") throw Error("INVALID_PERMISSION_MUTATION");
	const setting = v.action === "set";
	switch (v.kind) {
		case "file": case "vm": {
			const key = v.kind === "file" ? "path" : "vmId";
			if (text(key) && (!setting || mode(scopeModes))) fields = [key, ...(setting ? ["mode"] : [])];
			break;
		}
		case "files":
			if (setting && mode(scopeModes) && Array.isArray(v.paths) && v.paths.length > 0 && v.paths.length <= 128 &&
				v.paths.every(p => typeof p === "string" && !!p.trim() && !p.includes("\0"))) fields = ["paths", "mode"];
			break;
		case "vmNetwork":
			if (setting && text("vmId") && typeof v.enabled === "boolean") fields = ["vmId", "enabled"];
			break;
		case "network":
			if (setting && mode(["deny", "ask", "allow"])) fields = ["mode"];
			break;
		case "exec":
			if (text("target") && !/\s/.test(v.target as string) && text("command") && (!setting || mode(["ask", "allow"])))
				fields = ["target", "command", ...(setting ? ["mode"] : [])];
			break;
		case "ssh":
			if (text("id") && (!setting || (text("destination") && !/\s/.test(v.destination as string))))
				fields = ["id", ...(setting ? ["destination"] : [])];
			break;
	}
	if (!fields || Object.keys(v).some(k => !["kind", "action", ...fields].includes(k))) throw Error("INVALID_PERMISSION_MUTATION");
	return v as PermissionMutation;
}

export function assertPermissionRevision(expected: number, current: number): void {
	if (!Number.isSafeInteger(expected) || expected < 0 || expected !== current) throw Error("STALE_PERMISSION_REVISION");
}

/** Synchronous admission/commit: callers publish through the existing owner save path. */
export function applyPermissionMutation(state: State, expectedRevision: number, currentRevision: number,
	input: unknown, normalizePath: (path: string, removing: boolean) => string, normalizeVmId: (id: string) => string): void {
	assertPermissionRevision(expectedRevision, currentRevision);
	const edit = validatePermissionMutation(input);
	switch (edit.kind) {
		case "file": {
			// Exact stored paths must remain removable even after deletion or symlink changes.
			const path = edit.action === "remove" && state.scopes.some(s => s.path === edit.path)
				? edit.path : normalizePath(edit.path, edit.action === "remove");
			state.scopes = state.scopes.filter(s => s.path !== path);
			if (edit.action === "set") state.scopes.push({ path, mode: edit.mode });
			break;
		}
		case "files": {
			// A drag may include multiple paths: validate all before committing any.
			const paths = new Set(edit.paths.map(path => normalizePath(path, false)));
			state.scopes = [...state.scopes.filter(scope => !paths.has(scope.path)),
				...[...paths].map(path => ({path, mode: edit.mode}))];
			break;
		}
		case "vm": {
			const vmId = normalizeVmId(edit.vmId);
			const existing = state.vms.find(v => v.vmId === vmId);
			state.vms = state.vms.filter(v => v.vmId !== vmId);
			if (edit.action === "set") state.vms.push({ ...existing, vmId, mode: edit.mode });
			break;
		}
		case "vmNetwork": {
			const vmId = normalizeVmId(edit.vmId);
			const existing = state.vms.find(v => v.vmId === vmId);
			// Like /permissions add vm network, adding a new grant defaults to ro.
			// Removing only networking never creates or deletes filesystem authority.
			if (existing) existing.network = edit.enabled;
			else if (edit.enabled) state.vms.push({vmId, mode: "ro", network: true});
			break;
		}
		case "network": state.network = edit.mode; break;
		case "exec":
			state.execGrants = state.execGrants.filter(g => !(g.target === edit.target && g.command === edit.command));
			if (edit.action === "set") state.execGrants.push({target: edit.target, command: edit.command, mode: edit.mode});
			break;
		case "ssh": throw Error("SSH_PERMISSION_REQUIRES_OWNER");
	}
}

/** SSH must probe through the owner's real target manager and re-fence after awaiting it. */
export async function applySshPermissionMutation(state: State, edit: Extract<PermissionMutation, {kind: "ssh"}>, hooks: {
	check(): void;
	normalizeId(id: string): string;
	parseDestination(spec: string): {destination: string; port?: number};
	probe(ssh: State["sshTargets"][number]): Promise<void>;
	configure(ssh: State["sshTargets"][number]): void;
	remove(id: string): void;
	runningTarget(ssh: State["sshTargets"][number]): State["targets"][number];
}): Promise<void> {
	hooks.check();
	const id = hooks.normalizeId(edit.id);
	if (edit.action === "set") {
		const ssh = {id, ...hooks.parseDestination(edit.destination)};
		if (state.targets.some(t => t.id === id) && !state.sshTargets.some(s => s.id === id)) throw Error("TARGET_ALREADY_EXISTS");
		// Never silently grant session-wide network on behalf of a client. It must
		// issue an explicit network edit first (equivalent to accepting TUI consent).
		if ((state.network ?? "deny") === "deny") throw Error("NETWORK_PERMISSION_REQUIRED: Enable session network explicitly before adding SSH.");
		await hooks.probe(ssh);
		hooks.check();
		hooks.configure(ssh);
		state.sshTargets = [...state.sshTargets.filter(s => s.id !== id), ssh];
		state.targets = [...state.targets.filter(t => t.id !== id), hooks.runningTarget(ssh)];
	} else {
		// Unknown SSH IDs must not remove a local/VM target with the same ID.
		if (!state.sshTargets.some(s => s.id === id)) return;
		hooks.remove(id);
		state.sshTargets = state.sshTargets.filter(s => s.id !== id);
		state.targets = state.targets.filter(t => t.id !== id);
		state.execGrants = state.execGrants.filter(g => g.target !== id);
	}
}
