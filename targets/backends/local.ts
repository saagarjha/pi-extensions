import { createReadStream, createWriteStream, lstatSync, statSync, mkdirSync, readdirSync, realpathSync, accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { searchScript, spawnSearch, type SearchPlan, type SearchRoot } from "../search.ts";
import { pipeline } from "node:stream/promises";
import type { BackendCapabilities } from "../api.ts";
import type { FileOperations, FileStat, FileProgress, SearchPolicy } from "../files.ts";
import { runDirectStream, type DirectStreamOptions } from "../transports/direct.ts";

function metadata(s: NonNullable<ReturnType<typeof statSync>>): FileStat {
	return {
		type: s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
		isDirectory: () => s.isDirectory(),
	};
}

/** Host implementation. Callers bind their authorization guard through TargetManager. */
export class LocalBackend implements FileOperations {
	readonly kind = "local" as const;
	readonly transport = "direct" as const;
	readonly enforces: BackendCapabilities = { isolation: false, mounts: false, network: false };

	searchPlan(path: string, policy?: SearchPolicy) { return localSearch(path, policy); }

	execStream(command: string, opts: DirectStreamOptions) { return runDirectStream(command, opts); }
	async exists(path: string, signal?: AbortSignal) {
		signal?.throwIfAborted();
		try { lstatSync(path); return true; }
		catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
			throw error;
		}
	}
	async size(path: string, signal?: AbortSignal) { signal?.throwIfAborted(); return statSync(path).size; }
	async stat(path: string, signal?: AbortSignal) { signal?.throwIfAborted(); return metadata(statSync(path)); }
	async lstat(path: string, signal?: AbortSignal) { signal?.throwIfAborted(); return metadata(lstatSync(path)); }
	async mkdir(path: string, signal?: AbortSignal) { signal?.throwIfAborted(); mkdirSync(path); }
	async readdir(path: string, signal?: AbortSignal) {
		signal?.throwIfAborted();
		return readdirSync(path).map(p => p.normalize("NFC")).sort();
	}
	async *openRead(path: string, signal?: AbortSignal) {
		signal?.throwIfAborted();
		for await (const chunk of createReadStream(path, { signal })) yield Buffer.from(chunk);
	}
	async write(path: string, chunks: AsyncIterable<Buffer>, signal?: AbortSignal, onProgress?: FileProgress) {
		signal?.throwIfAborted();
		let transferred = 0;
		async function* counted() {
			for await (const chunk of chunks) {
				signal?.throwIfAborted();
				transferred += chunk.length;
				onProgress?.(transferred);
				yield chunk;
			}
		}
		await pipeline(counted(), createWriteStream(path), { signal });
	}
}

function under(path: string, parent: string): boolean {
	return path === parent || path.startsWith(parent === "/" ? "/" : `${parent}/`);
}

/** Native traversal uses disjoint permission regions, not per-entry host checks. */
export function localSearchPlan(root: string, policy: SearchPolicy) {
	const scopes = policy.scopes.map((scope, index) => ({ ...scope, index }));
	const winner = (path: string) => scopes.filter(scope => under(path, scope.path)).sort((a, b) =>
		b.path.length - a.path.length || a.index - b.index)[0];
	const access = (path: string): "allow" | "deny" | undefined => {
		const scope = winner(path);
		if (!scope) return undefined;
		if (scope.access === "allow") return "allow";
		if (scope.access === "ask" && policy.approved?.scopePath === scope.path && under(path, policy.approved.path)) return "allow";
		return "deny";
	};
	if (access(root) !== "allow") throw new Error("Search root is not approved for reading");
	const boundaries = [...new Set([...scopes.map(scope => scope.path), ...(policy.approved ? [policy.approved.path] : [])])].sort((a, b) => a.length - b.length);
	const regions: { path: string; access: "allow" | "deny"; exclude: string[] }[] = [];
	for (const path of boundaries) {
		const parent = regions.filter(region => under(path, region.path)).at(-1);
		const mode = access(path);
		if (mode && mode !== parent?.access) regions.push({ path, access: mode, exclude: [] });
	}
	for (const region of regions) {
		const parent = regions.filter(candidate => candidate !== region && under(region.path, candidate.path)).at(-1);
		parent?.exclude.push(region.path);
	}
	const roots: SearchRoot[] = [];
	for (const region of regions) {
		if (region.access !== "allow") continue;
		if (under(region.path, root)) roots.push({ path: region.path, exclude: region.exclude });
		else if (under(root, region.path) && !region.exclude.some(path => under(root, path))) roots.push({ path: root, exclude: region.exclude.filter(path => under(path, root)) });
	}
	return { regions, roots, access };
}

