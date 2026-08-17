import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConnectionProfile } from "./connection-profile.ts";

const keyPattern = /^json-sha256-v1:[0-9a-f]{64}$/;
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
function privatePath(path: string, directory: boolean) {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
		stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw Error("UNSAFE_IMMUTABLE_CACHE");
}
function syncDirectory(path: string) {
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}
function prepareDirectory(path: string) {
	const first = mkdirSync(path, { recursive: true, mode: 0o700 });
	privatePath(path, true);
	if (first) for (let created = resolve(path); ; created = dirname(created)) {
		syncDirectory(dirname(created));
		if (created === resolve(first)) break;
	}
}

/** Disposable authenticated-endpoint content, never session/control authority.
 * SQLite is built into Pi's supported Node runtime. A complete received cut is
 * committed before possession or an ACK is exposed, without a sync per record.
 * Old per-record files remain untouched and are not advertised by this store.
 */
export class ImmutableClientCache {
	private keys = new Set<string>();
	readonly directory: string;
	private root: string;
	private db?: DatabaseSync;
	private insert?: ReturnType<DatabaseSync["prepare"]>;
	private select?: ReturnType<DatabaseSync["prepare"]>;
	private closed = false;
	constructor(connection: ConnectionProfile, root = join(getAgentDir(), "session-link", "immutable-records")) {
		const url = new URL(connection.origin);
		const local = !!connection.instanceId && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
		const namespace = local ? ["local-user", process.getuid?.(), getAgentDir()] :
			["remote", connection.origin, connection.certificate ?? "", connection.token];
		this.root = root;
		this.directory = join(root, digest(JSON.stringify(namespace)));
	}
	/** A hello/create-only broker never opens or scans transcript storage. */
	private database() {
		if (this.closed) throw Error("IMMUTABLE_CACHE_CLOSED");
		if (this.db) return this.db;
		prepareDirectory(this.root);
		prepareDirectory(this.directory);
		const path = join(this.directory, "records.sqlite");
		try { closeSync(openSync(path, "wx", 0o600)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		privatePath(path, false);
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			try { privatePath(path + suffix, false); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		const db = new DatabaseSync(path);
		try {
			// Match the Mac cache's contention budget; FULL durability is never relaxed.
			db.exec("PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON");
			const application = () => db.prepare("PRAGMA application_id").get()!.application_id;
			const version = () => db.prepare("PRAGMA user_version").get()!.user_version;
			if (application() === 0 && version() === 0 &&
				!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) {
				db.exec("BEGIN IMMEDIATE");
				try {
					// Another client may have initialized the database while we waited.
					if (application() === 0 && version() === 0 &&
						!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) {
						db.exec("CREATE TABLE records(key TEXT PRIMARY KEY, raw TEXT NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID; PRAGMA application_id=1346980164; PRAGMA user_version=1");
					} else if (application() !== 1346980164 || version() !== 1) throw Error("UNSUPPORTED_IMMUTABLE_CACHE");
					db.exec("COMMIT");
				} catch (error) { db.exec("ROLLBACK"); throw error; }
			} else if (application() !== 1346980164 || version() !== 1) throw Error("UNSUPPORTED_IMMUTABLE_CACHE");
			db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON");
			// Include newly created database/WAL directory entries before advertising.
			syncDirectory(this.directory);
			const keys = new Set<string>();
			for (const row of db.prepare("SELECT key,raw,digest FROM records").iterate()) {
				if (typeof row.key !== "string" || !keyPattern.test(row.key) || typeof row.raw !== "string" || digest(row.raw) !== row.digest) continue;
				try {
					const value = JSON.parse(row.raw);
					if (value && typeof value === "object" && !Array.isArray(value)) keys.add(row.key);
				} catch { /* Damaged individual records are not advertised. */ }
			}
			this.insert = db.prepare("INSERT OR REPLACE INTO records(key,raw,digest) VALUES(?,?,?)");
			this.keys = keys;
			this.select = db.prepare("SELECT raw,digest FROM records WHERE key=?");
			this.db = db;
			return db;
		} catch (error) { db.close(); throw error; }
	}
	inventory() { this.database(); return [...this.keys]; }
	close() {
		if (this.closed) return;
		this.closed = true;
		this.db?.close();
		this.db = undefined;
		this.insert = undefined;
		this.select = undefined;
		this.keys.clear();
	}
	/** Hydrate protocol containers only. A failure rolls back the whole received
	 * body; no new possession escapes through inventory or learned HTTP ACK keys. */
	hydrate(value: any, learned = new Set<string>()): Set<string> {
		if (this.closed) throw Error("IMMUTABLE_CACHE_CLOSED");
		const pending = new Map<string, string>(), received = new Set<string>();
		let writing = false;
		const put = (key: string, raw: string) => {
			if (!keyPattern.test(key) || typeof raw !== "string") throw Error("INVALID_IMMUTABLE_RECORD");
			const value = JSON.parse(raw);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("INVALID_IMMUTABLE_RECORD");
			const db = this.database();
			received.add(key);
			if (this.keys.has(key) || pending.has(key)) return;
			if (!writing) { db.exec("BEGIN IMMEDIATE"); writing = true; }
			this.insert!.run(key, raw, digest(raw));
			pending.set(key, raw);
		};
		const get = (key: string) => {
			this.database();
			const raw = pending.get(key);
			if (raw !== undefined) return JSON.parse(raw);
			const row = this.select!.get(key);
			if (typeof row?.raw === "string" && digest(row.raw) === row.digest) {
				try {
					const value = JSON.parse(row.raw);
					if (value && typeof value === "object" && !Array.isArray(value)) return value;
				} catch { /* No longer valid: retire this possession below. */ }
			}
			this.keys.delete(key);
			throw Error("IMMUTABLE_RECORD_MISSING; reconnect for verified inventory");
		};
		const visit = (value: any) => {
			if (!value || typeof value !== "object") return;
			if (value.immutable) {
				const cut = value.immutable;
				if (!Array.isArray(cut.entryKeys) || !Array.isArray(cut.missingKeys) ||
					!cut.entryKeys.every((key: unknown) => typeof key === "string" && keyPattern.test(key)) ||
					!Array.isArray(value.entries) || cut.missingKeys.length !== value.entries.length) throw Error("INVALID_IMMUTABLE_CUT");
				cut.missingKeys.forEach((key: string, index: number) => put(key, value.entries[index]));
				value.entries = cut.entryKeys.map(get);
				delete value.immutable;
			} else if (value.type === "snapshot" || (value.header && Array.isArray(value.entries))) throw Error("MISSING_IMMUTABLE_CUT");
			if (value.type === "append") {
				if (typeof value.entryKey !== "string" || !keyPattern.test(value.entryKey)) throw Error("MISSING_IMMUTABLE_KEY");
				if (value.entry !== undefined) put(value.entryKey, value.entry);
				value.entry = get(value.entryKey);
			}
			if (value.type === "childFrame") visit(value.event?.frame);
			if (value.snapshot) visit(value.snapshot);
			if (value.archive) visit(value.archive);
		};
		try {
			visit(value);
			if (writing) this.db!.exec("COMMIT");
		} catch (error) {
			if (writing) try { this.db!.exec("ROLLBACK"); } catch {}
			throw error;
		}
		for (const key of pending.keys()) this.keys.add(key);
		for (const key of received) learned.add(key);
		return learned;
	}
}
