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
import { WORKER_STARTUP_ERROR_CODE } from "./worker-startup.ts";

const DAEMON_USAGE = "Usage: /daemon start|stop|restart|connect (local only)";
const REMOTE_USAGE = "Usage: /remote setup SSH_DEST BASE_DOMAIN HOST_LABEL RELAY_PORT | add client NAME | delete client NAME | client add REMOTE_NAME CONNECTION_DATA | client delete REMOTE_NAME | connect local|REMOTE_NAME";

function workerStartupFailure(error: unknown): string | undefined {
	if (!(error instanceof Error) || !("code" in error) || error.code !== WORKER_STARTUP_ERROR_CODE)
		return undefined;
	return error.message;
}
function workerStartupDetail(error: unknown): string {
	const detail = workerStartupFailure(error);
	return detail ? `\n${detail}` : "";
}
export function managementErrorMessage(error: unknown): string {
	// Startup errors carry useful scoped diagnostics. Other commands may handle
	// connection credentials, so do not display arbitrary exception payloads.
	const message = error instanceof Error ? error.message : undefined;
	if (message === DAEMON_USAGE || message === REMOTE_USAGE) return message;
	return workerStartupFailure(error) ?? "Couldn’t complete this command. Check its arguments and local configuration.";
}

export interface ManagementHost {
	localProfile: LaunchProfile;
	showStatus(message: string): void;
	showError(message: string): void;
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
		host.showError(
			selectedSessionUnavailable(error)
				? "The selected session is unavailable. Choose another session."
				: "Couldn’t connect to local Pi. Check that it is running, or use /daemon start then /daemon connect." + workerStartupDetail(error),
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
			throw Error(DAEMON_USAGE);
		if (args[0] === "connect") {
			await connectLocal(host);
			return;
		}
		if (args[0] === "start") {
			host.showStatus("Starting local daemon…");
			try {
				await ensureDaemon(host.localProfile);
			} catch (error) {
				host.showError(
					"Couldn’t start local Pi. Check its installation and local configuration." + workerStartupDetail(error),
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
				let stage = "waiting for shutdown";
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
							? " Pi is still shutting down. Wait before starting it again."
							: selectedSessionUnavailable(error)
								? " The selected session is unavailable. Choose another session."
								: " Check local Pi’s state and configuration before trying again.";
					host.showError(`Couldn’t restart local Pi while ${stage}.${reason}${workerStartupDetail(error)}`);
				}
				return;
			}
			host.showStatus("Stopping local daemon…");
			try {
				await (await import("./daemon-management.ts")).stopDaemonAndWait();
			} catch (error) {
				host.showError(
					error instanceof Error && error.message === "LOCAL_DAEMON_SHUTDOWN_INCOMPLETE"
						? "Pi is still shutting down. Wait before starting it again."
						: "Couldn’t stop local Pi. Check that it is running before trying again.",
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
			} catch (error) {
				host.showError(
					"Couldn’t connect to this server. Check the saved connection and server, then try /remote connect again." + workerStartupDetail(error),
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
	throw Error(REMOTE_USAGE);
}
