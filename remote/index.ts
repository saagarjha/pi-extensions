import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSessionBridge } from "../shared/session-continuation.ts";
import { registerNativeBinding } from "./native-binding.ts";
import { createLinkedOwner } from "./owner.ts";
import { installClientModeHooks, registerClientCommands } from "./client-mode.ts";
import {
	classifyStartup,
	ensureDaemon,
	getLaunchProfile,
	installDefaultClientStartup,
} from "./startup-policy.ts";
import { connect } from "./transport-client.ts";
import type { SessionDescription } from "./protocol.ts";
import { discoverDaemon } from "./daemon-discovery.ts";

let directWarningShown = false;

/** Loaded by unmodified Pi's extension loader. Clients retire a transient native
 * executor; only daemon-managed normal RPC CLI workers remain live owners.
 */
export default async function remote(pi: ExtensionAPI): Promise<void> {
	pi.registerFlag("daemon", {
		type: "boolean",
		description:
			"Run the per-user session broker (no Agent); rejects session selectors and prompts.",
	});
	pi.registerFlag("direct", {
		type: "boolean",
		description: "Explicit local owner bypass: no daemon routing, startup, quiescing, or fallback.",
	});
	pi.registerFlag("session-link-worker", {
		type: "string",
		description: "Internal daemon worker authentication token; requires RPC mode and owner socket.",
	});
	let policy;
	try {
		policy = classifyStartup();
	} catch (error) {
		console.error(
			`SESSION_LINK_STARTUP_REJECTED: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
	if (policy === "daemon") {
		const alreadyRunning = async () => {
			try {
				const existing = await discoverDaemon();
				console.error(`Session daemon already running (PID ${existing.pid}).`);
				return true;
			} catch {
				// Only authenticated discovery establishes an existing daemon.
				return false;
			}
		};
		if (await alreadyRunning()) process.exit(0);
		// main already selected a SessionManager before loading extensions, but its
		// awaited factory has not constructed Agent or AgentSession. Never return
		// to that startup after broker shutdown or a broker error.
		try {
			const { serveDaemon } = await import("./daemon.ts");
			await serveDaemon();
			process.exit(0);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.startsWith("DAEMON_SINGLETON_UNAVAILABLE:")) {
				// Another launch may have won the singleton before publishing its
				// descriptor. Never identify an unrelated port occupant as Pi.
				const deadline = Date.now() + 5_000;
				do {
					if (await alreadyRunning()) process.exit(0);
					await new Promise<void>((resolve) => setTimeout(resolve, 100));
				} while (Date.now() < deadline);
			}
			console.error(`SESSION_LINK_DAEMON_FAILED: ${message}`);
			// EX_TEMPFAIL distinguishes a lost singleton race from fatal startup errors.
			process.exit(message.startsWith("DAEMON_SINGLETON_UNAVAILABLE:") ? 75 : 1);
		}
	}
	const supervisionKey = Symbol.for("pi.session-link.worker-supervision.v1");
	if (policy === "worker" && !Reflect.get(globalThis, supervisionKey)) {
		// fd3 deliberately remains an unwrapped inherited listening socket until actual exit.
		const { fstatSync } = await import("node:fs");
		if (process.env.PI_SESSION_LINK_GUARD_FD !== "3" || !fstatSync(3).isSocket())
			throw new Error("WORKER_SINGLETON_GUARD_REQUIRED");
		Reflect.set(globalThis, supervisionKey, true);
		process.stdin.once("end", () => process.exit(1));
		process.stdin.once("error", () => process.exit(1));
		process.stdin.resume();
	}
	if (policy === "direct" && !directWarningShown) {
		directWarningShown = true;
		console.error(
			"Warning: --direct starts a local owner outside daemon coordination. No daemon routing, auto-start, or quiescing is performed; avoid concurrently opening the same history.",
		);
	}
	if (policy === "direct" || policy === "client") {
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.hasUI)
				ctx.ui.setStatus(
					"remote.connection",
					policy === "direct"
						? ctx.ui.theme.bold(ctx.ui.theme.fg("accent", "direct"))
						: ctx.ui.theme.italic("disconnected"),
				);
		});
	}
	const sessions = installSessionBridge();
	let owner: ReturnType<typeof createLinkedOwner> | undefined;
	installClientModeHooks();
	const clientCommands = registerClientCommands(pi, {
		getLocalOwnerState: () => ({ serving: !!owner }),
	});
	pi.registerFlag("session-link-socket", {
		type: "string",
		description:
			"Serve the actual normal RPC CLI session over a private Unix socket; stdin is supervision-only.",
	});
	if (policy === "client") {
		installDefaultClientStartup(clientCommands.marker, async (mode) => {
			mode.showStatus("Connecting to local session server…");
			const profile = getLaunchProfile(mode);
			const daemon = await ensureDaemon(profile);
			const connection = {
				version: 1 as const,
				origin: daemon.origin,
				token: daemon.token,
				instanceId: daemon.instanceId,
			};
			const broker = await connect({ connection });
			try {
				// Bare Pi still creates a new conversation. Existing sessions are
				// selected later through the connected native /resume UI.
				const created = await broker.request<SessionDescription>("create", { profile });
				await clientCommands.attach(mode, {
					profile,
					connection,
					connectionName: "local",
					sessionId: created.sessionId,
					takeover: true,
				});
			} finally {
				broker.close();
			}
		});
	}
	const unbind = registerNativeBinding(
		pi,
		clientCommands.marker,
		(session, bindings, socketPath) => {
			if (owner && owner.session !== session) throw new Error("SESSION_LINK_OWNER_ALREADY_BOUND");
			const token = pi.getFlag("session-link-worker");
			if (typeof token !== "string" || !token)
				throw new Error("SESSION_LINK_WORKER_TOKEN_REQUIRED");
			owner ??= createLinkedOwner(pi, session, socketPath, bindings.uiContext, {
				workerToken: token,
			});
			return owner.bind(bindings);
		},
		async (session) => {
			if (owner?.session === session) await owner.start();
		},
	);
	pi.on("session_start", async (_event, ctx) => {
		if (!owner) return;
		if (sessions.get(ctx.sessionManager) !== owner.session)
			throw new Error("SESSION_LINK_NATIVE_IDENTITY_MISMATCH");
		// Listener opens in the shared after-bind hook, after ALL startup owners exist.
	});
	pi.on("session_shutdown", async () => {
		unbind();
		await owner?.close();
		owner = undefined;
	});
}
