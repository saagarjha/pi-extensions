import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function fail(code: string, message: string): never {
	const error = new Error(`${code}: ${message}`);
	Object.assign(error, { code });
	throw error;
}

/**
 * Fork a persisted native session without changing its live manager or source file.
 * Caller must serialize this with source operations (including external writers).
 * Returns a NEW SessionManager; pass it directly to createAgentSession.
 * options.sessionDir selects the destination directory (default: parent's directory).
 * Native SDK owns path selection, IDs, labels, compaction and parentSession metadata.
 * A selected pre-assistant branch is intentionally unflushed: retain this manager;
 * do not reopen its filename before its first assistant message creates the file.
 * Initial unpersisted sources cannot be forked through this public-API adapter.
 */
export function forkSession(
	parent: SessionManager,
	leafId: string | null,
	{ sessionDir }: { sessionDir?: string } = {},
) {
	const sourceFile = parent.getSessionFile();
	if (!parent.isPersisted() || !sourceFile) {
		fail("FORK_SOURCE_NOT_PERSISTED", "Source needs a native persisted session file.");
	}
	if (typeof leafId !== "string" || !parent.getEntry(leafId)) {
		fail("FORK_INVALID_LEAF", "Select an existing native entry ID.");
	}
	let text;
	try {
		text = readFileSync(sourceFile, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			fail(
				"FORK_SOURCE_NOT_PERSISTED",
				"Wait for the first assistant response to persist the source.",
			);
		}
		throw error;
	}
	// Never open an empty/invalid source: native open can initialize an empty file.
	// Require the complete authoritative history, not just the selected branch.
	let disk;
	try {
		disk = text
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	} catch {
		fail("FORK_SOURCE_NOT_SYNCHRONIZED", "Source file contains invalid JSONL.");
	}
	const expected = JSON.parse(JSON.stringify([parent.getHeader(), ...parent.getEntries()]));
	if (!expected[0] || !isDeepStrictEqual(disk, expected)) {
		fail(
			"FORK_SOURCE_NOT_SYNCHRONIZED",
			"Source disk history differs from the live native manager; fork refused without flushing or rewriting it.",
		);
	}
	const fork = SessionManager.open(sourceFile, sessionDir ?? parent.getSessionDir());
	// createBranchedSession mutates its receiver, so ONLY call it on this fresh manager.
	fork.createBranchedSession(leafId);
	return fork;
}
