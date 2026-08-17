import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import fsPromises, { access as namedAccess } from "node:fs/promises";
import { spawn as namedSpawn } from "child_process";
import { existsSync as namedExistsSync } from "fs";
import { Transform } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SearchRoot = { path: string; exclude: string[] };
export type SearchPlan = {
	roots: SearchRoot[];
	spawn(tool: "rg" | "fd", commands: string[][], signal?: AbortSignal): ChildProcess;
};
type Request = {
	tool: "rg" | "fd";
	root: string;
	plan: SearchPlan;
	signal?: AbortSignal;
	assertFresh(): void;
	exists(path: string): Promise<boolean>;
	active: boolean;
	launched: boolean;
	failure?: Error;
	child?: ChildProcess;
};

// Deliberate, unsupported compatibility seam (public Pi 0.84.4/0.85.1 contracts).
// No Pi code is replaced:
// the installed factories still perform discovery, construct argv and parse/format.
// The cache entry is a request-local virtual executable, resolved only at launch.
const key = Symbol.for("pi.targets.native-search.v1");
type Seam = { storage: AsyncLocalStorage<Request>; spawn: typeof childProcess.spawn };
const globals = globalThis as typeof globalThis & { [key]?: Seam };

function install(): Seam {
	if (globals[key]) return globals[key]!;
	const storage = new AsyncLocalStorage<Request>();
	const spawn = childProcess.spawn;
	const existsSync = fs.existsSync;
	const access = fsPromises.access;
	const request = () => {
		const scope = storage.getStore();
		if (scope) {
			if (!scope.active) throw new Error("Native search request has ended");
			scope.assertFresh();
			scope.signal?.throwIfAborted();
		}
		return scope;
	};
	fs.existsSync = function(path) {
		const scope = storage.getStore();
		if (scope && path === join(getAgentDir(), "bin", scope.tool)) {
			request();
			return true;
		}
		if (scope) throw new Error("Unsupported Pi discovery path; refusing host discovery");
		return existsSync(path);
	};
	fsPromises.access = async function(path, mode) {
		const scope = storage.getStore();
		if (scope?.tool === "fd" && typeof path === "string" && (mode === undefined || mode === fs.constants.F_OK)) {
			for (let ancestor = scope.root;; ancestor = dirname(ancestor)) {
				if (path === join(ancestor, ".git")) {
					request();
					const exists = await storage.exit(() => scope.exists(path));
					request();
					if (!exists) throw Object.assign(new Error("Path not found"), { code: "ENOENT" });
					return;
				}
				if (ancestor === dirname(ancestor)) break;
			}
		}
		if (scope) throw new Error("Unsupported Pi filesystem probe; refusing host access");
		return access(path, mode);
	};
	childProcess.spawn = function(executable: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions) {
		const scope = storage.getStore();
		if (!scope) return (spawn as any)(executable, args, options);
		request();
		// Only Pi's native launch shape is accepted in this scope. Backend IO runs
		// outside it, so SSH/docker metadata and transport spawns are not intercepted.
		if (scope.launched || executable !== join(getAgentDir(), "bin", scope.tool) || !Array.isArray(args)
			|| JSON.stringify(options) !== '{"stdio":["ignore","pipe","pipe"]}'
			|| args.at(-1) !== scope.root || args.at(-3) !== "--"
			|| args[0] !== (scope.tool === "rg" ? "--json" : "--glob")) {
			throw new Error("Unsupported Pi native search launch; refusing host execution");
		}
		scope.launched = true;
		const prefix = args.slice(0, -3);
		const commands = scope.plan.roots.map(root => {
			const flags = [...prefix, "--no-ignore-parent"];
			if (scope.tool === "rg") flags.push("--no-config", "--no-ignore-global");
			for (const excluded of root.exclude) {
				if (scope.tool === "rg") flags.push("--glob", `!${escapeGlob(excluded)}`, "--glob", `!${escapeGlob(excluded)}/**`);
				else {
					const glob = `/${escapeGlob(relative(root.path, excluded))}`;
					flags.push("--exclude", glob, "--exclude", `${glob}/**`);
				}
			}
			return [...flags, "--", args.at(-2)!, root.path];
		});
		const child = storage.exit(() => scope.plan.spawn(scope.tool, commands, scope.signal));
		scope.child = child;
		if (scope.tool === "fd" && commands.length > 1) {
			const limit = Number(prefix[prefix.indexOf("--max-results") + 1]);
			if (Number.isSafeInteger(limit) && limit > 0) limitRecords(child, limit);
		}
		let stderr = "";
		child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
		child.once("error", error => { scope.failure = error; });
		child.once("close", code => {
			if (stderr.trim() || (!child.killed && code !== 0 && !(scope.tool === "rg" && code === 1))) {
				scope.failure = new Error(stderr.trim() || `Native ${scope.tool} exited ${code}; install ${scope.tool} on the target (automatic downloads are disabled)`);
			}
		});
		return child;
	} as typeof childProcess.spawn;
	syncBuiltinESMExports();
	return globals[key] = { storage, spawn };
}

