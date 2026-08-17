import { dirname, join } from "node:path";
import { copyFiles } from "./algorithms.ts";
import { outsideSearch, withNativeSearch, type SearchPlan } from "./search.ts";
export type FileProgress = (transferred: number, total?: number) => void;

/** Minimal target-owned metadata required by built-in directory tools. */
export type FileStat = {
	/** Target-defined file type; symlink handling intentionally remains target-specific. */
	type: "file" | "directory" | "symlink" | "other";
	/** Whether this target considers the path a directory (including its own symlink rules). */
	isDirectory: () => boolean;
};

export type SearchPolicy = {
	scopes: readonly { path: string; access: "allow" | "deny" | "ask" }[];
	approved?: { path: string; scopePath: string };
	assertFresh(): void;
};

export type FileOperations = {
	searchPlan(path: string, policy?: SearchPolicy): SearchPlan;

	exists(path: string, signal?: AbortSignal): Promise<boolean>;
	/** Size of a regular file, obtained during copy preflight. */
	size(path: string, signal?: AbortSignal): Promise<number>;
	openRead(path: string, signal?: AbortSignal): AsyncIterable<Buffer>;
	/** Target-owned metadata and direct-child listing for built-in ls. */
	stat(path: string, signal?: AbortSignal): Promise<FileStat>;
	/** Exact entry type without following the final symlink. */
	lstat(path: string, signal?: AbortSignal): Promise<FileStat>;
	/** Create one directory; fail if it exists or its parent is missing. */
	mkdir(path: string, signal?: AbortSignal): Promise<void>;
	/** Bound listings filter denied children; strict copy listings instead fail on them. */
	readdir(path: string, signal?: AbortSignal, strict?: boolean): Promise<string[]>;
	/** `onProgress` receives bytes accepted from `chunks`, without retaining them. */
	write(path: string, chunks: AsyncIterable<Buffer>, signal?: AbortSignal, onProgress?: FileProgress): Promise<void>;
};

export async function readBuffer(files: FileOperations, path: string, signal?: AbortSignal): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of files.openRead(path, signal)) {
		chunks.push(chunk);
		length += chunk.length;
	}
	return Buffer.concat(chunks, length);
}

export async function writeBuffer(files: FileOperations, path: string, content: Buffer, signal?: AbortSignal): Promise<void> {
	await files.write(path, (async function* () { yield content; })(), signal);
}

/** Policy supplies resolution/authorization only; implementations never import policy. */
export type FilePathGuard = (path: string, intent: "existing" | "create" | "entry") => string;

export class TargetFiles implements FileOperations {
	constructor(private readonly backend: FileOperations, private readonly guard: FilePathGuard, private readonly searchPolicy?: SearchPolicy) {}

	async exists(path: string, signal?: AbortSignal) {
		try { return await this.backend.exists(this.guard(path, "create"), signal); }
		catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
			throw error;
		}
	}
	size(path: string, signal?: AbortSignal) { return this.backend.size(this.guard(path, "existing"), signal); }
	stat(path: string, signal?: AbortSignal) { return this.backend.stat(this.guard(path, "existing"), signal); }
	lstat(path: string, signal?: AbortSignal) { return this.backend.lstat(this.guard(path, "entry"), signal); }
	mkdir(path: string, signal?: AbortSignal) { return this.backend.mkdir(this.guard(path, "create"), signal); }
	/** Create missing ancestors through the same guard as every other mutation. */
	async mkdirParents(path: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (await this.exists(path, signal)) {
			if (!(await this.stat(path, signal)).isDirectory()) throw new Error(`not a directory: ${path}`);
			return;
		}
		const parent = dirname(path);
		if (parent === path) throw new Error(`directory root does not exist: ${path}`);
		await this.mkdirParents(parent, signal);
		try { await this.mkdir(path, signal); }
		catch (error) {
			// A concurrent writer may have created the directory after our check.
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await this.stat(path, signal)).isDirectory()) throw error;
		}
	}
	async readdir(path: string, signal?: AbortSignal, strict = false) {
		const root = this.guard(path, "existing"), names = await this.backend.readdir(root, signal), allowed: string[] = [];
		for (const name of names) {
			signal?.throwIfAborted();
			if (!name || name === "." || name === ".." || name.includes("/")) throw new Error("invalid directory entry");
			try { this.guard(join(root, name), "entry"); allowed.push(name); }
			catch (error) { signal?.throwIfAborted(); if (strict) throw error; }
		}
		return allowed;
	}
	async *openRead(path: string, signal?: AbortSignal) { yield* this.backend.openRead(this.guard(path, "existing"), signal); }
	write(path: string, chunks: AsyncIterable<Buffer>, signal?: AbortSignal, onProgress?: FileProgress) {
		return this.backend.write(this.guard(path, "create"), chunks, signal, onProgress);
	}
	searchPlan(path: string) {
		this.searchPolicy?.assertFresh();
		return this.backend.searchPlan(this.guard(path, "existing"), this.searchPolicy);
	}
	async search<T>(tool: "rg" | "fd", path: string, signal: AbortSignal | undefined, execute: (root: string) => Promise<T>) {
		const root = this.guard(path, "existing");
		const fresh = () => this.searchPolicy?.assertFresh();
		fresh();
		const plan = this.backend.searchPlan(root, this.searchPolicy);
		return withNativeSearch({ tool, root, plan, signal, assertFresh: fresh,
			exists: candidate => this.exists(candidate, signal),
		}, () => execute(root));
	}
	/** Pi callbacks stay authorized and do not inherit the narrow native-launch seam. */
	searchIO<T>(fn: () => T): T {
		this.searchPolicy?.assertFresh();
		return outsideSearch(fn);
	}
	copyTo(destination: FileOperations, options: Parameters<typeof copyFiles>[2], signal?: AbortSignal, progress?: Parameters<typeof copyFiles>[4]) {
		return copyFiles(this, destination, options, signal, progress);
	}
}