function searchExecutable(tool: "rg" | "fd"): string {
	// Pi's managed tool cache is preferred. Do not probe with unsandboxed --version
	// or invoke ensureTool's implicit download path. Resolution does not execute.
	const candidates = [join(getAgentDir(), "bin", tool), ...(process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map(path => join(path, tool))];
	for (const path of candidates) {
		try {
			const canonical = realpathSync(path);
			if (!statSync(canonical).isFile()) continue;
			accessSync(canonical, constants.X_OK);
			return canonical;
		} catch {}
	}
	throw new Error(`Native search requires ${tool}; install it in Pi's bin directory or PATH. No automatic download was attempted.`);
}

function localSearch(root: string, policy?: SearchPolicy): SearchPlan {
	if (process.platform !== "darwin") throw new Error("Recursive local search requires an implemented OS sandbox; use an authorized VM/SSH target on this platform");
	if (!policy) throw new Error("Recursive local search requires a request-bound read policy");
	policy.assertFresh();
	root = realpathSync(root).normalize("NFC");
	return sandboxedLocalSearch(root, policy);
}

/** A caller with an already normalized/mapped root can use the same command backstop
 * without synchronous IO on a filesystem that may reverse-prompt this process. */
export function sandboxedLocalSearch(root: string, policy: SearchPolicy): SearchPlan {
	if (process.platform !== "darwin") throw new Error("Recursive local search requires an implemented OS sandbox; use an authorized VM/SSH target on this platform");
	policy.assertFresh();
	const plan = localSearchPlan(root, policy);
	return {
		roots: plan.roots,
		spawn: (tool, commands, signal) => {
			const executable = searchExecutable(tool);
			if (plan.access(executable) === "deny") throw new Error(`Search executable is explicitly restricted: ${executable}`);
			const parameters: string[] = [];
			const parameter = (path: string) => {
				if (path.includes("\0")) throw new Error("Invalid sandbox path");
				const name = `P${parameters.length / 2}`;
				parameters.push("-D", `${name}=${path}`);
				return `(param "${name}")`;
			};
			const binary = parameter(executable);
			const rules = [
				'(version 1)', '(deny default)', '(import "system.sb")',
				'(deny network*)', '(deny file-write*)',
				'(allow file-read-metadata file-test-existence)',
				`(allow process-exec file-read-data file-map-executable (literal ${binary}))`,
			];
			for (const region of plan.regions) {
				const filters = [`(subpath ${parameter(region.path)})`, ...region.exclude.map(path => `(require-not (subpath ${parameter(path)}))`)];
				const filter = filters.length === 1 ? filters[0] : `(require-all ${filters.join(" ")})`;
				rules.push(`(${region.access} file-read-data ${filter})`);
			}
			const multiplex = commands.length > 1;
			if (multiplex) {
				// macOS /bin/sh dispatches to a shell variant. Select bash directly so
				// the profile needs precisely one known wrapper executable.
				if (plan.access("/bin/bash") === "deny") throw new Error("Search wrapper /bin/bash is explicitly restricted");
				rules.push('(allow process-fork)', `(allow process-exec file-read-data file-map-executable (literal ${parameter("/bin/bash")}))`);
			}
			const launch = multiplex ? ["/bin/bash", "--noprofile", "--norc", "-c", searchScript(executable, commands, tool)] : [executable, ...commands[0]!];
			// Revalidate immediately before spawn, after executable resolution/profile construction.
			policy.assertFresh(); signal?.throwIfAborted();
			return spawnSearch("/usr/bin/sandbox-exec", ["-p", rules.join("\n"), ...parameters, ...launch], {
				cwd: "/", env: { PATH: "/usr/bin:/bin", HOME: "/var/empty", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
			}, signal);
		},
	};
}
