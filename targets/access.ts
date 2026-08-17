import { isAbsolute, resolve } from "node:path";
import type { RunningTarget } from "./api.ts";
import { TargetFiles, type FileOperations, type SearchPolicy } from "./files.ts";
import { asksForVerb, canReadMode, canWriteMode, isWriteVerb, matchScope, vmScope, type Scope, type State, type Verb } from "../permissions/src/policy.ts";
import { DeniedError } from "../permissions/src/fsops.ts";
import { nfc } from "../permissions/src/paths.ts";
import type { AskRequest } from "../permissions/src/ask.ts";
import { ProxyFiles, normalizeHostPath, normalizeProxyPath, type FSKitController } from "../permissions/fskit/index.ts";

export type FileVerb = Exclude<Verb, "bash">;
/** Session-owned authority is read afresh, never copied into a durable target. */
export interface TargetAuthority {
	current(): { state: State; systemScopes: Scope[]; proxy?: FSKitController };
	target(id: string): RunningTarget | undefined;
	checkpoint(): () => void;
	ask(request: AskRequest): Promise<boolean>;
	readyFiles(): Promise<void>;
	assertFiles(): void;
	mountsCompatible(mounts: RunningTarget["mounts"]): boolean;
}
export type AuthorizedFiles = { target: RunningTarget; path: string; cwd: string; files: TargetFiles };
type RawFiles = (target: RunningTarget) => FileOperations;

export abstract class TargetAccess {
	constructor(protected readonly id: string, protected readonly authority: TargetAuthority, protected readonly rawFiles: RawFiles) {}
	protected target(): RunningTarget {
		this.authority.current();
		const target = this.authority.target(this.id);
		if (!target) throw new Error(`Permission denied: no target named ${this.id}. Use capabilities for current access.`);
		return target;
	}
	protected checkpoint(target: RunningTarget): () => void {
		const fresh = this.authority.checkpoint(), fingerprint = JSON.stringify(target);
		return () => {
			fresh();
			if (JSON.stringify(this.target()) !== fingerprint) throw new Error("Target changed during this operation. Retry against current permissions.");
		};
	}
	protected async confirm(request: AskRequest): Promise<void> {
		if (!await this.authority.ask(request)) throw new Error(`Permission denied: ${request.operation} was not approved.`);
	}
	protected async execGrant(target: RunningTarget, command: string, wildcardOnly = false): Promise<void> {
		const { state } = this.authority.current();
		const grant = (!wildcardOnly && state.execGrants.find(g => g.target === target.id && g.command === command))
			|| state.execGrants.find(g => g.target === target.id && g.command === "*");
		if (!target.exec || !grant) throw new Error(`Permission denied: ${target.id} requires an exec grant for ${wildcardOnly ? "'*' (filesystem access)" : "this command"}.`);
		if (grant.mode === "ask") await this.confirm({ operation: `Allow exec on ${target.id}`, detail: [`Grant: ${grant.command}`, command] });
	}
	abstract files(verb: FileVerb, path: string, cwd: string): Promise<AuthorizedFiles>;
	abstract exec(command: string): Promise<RunningTarget>;
}

/** Host paths alone have host path policy. Trusted shell execution is separate. */
export class LocalTargetAccess extends TargetAccess {
	async exec(command: string): Promise<RunningTarget> {
		const target = this.target(), fresh = this.checkpoint(target);
		await this.execGrant(target, command);
		fresh(); return target;
	}
	async files(verb: FileVerb, input: string, cwd: string): Promise<AuthorizedFiles> {
		const target = this.target();
		await this.authority.readyFiles();
		const fresh = this.checkpoint(target);
		const { state, systemScopes, proxy } = this.authority.current();
		const path = normalizeHostPath(proxy!.hostPath(input), cwd, verb === "write" ? "create" : "existing");
		const scopes = [...state.scopes, ...systemScopes];
		const allow = (candidate: string) => {
			fresh(); this.authority.assertFiles();
			const mode = matchScope(scopes, candidate)?.mode;
			return !!mode && (isWriteVerb(verb) ? canWriteMode(mode) : canReadMode(mode));
		};
		if (!allow(path)) throw new DeniedError(path);
		const scope = matchScope(scopes, path);
		fresh();
		const policy: SearchPolicy = {
			scopes: [
				...state.scopes.map(({ path, mode }) => ({ path, access: (mode === "deny" ? "deny" : asksForVerb(mode, "read") ? "ask" : "allow") as "deny" | "ask" | "allow" })),
				...systemScopes.map(({ path }) => ({ path, access: "allow" as const })),
			],
			approved: scope && asksForVerb(scope.mode, "read") ? { path, scopePath: scope.path } : undefined,
			assertFresh: fresh,
		};
		const files = new TargetFiles(new ProxyFiles(proxy!), (candidate, intent) => {
			fresh(); this.authority.assertFiles();
			if (this.authority.current().proxy !== proxy) throw new Error("FSKit session changed");
			return normalizeProxyPath(proxy!, candidate, cwd, intent, allow);
		}, policy);
		return { target, path, cwd, files };
	}
}

