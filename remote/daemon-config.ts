import { randomBytes, createHash, X509Certificate } from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	renameSync,
	lstatSync,
	existsSync,
	chmodSync,
	unlinkSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { privateDirectory } from "./daemon-discovery.ts";

export interface RemoteConfig {
	stateDir: string;
	sshDestination: string;
	baseDomain: string;
	hostLabel: string;
	relayPort: number;
	/** Local TLS port; zero selects an ephemeral port. */
	listenPort: number;
	origin: string;
}
export function readRemoteConfig(path: string): RemoteConfig {
	if (!isAbsolute(path)) throw new Error("ABSOLUTE_CONFIG_PATH_REQUIRED");
	const c = JSON.parse(readFileSync(path, "utf8"));
	if (
		!c ||
		typeof c !== "object" ||
		Array.isArray(c) ||
		Object.keys(c).some(
			(k) =>
				![
					"stateDir",
					"sshDestination",
					"baseDomain",
					"hostLabel",
					"relayPort",
					"listenPort",
				].includes(k),
		)
	)
		throw new Error("INVALID_REMOTE_CONFIG");
	if (
		typeof c.stateDir !== "string" ||
		!isAbsolute(c.stateDir) ||
		typeof c.sshDestination !== "string" ||
		!/^[a-zA-Z0-9_.@:\[\]-]+$/.test(c.sshDestination) ||
		c.sshDestination.startsWith("-") ||
		typeof c.baseDomain !== "string" ||
		!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(c.baseDomain) ||
		typeof c.hostLabel !== "string" ||
		!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(c.hostLabel)
	)
		throw new Error("INVALID_REMOTE_CONFIG");
	const port = (p: unknown, min: number) =>
		typeof p === "number" && Number.isInteger(p) && p >= min && p <= 65535;
	if (!port(c.relayPort, 1) || !port(c.listenPort ?? 0, 0)) throw new Error("INVALID_REMOTE_PORT");
	return { ...c, listenPort: c.listenPort ?? 0, origin: `https://${c.hostLabel}.${c.baseDomain}` };
}
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export interface StoredCredential {
	clientId: string;
	hash: string;
	label: string;
}
export class RemoteCredentials {
	readonly cert: string;
	readonly key: string;
	readonly credentials = new Map<string, StoredCredential>();
	private file: string;
	constructor(readonly config: RemoteConfig) {
		privateDirectory(config.stateDir);
		const certFile = join(config.stateDir, "certificate.pem"),
			keyFile = join(config.stateDir, "private-key.pem");
		if (!existsSync(certFile) && !existsSync(keyFile)) {
			const requestConfig = join(config.stateDir, "certificate-request-" + newToken() + ".cnf");
			writeFileSync(
				requestConfig,
				`[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=DNS:${config.hostLabel}.${config.baseDomain}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\nbasicConstraints=critical,CA:FALSE\n`,
				{ mode: 0o600, flag: "wx" },
			);
			try {
				const result = spawnSync(
					"openssl",
					[
						"req",
						"-x509",
						"-newkey",
						"rsa:3072",
						"-sha256",
						"-nodes",
						"-days",
						"3650",
						"-subj",
						`/CN=${config.hostLabel}.${config.baseDomain}`,
						"-config",
						requestConfig,
						"-extensions",
						"v3",
						"-keyout",
						keyFile,
						"-out",
						certFile,
					],
					{ encoding: "utf8" },
				);
				if (result.status !== 0) throw new Error("CERTIFICATE_GENERATION_FAILED");
			} catch (error) {
				// Both files were absent before this attempt. Never rotate or remove an
				// existing identity (including a preexisting incomplete pair).
				for (const file of [keyFile, certFile]) {
					try {
						unlinkSync(file);
					} catch (cleanupError) {
						if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
					}
				}
				throw error;
			} finally {
				unlinkSync(requestConfig);
			}
			// Parent directory is already private; ensure persisted files are private too.
			for (const file of [keyFile, certFile]) {
				chmodSync(file, 0o600);
			}
		}
		const read = (path: string) => {
			const st = lstatSync(path);
			if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.mode & 0o077)
				throw new Error("UNSAFE_REMOTE_STATE_FILE");
			return readFileSync(path, "utf8");
		};
		const certStat = lstatSync(certFile);
		if (!certStat.isFile() || certStat.isSymbolicLink() || certStat.uid !== process.getuid?.())
			throw new Error("UNSAFE_REMOTE_CERTIFICATE");
		this.cert = readFileSync(certFile, "utf8");
		this.key = read(keyFile);
		if (
			!new X509Certificate(this.cert).checkHost(`${config.hostLabel}.${config.baseDomain}`, {
				wildcards: false,
			})
		)
			throw new Error("CERTIFICATE_HOSTNAME_MISMATCH_USE_NEW_STATE_DIRECTORY");
		this.file = join(config.stateDir, "clients.json");
		if (existsSync(this.file))
			for (const item of JSON.parse(read(this.file))) {
				if (
					!item ||
					typeof item.clientId !== "string" ||
					typeof item.label !== "string" ||
					!/^[a-f0-9]{64}$/.test(item.hash)
				)
					throw new Error("INVALID_CREDENTIAL_STORE");
				this.credentials.set(item.hash, item);
			}
	}
	save() {
		const temporary = this.file + "." + newToken();
		writeFileSync(temporary, JSON.stringify([...this.credentials.values()]), {
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, this.file);
	}
}