export async function withNativeSearch<T>(request: Omit<Request, "active" | "launched">, execute: () => Promise<T>): Promise<T> {
	const seam = install();
	// Check the same named builtin imports Pi uses BEFORE discovery can execute.
	// This also rejects loaders that snapshot bindings instead of updating them.
	if (namedSpawn !== childProcess.spawn || namedExistsSync !== fs.existsSync || namedAccess !== fsPromises.access) {
		throw new Error("Pi native search requires live Node builtin bindings; this loader cannot safely route search");
	}
	const scope: Request = { ...request, active: true, launched: false };
	const timer = setTimeout(() => {
		scope.failure = new Error("Native search timed out after 30 seconds");
		scope.child?.kill("SIGKILL");
	}, 30_000);
	try {
		const result = await seam.storage.run(scope, execute);
		scope.assertFresh();
		scope.signal?.throwIfAborted();
		if (scope.failure) throw scope.failure;
		if (!scope.launched) throw new Error("Pi did not use the expected native search launch");
		return result;
	} finally {
		scope.active = false;
		clearTimeout(timer);
		if (scope.child && scope.child.exitCode === null && scope.child.signalCode === null) scope.child.kill("SIGKILL");
	}
}

/** Enforce fd's aggregate limit across region processes; Pi still owns all formatting. */
function limitRecords(child: ChildProcess, limit: number) {
	let count = 0;
	const output = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			if (count >= limit) { done(); return; }
			for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) {
				if (++count === limit) {
					this.push(chunk.subarray(0, at + 1));
					child.kill();
					done();
					return;
				}
			}
			done(null, chunk);
		},
	});
	child.stdout!.pipe(output);
	child.stdout = output;
}

/** Backend callbacks must not inherit Pi's discovery/launch interception. */
export function outsideSearch<T>(fn: () => T): T { const seam = globals[key]; return seam ? seam.storage.exit(fn) : fn(); }
function escapeGlob(path: string) { return path.replace(/[\\*?\[\]{}]/g, "\\$&"); }
export function quoteSearchArg(value: string) { return `'${value.replace(/'/g, `'\\''`)}'`; }

/** One process per permission region, never per file; stdout/stderr stay separate. */
export function searchScript(executable: string, commands: string[][], tool: "rg" | "fd"): string {
	return commands.map(args => `${[executable, ...args].map(quoteSearchArg).join(" ")}; s=$?; if [ "$s" -gt ${tool === "rg" ? 1 : 0} ]; then exit "$s"; fi`).join("\n") + "\nexit 0";
}

export function spawnSearch(executable: string, args: string[], options: SpawnOptions, signal?: AbortSignal): ChildProcess {
	signal?.throwIfAborted();
	const child = (globals[key]?.spawn ?? childProcess.spawn)(executable, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	const kill = child.kill.bind(child);
	child.kill = (signal = "SIGTERM") => {
		// The local wrapper may have a native search child. Kill the whole group.
		try { if (child.pid) process.kill(-child.pid, signal); } catch {}
		return kill(signal);
	};
	const abort = () => child.kill("SIGKILL");
	signal?.addEventListener("abort", abort, { once: true });
	child.once("close", () => signal?.removeEventListener("abort", abort));
	if (signal?.aborted) abort();
	return child;
}
