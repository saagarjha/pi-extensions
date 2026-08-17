import {
	loadConnection,
	connectionNames,
	saveConnection,
	deleteConnection,
	type ConnectionProfile,
} from "./connection-profile.ts";
import { ensureDaemon } from "./startup-policy.ts";
import { discoverDaemon } from "./daemon-discovery.ts";
import type { LaunchProfile } from "./daemon-protocol.ts";

export interface ManagementHost {
	localProfile: LaunchProfile;
	showStatus(message: string): void;
	confirm(title: string, message: string): Promise<boolean>;
	connect(
		connection: ConnectionProfile,
		localProfile?: LaunchProfile,
		name?: string,
	): Promise<void>;
}
function localConnection(daemon: Awaited<ReturnType<typeof discoverDaemon>>): ConnectionProfile {
	return { version: 1, origin: daemon.origin, token: daemon.token, instanceId: daemon.instanceId };
}
function selectedSessionUnavailable(error: unknown) {
	return (
		error instanceof Error &&
		["UNKNOWN_NATIVE_SESSION", "STOPPED_SESSION_NOT_PERSISTED"].includes(error.message)
	);
}
async function connectLocal(host: ManagementHost) {
	host.showStatus("Connecting to local daemon…");
	try {
		const daemon = await discoverDaemon();
		await host.connect(localConnection(daemon), host.localProfile, "local");
		host.showStatus("Connected to local daemon.");
	} catch (error) {
		host.showStatus(
			selectedSessionUnavailable(error)
				? "Local daemon is running, but the selected session is unavailable or was not saved. No replacement session was created; the current view and draft were retained."
				: "Cannot connect to a running local daemon. Check local daemon state, or run /daemon start then /daemon connect. No daemon was started by this command.",
		);
	}
}
/** Only local management state belongs here, even while attached to a remote server. */
export async function managementCompletions(command: string, prefix: string) {
	const tokens = prefix.trimStart().split(/\s+/);
	const query = tokens.pop() ?? "";
	const before = tokens.length ? tokens.join(" ") + " " : "";
	let values: string[] = [];
	if (command === "daemon" && !tokens.length) values = ["start", "stop", "restart", "connect"];
	if (command === "remote") {
		if (!tokens.length) values = ["setup", "add", "delete", "client", "connect"];
		else if (tokens.length === 1 && ["add", "delete"].includes(tokens[0]!)) values = ["client"];
		else if (tokens.length === 1 && tokens[0] === "client") values = ["add", "delete"];
		else if (tokens.length === 1 && tokens[0] === "connect") values = ["local", ...connectionNames().filter((name) => name !== "local")];
		else if (tokens.join(" ") === "client delete") values = connectionNames();
		else if (tokens.join(" ") === "delete client") values = await (await import("./daemon-management.ts")).remoteClientNames();
	}
	return values.filter((value) => value.startsWith(query)).map((value) => ({ value: before + value, label: value }));
}
export function isManagementCommand(text: string) {
	return /^\/(?:daemon|remote)(?:\s|$)/.test(text.trim());
}
/** Never use the selected session transport for management. */
export async function runManagement(text: string, host: ManagementHost) {
	const [command, ...args] = text.trim().split(/\s+/);
	if (command === "/daemon") {
		if (args.length !== 1 || !["start", "stop", "restart", "connect"].includes(args[0]!))
			throw Error("Usage: /daemon start|stop|restart|connect (local only)");
		if (args[0] === "connect") {
			await connectLocal(host);
			return;
		}
		if (args[0] === "start") {
			host.showStatus("Starting local daemon…");
			try {
				await ensureDaemon(host.localProfile);
			} catch {
				host.showStatus(
					"Could not start local daemon. Check local configuration and CLI installation, then retry /daemon start.",
				);
				return;
			}
		} else {
			// Always warn: the local daemon may own active work even when this TUI
			// currently watches a different remote host. Never query that remote.
			if (
				!(await host.confirm(
					args[0] === "restart" ? "Restart local daemon?" : "Stop local daemon?",
					"This stops all locally daemon-owned sessions, including active tools and pending work. Only this machine’s daemon is stopped; this TUI stays open.",
				))
			)
				return;
			if (args[0] === "restart") {
				let stage = "waiting for the old local daemon and its workers to stop";
				host.showStatus("Restarting local daemon: waiting for shutdown…");
				try {
					await (await import("./daemon-management.ts")).stopDaemonAndWait();
					stage = "starting the local daemon";
					host.showStatus("Starting local daemon…");
					const daemon = await ensureDaemon(host.localProfile);
					stage = "connecting to the restarted local daemon";
					host.showStatus("Connecting to restarted local daemon…");
					await host.connect(localConnection(daemon), host.localProfile, "local");
					host.showStatus("Connected to restarted local daemon.");
				} catch (error) {
					const reason =
						error instanceof Error && error.message === "LOCAL_DAEMON_SHUTDOWN_INCOMPLETE"
							? " Old daemon or workers still hold the singleton after 15 seconds; no replacement was started. Wait for shutdown to complete before retrying."
							: selectedSessionUnavailable(error)
								? " The daemon is running, but the selected session is unavailable or was not saved. No replacement session was created; the current view and draft were retained."
								: " Check local daemon configuration and remaining work before retrying; /daemon start then /daemon connect can recover a stopped server.";
					host.showStatus(`Restart failed while ${stage}.${reason}`);
				}
				return;
			}
			host.showStatus("Stopping local daemon…");
			try {
				await (await import("./daemon-management.ts")).stopDaemonAndWait();
			} catch (error) {
				host.showStatus(
					error instanceof Error && error.message === "LOCAL_DAEMON_SHUTDOWN_INCOMPLETE"
						? "Local daemon shutdown is incomplete: the old daemon or workers still hold the singleton after 15 seconds. Wait for shutdown to finish before retrying /daemon stop or /daemon start."
						: "Could not stop local daemon. Check whether a local daemon is running before retrying /daemon stop.",
				);
				return;
			}
		}
		host.showStatus(`Local daemon ${args[0] === "start" ? "running" : "stopped"}.`);
		return;
	}
	if (command !== "/remote") throw Error("UNKNOWN_MANAGEMENT_COMMAND");
	if (args[0] === "client" && args[1] === "add" && args.length >= 4) {
		if (args[2] === "local") throw Error("LOCAL_IS_RESERVED_FOR_DISCOVERY");
		saveConnection(args[2]!, args.slice(3).join(""));
		host.showStatus("Connection saved locally.");
		return;
	}
	if (args[0] === "client" && args[1] === "delete" && args.length === 3) {
		deleteConnection(args[2]!);
		host.showStatus("Connection forgotten locally.");
		return;
	}
	if (args[0] === "connect" && args.length === 2) {
		if (args[1] === "local") await connectLocal(host);
		else {
			host.showStatus("Connecting to saved session server…");
			try {
				await host.connect(loadConnection(args[1]!), undefined, args[1]!);
				host.showStatus("Connected to saved session server.");
			} catch {
				host.showStatus(
					"Connection failed. Check the saved connection and session server, then retry /remote connect. Current connection state is shown in the status view.",
				);
			}
		}
		return;
	}
	if (args[0] === "setup" && args.length === 5) {
		const port = Number(args[4]);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("INVALID_RELAY_PORT");
		const result = await (
			await import("./daemon-management.ts")
		).setupRemote(args[1]!, args[2]!, args[3]!, port);
		host.showStatus(
			result.restartRequired
				? "Configuration saved. Apply with /daemon restart when safe; active work was not interrupted."
				: "Local remote-server configuration saved and certificate ready.",
		);
		return;
	}
	if (args[0] === "add" && args[1] === "client" && args.length === 3) {
		const exported = await (await import("./daemon-management.ts")).addRemoteClient(args[2]!);
		host.showStatus(`Secret connection data (share privately):\n${exported}`);
		return;
	}
	if (args[0] === "delete" && args[1] === "client" && args.length === 3) {
		await (await import("./daemon-management.ts")).deleteRemoteClient(args[2]!);
		host.showStatus("Client revoked on local server.");
		return;
	}
	throw Error(
		"Usage: /remote setup SSH_DEST BASE_DOMAIN HOST_LABEL RELAY_PORT | add client NAME | delete client NAME | client add REMOTE_NAME CONNECTION_DATA | client delete REMOTE_NAME | connect local|REMOTE_NAME",
	);
}