/** An SSH filesystem is remote exec, not a locally governed path hierarchy. */
export class SshTargetAccess extends TargetAccess {
	private async connect(target: RunningTarget): Promise<void> {
		const { state } = this.authority.current();
		const config = state.sshTargets.find(config => config.id === target.id);
		if (!config || (state.network !== "allow" && state.network !== "ask")) throw new Error(`Permission denied: SSH target ${target.id} requires configuration and network permission.`);
		if (state.network === "ask") await this.confirm({ operation: `Allow SSH connection to ${target.id}`, detail: [`Target: ${config.destination}`] });
	}
	async exec(command: string): Promise<RunningTarget> {
		const target = this.target(), fresh = this.checkpoint(target);
		await this.connect(target); await this.execGrant(target, command);
		fresh(); return target;
	}
	async files(verb: FileVerb, path: string, _cwd: string): Promise<AuthorizedFiles> {
		const target = this.target(), fresh = this.checkpoint(target);
		await this.connect(target); await this.execGrant(target, `${verb} ${path}`, true);
		fresh();
		return guestFiles(target, path, this.rawFiles(target), fresh);
	}
}

/** VM admission is machine authority. Only its projected host share has host policy. */
export class VmTargetAccess extends TargetAccess {
	private async admit(target: RunningTarget, verb: Verb): Promise<void> {
		await this.authority.readyFiles();
		const { state } = this.authority.current();
		const grant = vmScope(state, target.vm?.id);
		if (!grant || grant.mode === "deny" || ((verb === "bash" || isWriteVerb(verb)) && !canWriteMode(grant.mode))) throw new Error(`Permission denied: VM ${target.id} is not granted for ${verb}.`);
		if (!this.authority.mountsCompatible(target.mounts)) throw new Error(`Permission denied: ${target.id}'s live mounts exceed current permissions. Restart it with current mounts.`);
		if (target.network && !grant.network) {
			if (state.network !== "allow" && state.network !== "ask") throw new Error(`Permission denied: ${target.id} is still networked.`);
			if (state.network === "ask") await this.confirm({ operation: `Allow ${verb} on networked VM ${target.id}`, detail: ["This VM can send any data it can read over the network."] });
		}
		if (asksForVerb(grant.mode, verb === "bash" ? "write" : verb)) await this.confirm({ operation: `Allow ${verb} on VM ${target.id}`, detail: [`VM permission: ${grant.mode}`, "Approving allows this machine operation once."] });
	}
	async exec(command: string): Promise<RunningTarget> {
		const target = this.target(), fresh = this.checkpoint(target);
		if (!target.exec) throw new Error(`Permission denied: ${target.id} is not executable.`);
		await this.admit(target, "bash");
		const { state } = this.authority.current();
		// Preserve explicit ask exceptions even though writable VMs imply exec.
		const grant = state.execGrants.find(g => g.target === target.id && g.command === command) ?? state.execGrants.find(g => g.target === target.id && g.command === "*");
		if (grant?.mode === "ask") await this.confirm({ operation: `Allow exec on ${target.id}`, detail: [`Grant: ${grant.command}`, command] });
		fresh(); return target;
	}
	async files(verb: FileVerb, path: string, _cwd: string): Promise<AuthorizedFiles> {
		const target = this.target(), fresh = this.checkpoint(target);
		await this.admit(target, verb); fresh();
		return guestFiles(target, path, this.rawFiles(target), () => {
			fresh(); this.authority.assertFiles();
			if (!this.authority.mountsCompatible(target.mounts)) throw new Error("VM host mounts changed");
		});
	}
}

function guestFiles(target: RunningTarget, path: string, backend: FileOperations, fresh: () => void): AuthorizedFiles {
	// No host realpath, metadata probe, path scope, or symlink interpretation here.
	const absolute = (path: string) => nfc(isAbsolute(path) ? path : resolve("/", path));
	return { target, path: absolute(path), cwd: "/", files: new TargetFiles(backend, candidate => { fresh(); return absolute(candidate); }, { scopes: [], assertFresh: fresh }) };
}
