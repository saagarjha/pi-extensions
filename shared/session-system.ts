import { copyFileSync, linkSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type SessionContext = Pick<ExtensionContext, "sessionManager">;

export function sessionSystemRoot(ctx: SessionContext): string {
	return join(tmpdir(), "pi-session-system", ctx.sessionManager.getSessionId());
}

/** Hardlinks stay live as the transcript grows; fallback copies refresh on each call. */
export function syncTranscriptLink(source: string, destination: string): void {
	try {
		const sourceStat = statSync(source);
		let destinationStat;
		try { destinationStat = lstatSync(destination); } catch {}
		if (destinationStat?.isFile() && sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) return;
		mkdirSync(dirname(destination), { recursive: true });
		if (destinationStat) unlinkSync(destination);
		try { linkSync(source, destination); }
		catch { copyFileSync(source, destination); }
	} catch {
		// A transcript may not exist until the first assistant message is saved.
		// Publishing this convenience view must not interrupt the session.
	}
}

export function publishSubagentTranscript(ctx: SessionContext, id: string, source: string): void {
	try {
		const directory = join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId());
		// Only expose this parent's child archives, never arbitrary persisted paths.
		if (!/^sub_[a-z0-9]+$/i.test(id) || dirname(source) !== directory || !lstatSync(source).isFile()) return;
		syncTranscriptLink(source, join(sessionSystemRoot(ctx), "subagents", `${id}.jsonl`));
	} catch {
		// Missing archives can be published on a subsequent update.
	}
}
