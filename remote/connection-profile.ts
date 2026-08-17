import { X509Certificate, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, readdirSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export interface ConnectionProfile {
	version: 1;
	origin: string;
	certificate?: string;
	token: string;
	instanceId?: string;
}
export function validateProfile(value: unknown, local = false): ConnectionProfile {
	const p = value as ConnectionProfile;
	if (
		!p ||
		p.version !== 1 ||
		typeof p.token !== "string" ||
		!/^[A-Za-z0-9_+\/=.-]{32,}$/.test(p.token)
	)
		throw Error("INVALID_CONNECTION_PROFILE");
	const url = new URL(p.origin);
	if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
		throw Error("INVALID_CONNECTION_ORIGIN");
	if (local && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)) return p;
	if (url.protocol !== "https:" || typeof p.certificate !== "string")
		throw Error("HTTPS_PIN_REQUIRED");
	new X509Certificate(p.certificate);
	return p;
}
function path(name: string) {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw Error("INVALID_REMOTE_NAME");
	return join(getAgentDir(), "session-link", "connections", name + ".json");
}
function privatePath(path: string, directory: boolean) {
	const stat = lstatSync(path);
	if (
		stat.isSymbolicLink() ||
		(directory ? !stat.isDirectory() : !stat.isFile()) ||
		stat.uid !== process.getuid?.() ||
		stat.mode & 0o077
	)
		throw Error("UNSAFE_CONNECTION_STORAGE");
}
function prepareDirectory(destination: string) {
	const root = join(getAgentDir(), "session-link");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	privatePath(root, true);
	const directory = join(destination, "..");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	privatePath(directory, true);
}
/** Read names only: completion must never load tokens or create private storage. */
export function connectionNames(): string[] {
	const root = join(getAgentDir(), "session-link");
	const directory = join(root, "connections");
	try {
		privatePath(root, true); privatePath(directory, true);
		return readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && /^[A-Za-z0-9_-]{1,64}\.json$/.test(entry.name))
			.map((entry) => entry.name.slice(0, -5)).sort();
	} catch { return []; }
}
export function loadConnection(name: string): ConnectionProfile {
	const source = path(name);
	prepareDirectory(source);
	privatePath(source, false);
	return validateProfile(JSON.parse(readFileSync(source, "utf8")));
}
export function saveConnection(name: string, data: string) {
	let profile: ConnectionProfile;
	try {
		// Terminal/manual sharing may wrap the opaque base64 payload.
		if (data.length > 131072) throw Error();
		data = data.replace(/\s/g, "");
		if (data.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw Error();
		profile = validateProfile(JSON.parse(Buffer.from(data, "base64").toString("utf8")));
	} catch {
		throw Error("INVALID_CONNECTION_DATA");
	}
	const destination = path(name);
	prepareDirectory(destination);
	const temporary = destination + "." + randomUUID() + ".tmp";
	writeFileSync(temporary, JSON.stringify(profile), { mode: 0o600, flag: "wx" });
	renameSync(temporary, destination);
}
export function deleteConnection(name: string) {
	const source = path(name);
	prepareDirectory(source);
	unlinkSync(source);
}
