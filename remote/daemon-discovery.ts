import net from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { mkdirSync, lstatSync } from "node:fs";
import type { DaemonDescriptor } from "./daemon-protocol.ts";

export function daemonPaths() {
	const uid = userInfo().uid;
	// Fixed per-user OS runtime location, independent of client env/profile. No regular files.
	const directory = `/tmp/pi-session-link-${uid}`;
	return {
		directory,
		socketPath: join(directory, "daemon.sock"),
		uid,
		port: 49152 + ((uid + 7219) % 16384),
	};
}
export function privateDirectory(directory: string) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stat = lstatSync(directory);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.uid !== userInfo().uid ||
		(stat.mode & 0o777) !== 0o700
	)
		throw new Error("UNSAFE_DAEMON_DIRECTORY: " + directory);
}
/** Filesystem ownership is the bootstrap authority; secrets exist only in RPC memory. */
export async function discoverDaemon(): Promise<DaemonDescriptor> {
	const paths = daemonPaths();
	privateDirectory(paths.directory);
	const stat = lstatSync(paths.socketPath);
	if (!stat.isSocket() || stat.uid !== paths.uid || (stat.mode & 0o777) !== 0o600)
		throw new Error("UNSAFE_DAEMON_SOCKET");
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(paths.socketPath);
		const timer = setTimeout(() => finish(new Error("DAEMON_DISCOVERY_TIMEOUT")), 3000);
		let buffer = "",
			settled = false;
		function finish(error?: Error, descriptor?: DaemonDescriptor) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(descriptor!);
		}
		socket.setEncoding("utf8");
		socket.on("error", finish);
		socket.on("close", () => finish(new Error("DAEMON_DISCOVERY_DISCONNECTED")));
		socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method: "discover" }) + "\n"));
		socket.on("data", (data: string) => {
			buffer += data;
			if (buffer.length > 65536) return finish(new Error("INVALID_DAEMON_REPLY"));
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			try {
				const reply = JSON.parse(buffer.slice(0, end));
				if (reply.replyTo === 1 && reply.error === "DAEMON_STOPPING") throw Error("DAEMON_STOPPING");
				const d = reply.result as DaemonDescriptor;
				if (
					reply.replyTo !== 1 ||
					reply.error ||
					d?.protocol !== 1 ||
					d.uid !== paths.uid ||
					d.socketPath !== paths.socketPath ||
					!d.token ||
					typeof d.origin !== "string" ||
					!/^http:\/\/127\.0\.0\.1:\d+$/.test(d.origin) ||
					!d.instanceId ||
					!Number.isSafeInteger(d.pid)
				)
					throw new Error("INVALID_DAEMON_DESCRIPTOR");
				finish(undefined, d);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}
