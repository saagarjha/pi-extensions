import { createHash } from "node:crypto";

const rawKey = (raw: string) => "json-sha256-v1:" + createHash("sha256").update(raw).digest("hex");
export function recordKey(value: unknown): string {
	return rawKey(JSON.stringify(value));
}

/** Native immutable objects are serialized once, using standard JSON semantics.
 * The exact same string is hashed and transported; clients never re-encode it.
 * Weak memoization cannot retain replaced native history.
 */
export class ImmutableRecords {
	private records = new WeakMap<object, { key: string; raw: string }>();
	private record(entry: object) {
		let record = this.records.get(entry);
		if (!record) {
			const raw = JSON.stringify(entry);
			record = { key: rawKey(raw), raw };
			this.records.set(entry, record);
		}
		return record;
	}
	key(entry: object): string { return this.record(entry).key; }
	/** Only ordered SSE sends mutate possession. HTTP cuts use a copy. */
	wire(frame: Record<string, any>, known: Set<string>): Record<string, any> {
		if (frame.type === "snapshot") return { ...frame, ...this.cut(frame.entries, known) };
		if (frame.type === "append") {
			const { key, raw } = this.record(frame.entry);
			const entry = known.has(key) ? undefined : raw;
			known.add(key); return { ...frame, entry, entryKey: key };
		}
		if (frame.type === "childFrame")
			return { ...frame, event: { ...frame.event, frame: this.wire(frame.event.frame, known) } };
		return frame;
	}
	cut<T extends object>(entries: T[], known: Set<string>) {
		const entryKeys: string[] = [], missingKeys: string[] = [], missing: string[] = [];
		for (const entry of entries) {
			const { key, raw } = this.record(entry);
			entryKeys.push(key);
			if (!known.has(key)) { missingKeys.push(key); missing.push(raw); known.add(key); }
		}
		return { entries: missing, immutable: { entryKeys, missingKeys } };
	}
}
