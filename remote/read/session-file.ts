import { closeSync, fstatSync, openSync, readFileSync, statSync, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
	EMPTY,
	chain,
	check,
	hash,
	type Range,
	type RecordRef,
	type BodyChunk,
	type SourceDeclaration,
} from "./protocol.ts";

const CHUNK = 65536;

function version(stat: BigIntStats) {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

interface Entry {
	body: Buffer;
	hash: string;
	root: string;
}

/** Read-only JSONL history. Only newline-terminated records enter a history cut. */
export class SessionFile {
	private generation = randomUUID();
	private entries: Entry[] = [];
	private bytes = Buffer.alloc(0);
	private identity = "";
	private version = "";
	private completeBytes = 0;
	private dirty = false;

	constructor(private source: SourceDeclaration) {}

	invalidate() {
		this.dirty = true;
	}

	private readSource() {
		check(this.source.path, "SOURCE_MISSING");
		let descriptor: number;
		try {
			const live = statSync(this.source.path, { bigint: true });
			if (!this.dirty && version(live) === this.version) return;
			descriptor = openSync(this.source.path, "r");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") throw Error("SOURCE_MISSING");
			throw error;
		}
		try {
			const before = fstatSync(descriptor, { bigint: true });
			// Changed files still need an exact prefix comparison: growth alone cannot
			// distinguish append from an in-place rewrite followed by append.
			const bytes = readFileSync(descriptor);
			const after = fstatSync(descriptor, { bigint: true });
			const live = statSync(this.source.path, { bigint: true });
			check(
				version(before) === version(after) &&
					BigInt(bytes.length) === after.size &&
					version(live) === version(after),
				"SOURCE_BUSY",
			);
			return { bytes, identity: `${after.dev}:${after.ino}`, version: version(after) };
		} finally {
			closeSync(descriptor);
		}
	}

	private isAppend(source: { bytes: Buffer; identity: string }) {
		return (
			source.identity === this.identity &&
			source.bytes.length >= this.bytes.length &&
			source.bytes.subarray(0, this.bytes.length).equals(this.bytes)
		);
	}

	refresh(): Range {
		const source = this.readSource();
		if (!source) return this.rangeValue();
		const append = !this.dirty && this.isAppend(source);
		// Build only the new complete tail off to the side. Existing entries and
		// their hashes/chains are immutable; an incomplete final line resumes at
		// its original byte offset, including any split UTF-8 sequence.
		const entries: Entry[] = [];
		let root = append ? this.rangeValue().root : EMPTY;
		let start = append ? this.completeBytes : 0;
		try {
			for (let end = source.bytes.indexOf(10, start); end !== -1; end = source.bytes.indexOf(10, start)) {
				const body = source.bytes.subarray(start, end);
				JSON.parse(body.toString("utf8"));
				const digest = hash(body);
				root = chain(root, digest);
				// Own each record's bytes so retaining entries across appends does not
				// retain a whole obsolete file buffer for every appended batch.
				entries.push({ body: Buffer.from(body), hash: digest, root });
				start = end + 1;
			}
		} catch (error) {
			this.dirty = true;
			throw new Error("CORRUPT_JSON", { cause: error });
		}
		if (!append) {
			this.generation = randomUUID();
			this.entries = entries;
		} else {
			for (const entry of entries) this.entries.push(entry);
		}
		this.bytes = source.bytes;
		this.identity = source.identity;
		this.version = source.version;
		this.completeBytes = start;
		this.dirty = false;
		return this.rangeValue();
	}

	private rangeValue(): Range {
		return {
			generation: this.generation,
			count: this.entries.length,
			root: this.entries.at(-1)?.root ?? EMPTY,
		};
	}

	private validate(range: Range) {
		this.refresh();
		check(
			range.count <= this.entries.length &&
				range.generation === this.generation &&
				range.root === (range.count ? this.entries[range.count - 1]!.root : EMPTY),
			"STALE_SOURCE",
		);
	}

	page(range: Range, before = range.count, limit = 32) {
		this.validate(range);
		const start = Math.max(0, before - limit);
		const records: RecordRef[] = [];
		for (let index = start; index < before; index++) {
			const entry = this.entries[index]!;
			records.push({
				index,
				hash: entry.hash,
				bytes: entry.body.length,
				root: entry.root,
			});
		}
		return {
			start,
			end: before,
			prefixRoot: start ? this.entries[start - 1]!.root : EMPTY,
			endRoot: before ? this.entries[before - 1]!.root : EMPTY,
			records,
		};
	}

	body(range: Range, index: number, offset = 0, length = CHUNK): BodyChunk {
		this.validate(range);
		const entry = this.entries[index]!;
		return {
			hash: entry.hash,
			offset,
			total: entry.body.length,
			data: entry.body.subarray(offset, offset + length).toString("base64"),
		};
	}
}
