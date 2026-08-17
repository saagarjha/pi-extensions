import { basename, relative, resolve } from "node:path";
import { truncateLine, type GrepToolDetails } from "@earendil-works/pi-coding-agent";
import type { GrepCapture } from "../../targets/search.ts";

export type GrepEntry = { name: string; path: string; line: number; text: string; match: boolean };

/** Reconstruct row identity from rg JSON and Pi's existing context reads, not formatted output. */
export function withStructuredGrep<T extends { details?: GrepToolDetails }>(result: T, capture: GrepCapture, target: string, pattern: string, context = 0) {
	if (!capture.path) throw new Error("Missing authorized grep root");
	const root = capture.path;
	const entries: GrepEntry[] = [];
	const fileLines = new Map<string, string[]>();
	const budget = result.details?.truncation?.outputBytes ?? Infinity;
	let bytes = 0, rows = 0, incomplete = capture.incomplete;
	const displayName = (path: string) => {
		if (capture.isDirectory) {
			const name = relative(root, path);
			if (name && !name.startsWith("..")) return name.replace(/\\/g, "/");
		}
		return basename(path);
	};
	const append = (name: string, path: string, line: number, text: string, match: boolean, known = true) => {
		const bounded = truncateLine(text).text;
		const separator = match ? ":" : "-";
		bytes += (rows++ ? 1 : 0) + Buffer.byteLength(`${name}${separator}${line}${separator} ${bounded}`);
		if (bytes > budget) { incomplete = true; return false; }
		if (known && Number.isSafeInteger(line) && line > 0 && !bounded.includes("\n")) {
			entries.push({ name, path: resolve(root, path), line, text: bounded, match });
		} else incomplete = true;
		return true;
	};
	const contextValue = context > 0 ? context : 0;
	outer: for (const match of capture.matches) {
		const name = displayName(match.path);
		if (contextValue === 0 && match.text !== undefined) {
			const sanitized = match.text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
			if (!append(name, match.path, match.line, sanitized, true)) break;
			continue;
		}
		const content = capture.files.get(match.path);
		if (content === undefined) {
			// Account for Pi's placeholder, without presenting invented file content as a source row.
			if (!append(name, match.path, match.line, "(unable to read file)", true, false)) break;
			continue;
		}
		let lines = fileLines.get(match.path);
		if (!lines) {
			lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			fileLines.set(match.path, lines);
		}
		const start = contextValue > 0 ? Math.max(1, match.line - contextValue) : match.line;
		const end = contextValue > 0 ? Math.min(lines.length, match.line + contextValue) : match.line;
		if (start > end) incomplete = true;
		for (let line = start; line <= end; line++) {
			if (!append(name, match.path, line, (lines[line - 1] ?? "").replace(/\r/g, ""), line === match.line, lines[line - 1] !== undefined)) break outer;
		}
	}
	return { ...result, details: {
		...result.details,
		path: root, target, pattern, isDirectory: capture.isDirectory, entries, returnedCount: entries.length,
		truncated: incomplete || result.details?.matchLimitReached !== undefined || result.details?.truncation?.truncated === true || result.details?.linesTruncated === true,
	} };
}
