import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { nfc, resolveReal } from "./paths.ts";

/**
 * Filesystem operations gated on a resolved path.
 *
 * Every entry point resolves symlinks first and checks containment on the
 * result, so a symlink inside a granted directory pointing outside it is
 * refused. See the FIXME on resolveReal for the race this ordering leaves open.
 */

export class DeniedError extends Error {
	constructor(readonly realPath: string) {
		super(`denied: ${realPath}`);
		this.name = "DeniedError";
	}
}

/** Predicate over the fully-resolved path. */
export type Allow = (realPath: string) => boolean;

/** Resolve an existing path and confirm it is permitted. */
export function checkedPath(path: string, allow: Allow): string {
	const real = resolveReal(path);
	if (!allow(real)) throw new DeniedError(real);
	return real;
}

/**
 * Resolve a path that may not exist yet, for creation.
 *
 * The file itself cannot be resolved, so authorization attaches to its parent
 * directory, which must exist and be permitted.
 */
export function checkedNewPath(path: string, allow: Allow): string {
	const parent = resolveReal(dirname(path));
	if (!allow(parent)) throw new DeniedError(parent);
	const real = `${parent}/${nfc(basename(path))}`;
	if (!allow(real)) throw new DeniedError(real);
	return real;
}

export function mkdirVerified(path: string, allow: Allow): string {
	try {
		const real = checkedPath(path, allow);
		if (!statSync(real).isDirectory()) throw new Error(`${path} exists and is not a directory`);
		return real;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (err instanceof DeniedError || (code !== "ENOENT" && code !== "ENOTDIR")) throw err;
	}
	const real = checkedNewPath(path, allow);
	mkdirSync(real);
	return real;
}

export function readFileVerified(path: string, allow: Allow, maxBytes = 512 * 1024) {
	const realPath = checkedPath(path, allow);
	if (statSync(realPath).isDirectory()) throw new Error(`${path} is a directory`);
	const buf = readFileSync(realPath);
	return {
		text: buf.subarray(0, maxBytes).toString("utf8"),
		truncated: buf.byteLength > maxBytes,
		realPath,
	};
}

export function listDirVerified(path: string, allow: Allow) {
	const realPath = checkedPath(path, allow);
	return { entries: readdirSync(realPath).map(nfc).sort(), realPath };
}

export function writeFileVerified(path: string, contents: string, allow: Allow): string {
	return writeBufferVerified(path, Buffer.from(contents, "utf8"), allow);
}

export function writeBufferVerified(path: string, contents: Buffer, allow: Allow): string {
	try {
		lstatSync(path);
		const real = checkedPath(path, allow);
		writeFileSync(real, contents);
		return real;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
	}
	const real = checkedNewPath(path, allow);
	writeFileSync(real, contents);
	return real;
}

export function editFileVerified(path: string, allow: Allow, transform: (before: string) => string): string {
	const real = checkedPath(path, allow);
	writeFileSync(real, transform(readFileSync(real, "utf8")), "utf8");
	return real;
}

export type WalkLimits = { maxEntries?: number; maxDepth?: number };

/**
 * Walk a tree, visiting only what the predicate permits.
 *
 * Entries that fail the check are skipped silently rather than reported, so a
 * walk cannot be used to map the parts of the filesystem it may not read —
 * denied, missing and unreadable are deliberately indistinguishable.
 */
export function walkVerified(
	root: string,
	allow: Allow,
	visit: (realPath: string, isDir: boolean) => void,
	limits: WalkLimits = {},
): void {
	const maxEntries = limits.maxEntries ?? 5000;
	const maxDepth = limits.maxDepth ?? 24;
	let seen = 0;

	const step = (path: string, depth: number): void => {
		if (depth > maxDepth || seen >= maxEntries) return;
		let dir: string;
		let names: string[];
		try {
			dir = checkedPath(path, allow);
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (seen >= maxEntries) return;
			let real: string;
			let isDir: boolean;
			try {
				real = checkedPath(`${dir}/${name}`, allow);
				isDir = statSync(real).isDirectory();
			} catch {
				continue;
			}
			seen += 1;
			visit(real, isDir);
			if (isDir) step(real, depth + 1);
		}
	};

	step(root, 0);
}
