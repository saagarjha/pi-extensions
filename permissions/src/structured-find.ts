import { isAbsolute, relative, resolve } from "node:path";
import type { FindToolDetails } from "@earendil-works/pi-coding-agent";
import type { FindCapture } from "../../targets/search.ts";

// Mirrors Pi's relativizeFindResultPath on our POSIX targets, preserving trailing separators.
function relativize(path: string, root: string): string {
	const name = isAbsolute(path) ? relative(root, path) : path;
	return path.endsWith("/") && !name.endsWith("/") ? `${name}/` : name;
}

/** Metadata comes from framed authorized fd records, never from the rendered tool text. */
export function withStructuredFind<T extends { details?: FindToolDetails }>(result: T, capture: FindCapture, target: string, pattern: string) {
	if (!capture.path) throw new Error("Missing authorized find root");
	const root = capture.path;
	const entries: { name: string; path: string; kind: "unknown" }[] = [];
	const budget = result.details?.truncation?.outputBytes ?? Infinity;
	let bytes = 0, lineCount = 0, incomplete = capture.incomplete;
	for (const record of capture.records) {
		// Account for Pi's readline/trim/relativize formatting using original records.
		// A filename can generate multiple legacy text lines; only expose complete records.
		const lines = record.forwarded.split(/\r\n|[\r\n]/).map(line => line.trim()).filter(Boolean).map(line => relativize(line, root));
		for (const line of lines) bytes += Buffer.byteLength(line) + (lineCount++ ? 1 : 0);
		if (bytes > budget) { incomplete = true; break; }
		if (!record.complete || !lines.length) { incomplete = true; continue; }
		entries.push({ name: relativize(record.path, root), path: resolve(root, record.path), kind: "unknown" });
	}
	return { ...result, details: {
		...result.details,
		path: root, target, pattern, entries, returnedCount: entries.length,
		truncated: incomplete || result.details?.resultLimitReached !== undefined || result.details?.truncation?.truncated === true,
	} };
}
