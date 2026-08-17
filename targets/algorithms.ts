import { basename, dirname } from "node:path";
import type { FileOperations } from "./files.ts";

export type GrepOptions = {
	path: string;
	pattern: string;
	literal?: boolean;
	ignoreCase?: boolean;
	glob?: string;
	context?: number;
	limit?: number;
};

// Copy

export type CopyOptions = {
	sourcePath: string;
	destPath: string;
	overwrite?: boolean;
	maxEntries?: number;
	sameTarget?: boolean;
};

type CopyProgress = (from: string, to: string, transferred: number, total: number) => void;

function appendTargetPath(base: string, name: string): string {
	return `${base.replace(/\/+$/, "")}/${name}`;
}

export async function copyFiles(
	source: FileOperations,
	destination: FileOperations,
	options: CopyOptions,
	signal?: AbortSignal,
	onProgress?: CopyProgress,
): Promise<{ files: number; dirs: number }> {
	const maxEntries = Math.max(1, Math.min(Number(options.maxEntries ?? 10_000), 100_000));
	let files = 0;
	let dirs = 0;

	const checkEntryLimit = () => {
		if (files + dirs >= maxEntries) {
			throw new Error(`copy stopped after ${maxEntries} entries; narrow the source or raise maxEntries`);
		}
	};
	const statEntry = async (backend: FileOperations, path: string, role: "source" | "destination") => {
		const stat = await backend.lstat(path, signal);
		if (stat.type === "symlink") {
			throw new Error(`${role} is a symlink; copy refuses symlinks for consistent cross-target semantics: ${path}`);
		}
		return stat;
	};

	const copyFile = async (from: string, to: string) => {
		checkEntryLimit();
		if ((await statEntry(source, from, "source")).type !== "file") {
			throw new Error(`source is not a regular file: ${from}`);
		}
		if (await destination.exists(to, signal)) {
			if ((await statEntry(destination, to, "destination")).type !== "file") {
				throw new Error(`destination is not a regular file: ${to}`);
			}
			if (!options.overwrite) throw new Error(`destination exists (set overwrite=true to replace): ${to}`);
		}

		const total = await source.size(from, signal);
		const progress = (transferred: number) => onProgress?.(from, to, transferred, total);
		progress(0);
		const parent = dirname(to);
		// Keep the trailing dot: copy permits symlinked parents, but not final entries.
		if (!(await destination.stat(appendTargetPath(parent, "."), signal)).isDirectory()) {
			throw new Error(`destination parent is not a directory: ${parent}`);
		}
		await destination.write(to, source.openRead(from, signal), signal, progress);
		files++;
	};

	const copyDirectory = async (from: string, to: string) => {
		await statEntry(source, from, "source");
		if (await destination.exists(to, signal)) {
			if (!(await statEntry(destination, to, "destination")).isDirectory()) {
				throw new Error(`destination exists and is not a directory: ${to}`);
			}
		} else {
			checkEntryLimit();
			await destination.mkdir(to, signal);
			dirs++;
		}

		// Strict listing fails on denied children rather than silently omitting them.
		for (const name of await source.readdir(from, signal, true)) {
			const childFrom = appendTargetPath(from, name);
			const childTo = appendTargetPath(to, name);
			if ((await statEntry(source, childFrom, "source")).isDirectory()) {
				await copyDirectory(childFrom, childTo);
			} else {
				await copyFile(childFrom, childTo);
			}
		}
	};

	const { sourcePath, destPath } = options;
	if (!(await source.exists(sourcePath, signal))) throw new Error(`source does not exist: ${sourcePath}`);
	const sourceStat = await statEntry(source, sourcePath, "source");
	if (sourceStat.isDirectory()) {
		if (options.sameTarget && (destPath === sourcePath || destPath.startsWith(appendTargetPath(sourcePath, "")))) {
			throw new Error("cannot copy a directory into itself or one of its descendants");
		}
		await copyDirectory(sourcePath, destPath);
	} else {
		if (sourceStat.type !== "file") throw new Error(`source is not a regular file: ${sourcePath}`);
		const destIsDirectory = (await destination.exists(destPath, signal))
			&& (await statEntry(destination, destPath, "destination")).isDirectory();
		await copyFile(sourcePath, destIsDirectory ? appendTargetPath(destPath, basename(sourcePath)) : destPath);
	}
	return { files, dirs };
}
