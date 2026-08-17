import net from "node:net";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { existsSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { daemonPaths, discoverDaemon, privateDirectory } from "./daemon-discovery.ts";
import type { DaemonDescriptor } from "./daemon-protocol.ts";
import { readRemoteConfig, RemoteCredentials } from "./daemon-config.ts";
import { LineFramer } from "./line-framer.ts";

export const remoteConfigPath = () => join(getAgentDir(), "session-link", "remote-config.json");
/** Private Unix filesystem authority, never the selected HTTP conversation server. */
async function localRPC<Result>(
	method: string,
	params: Record<string, unknown> = {},
	expected?: DaemonDescriptor,
): Promise<Result> {
	const descriptor = expected ?? (await discoverDaemon());
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(descriptor.socketPath),
			framer = new LineFramer();
		let settled = false;
		const timer = setTimeout(() => finish(Error("LOCAL_MANAGEMENT_TIMEOUT")), 10000);
		function finish(error?: Error, result?: Result) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(result!);
		}
		socket.setEncoding("utf8");
		const send = () => socket.write(JSON.stringify({ id: 1, method, params }) + "\n");
		socket.once("connect", () => {
			if (expected) socket.write(JSON.stringify({ id: 0, method: "discover" }) + "\n");
			else send();
		});
		socket.on("data", (chunk) => {
			try {
				for (const line of framer.push(String(chunk))) {
					const reply = JSON.parse(line);
					if (expected && reply.replyTo === 0) {
						if (reply.error || reply.result?.instanceId !== expected.instanceId)
							return finish(Error("LOCAL_DAEMON_CHANGED"));
						send();
						continue;
					}
					if (reply.replyTo !== 1) continue;
					if (reply.error) finish(Error(String(reply.code ?? reply.error)));
					else finish(undefined, reply.result);
				}
			} catch {
				finish(Error("INVALID_LOCAL_MANAGEMENT_REPLY"));
			}
		});
		socket.once("error", () => finish(Error("LOCAL_MANAGEMENT_UNAVAILABLE")));
		socket.once("close", () => finish(Error("LOCAL_MANAGEMENT_DISCONNECTED")));
	});
}
export async function setupRemote(
	sshDestination: string,
	baseDomain: string,
	hostLabel: string,
	relayPort: number,
): Promise<{ restartRequired: boolean }> {
	const path = remoteConfigPath(),
		root = join(path, "..");
	privateDirectory(root);
	const config = {
		stateDir: join(root, "remote-server"),
		sshDestination,
		baseDomain,
		hostLabel,
		relayPort,
		listenPort: 0,
	};
	// Validate before changing the active configuration or certificate.
	const temporary = path + "." + randomUUID();
	writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: "wx" });
	try {
		const validated = readRemoteConfig(temporary);
		if (existsSync(path)) {
			const previous = readRemoteConfig(path);
			if (previous.origin !== validated.origin)
				throw Error("REMOTE_HOST_CHANGE_REQUIRES_EXPLICIT_CERTIFICATE_MIGRATION");
		}
		new RemoteCredentials(validated);
		renameSync(temporary, path);
	} finally {
		try {
			unlinkSync(temporary);
		} catch {}
	}
	// Setup is valid while stopped. Never silently restart an active conversation host.
	try {
		await discoverDaemon();
	} catch {
		return { restartRequired: false };
	}
	try {
		const result = await localRPC<{ configured?: boolean; restartRequired?: boolean }>(
			"configureRemote",
			{ configPath: path },
		);
		return { restartRequired: result.restartRequired === true || result.configured !== true };
	} catch {
		return { restartRequired: true };
	}
}
export async function addRemoteClient(name: string): Promise<string> {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw Error("INVALID_CLIENT_NAME");
	const clients = await localRPC<Array<{ clientId: string; label: string }>>("listCredentials");
	if (clients.some((client) => client.label === name)) throw Error("CLIENT_NAME_ALREADY_EXISTS");
	return (await localRPC<{ bundle: string }>("exportCredential", { label: name })).bundle;
}
/** Read labels only from the local daemon; never start it or export credentials. */
export async function remoteClientNames(): Promise<string[]> {
	try {
		// Discovery normally prepares its runtime directory. Do not even attempt it
		// for completion when no local socket already exists.
		if (!existsSync(daemonPaths().socketPath)) return [];
		const clients = await localRPC<Array<{ clientId: string; label: string }>>("listCredentials");
		return clients.map((client) => client.label).filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name)).sort();
	} catch { return []; }
}
export async function deleteRemoteClient(name: string) {
	const clients = await localRPC<Array<{ clientId: string; label: string }>>("listCredentials");
	const matches = clients.filter((client) => client.label === name);
	if (matches.length !== 1) throw Error("CLIENT_NAME_NOT_UNIQUE_OR_UNKNOWN");
	await localRPC("revokeCredential", { clientId: matches[0]!.clientId });
}
export async function stopDaemon() {
	await localRPC("stop");
}

/** Discovery may disappear before workers release their inherited singleton FD. */
export async function singletonReleased(): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE") resolve(false);
			else reject(Error("LOCAL_DAEMON_SHUTDOWN_CHECK_FAILED"));
		});
		probe.listen({ host: "127.0.0.1", port: daemonPaths().port, exclusive: true }, () =>
			probe.close(() => resolve(true)),
		);
	});
}

export async function stopDaemonAndWait(): Promise<void> {
	let previous: DaemonDescriptor | undefined;
	try {
		previous = await discoverDaemon();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ECONNREFUSED" && (error as Error).message !== "DAEMON_STOPPING") throw error;
		// Already stopped is valid, but a surviving worker may still hold the guard.
	}
	// Verify on the SAME socket used for stop: a replacement must not be stopped.
	if (previous) await localRPC("stop", {}, previous);
	const deadline = Date.now() + 15000;
	do {
		let current: DaemonDescriptor | undefined;
		try {
			current = await discoverDaemon();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ECONNREFUSED") {
				// A stopping daemon and a closing connection are inconclusive.
				if (code !== "ECONNRESET" && code !== "EPIPE" && !["DAEMON_DISCOVERY_DISCONNECTED", "DAEMON_STOPPING"].includes((error as Error).message))
					throw error;
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
				continue;
			}
		}
		if (current && !previous) throw Error("LOCAL_DAEMON_CHANGED");
		if (current && previous && current.instanceId !== previous.instanceId) return;
		if (!current && (await singletonReleased())) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw Error("LOCAL_DAEMON_SHUTDOWN_INCOMPLETE");
}
