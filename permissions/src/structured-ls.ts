import { join } from "node:path";
import { createLsToolDefinition, type LsOperations } from "@earendil-works/pi-coding-agent";
import type { FileStat } from "../../targets/files.ts";

export type StructuredLsOperations = LsOperations & {
	lstat(path: string): Promise<FileStat>;
};
export type LsEntry = { name: string; path: string; kind: "directory" | "file" | "symlink" | "unknown" };

/** Keep Pi's text/renderers and capture only entries its authorized operations actually emit. */
export function createStructuredLsToolDefinition(cwd: string, options?: { operations: StructuredLsOperations; target?: string }) {
	const shell = createLsToolDefinition(cwd);
	return {
		...shell,
		async execute(...args: Parameters<typeof shell.execute>) {
			if (!options) throw new Error("Structured ls requires authorized filesystem operations");
			const ops = options.operations;
			let directory: string | undefined;
			const names = new Map<string, string>();
			const emitted: { name: string; path: string; directory: boolean }[] = [];
			const base = createLsToolDefinition(cwd, { operations: {
				exists: path => ops.exists(path),
				async readdir(path) {
					const entries = await ops.readdir(path);
					directory = path;
					for (const name of entries) names.set(join(path, name), name);
					return entries;
				},
				async stat(path) {
					const stat = await ops.stat(path);
					const name = names.get(path);
					if (name !== undefined) emitted.push({ name, path, directory: stat.isDirectory() });
					return stat;
				},
			} });
			const result = await base.execute(...args);
			const entries: LsEntry[] = [];
			// A newline inside a filename may be partially included by Pi's byte truncation.
			// Count original entry bytes, never recover names by splitting rendered output.
			const budget = result.details?.truncation?.outputBytes ?? Infinity;
			let bytes = 0;
			let incomplete = false;
			for (const [index, entry] of emitted.entries()) {
				bytes += (index ? 1 : 0) + Buffer.byteLength(entry.name) + (entry.directory ? 1 : 0);
				if (bytes > budget) break;
				let kind: LsEntry["kind"] = "unknown";
				try {
					// stat follows links on some targets; only authorized lstat can identify the entry itself.
					const stat = await ops.lstat(entry.path);
					if (stat.type !== "other") kind = stat.type;
				} catch {
					args[2]?.throwIfAborted();
					// Omit disappeared/newly denied entries, but never claim a complete empty listing.
					incomplete = true;
					continue;
				}
				entries.push({ name: entry.name, path: entry.path, kind });
			}
			return { ...result, details: {
				...result.details,
				path: directory,
				target: options.target,
				entries,
				returnedCount: entries.length,
				truncated: incomplete || result.details?.entryLimitReached !== undefined || result.details?.truncation?.truncated === true,
			} };
		},
	};
}
