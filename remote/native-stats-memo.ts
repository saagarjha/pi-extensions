import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Stats = ReturnType<AgentSession["getSessionStats"]>;
type Stamp = readonly unknown[];
const same = (a: Stamp | undefined, b: Stamp | undefined) =>
	!!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/** Owner-local native answers; SDK 1.0.2 committed entries are append-only. */
export class NativeStatsMemo {
	#entries = new WeakMap<AgentSession, { stamp: Stamp; value: Stats }>();
	#stamp(session: AgentSession): Stamp | undefined {
		// Resolve live/virtual physical limits before reading committed-history fences.
		const limits = session.routedModel?.model ?? session.model;
		const window = limits?.contextWindow;
		const manager = session.sessionManager;
		const header = manager.getHeader(), count = manager.getEntryCount(), leaf = manager.getLeafId();
		// Let native getters handle absent/invalid limits without interpreting SDK math.
		if (!header || !Number.isSafeInteger(count) || count < 0 ||
			!(leaf === null || typeof leaf === "string") ||
			typeof window !== "number" || !Number.isFinite(window) || window <= 0) return undefined;
		return [session, manager, header, count, leaf, session.sessionFile, session.sessionId, window];
	}
	read(session: AgentSession): Stats {
		const before = this.#stamp(session), entry = this.#entries.get(session);
		if (before && entry && same(before, entry.stamp)) return structuredClone(entry.value);
		const value = session.getSessionStats(), after = this.#stamp(session);
		this.#entries.delete(session);
		// Do not retain an answer across mutations inside the synchronous native call.
		if (before && same(before, after) && Object.is(value.contextUsage?.contextWindow, before[7]) &&
			Object.is(value.sessionFile, before[5]) && Object.is(value.sessionId, before[6])) {
			this.#entries.set(session, { stamp: before, value: structuredClone(value) });
		}
		return structuredClone(value);
	}
	dispose(session?: AgentSession): void {
		if (session) this.#entries.delete(session);
		else this.#entries = new WeakMap();
	}
	rebind(previous?: AgentSession): void { this.dispose(previous); }
}
