import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
	AgentSession,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	registerSessionBindingHook,
	registerSessionBoundHook,
} from "../shared/session-continuation.ts";

type Bindings = Parameters<AgentSession["bindExtensions"]>[0];

/** Accept normal installed CLI symlinks, but never an SDK host or an argv decoy. */
export function resolveNativeCLIPath(): string {
	const entry = process.argv[1];
	try {
		if (entry) {
			const actual = realpathSync(entry);
			// Identify the installation that owns argv[1], not the extension's SDK
			// dependency: bunx/global Pi may differ from local node_modules.
			for (const relativeEntry of ["dist/bundle/cli.js", "dist/cli.js"]) {
				try {
					const root = resolve(dirname(actual), relativeEntry === "dist/cli.js" ? ".." : "../..");
					const manifest: unknown = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
					if (
						!manifest ||
						typeof manifest !== "object" ||
						!("name" in manifest) ||
						manifest.name !== "@earendil-works/pi-coding-agent"
					)
						continue;
					if (actual === realpathSync(resolve(root, relativeEntry))) return actual;
				} catch {
					// Not this installed CLI layout; try the other supported layout.
				}
			}
		}
	} catch {
		// A missing or unresolvable entry is not the installed normal CLI.
	}
	throw new Error("SESSION_LINK_REQUIRES_NORMAL_PI_CLI: no standalone SDK root hosts.");
}

/** Configure presentation before the normal CLI emits session_start. The existing
 * shared bridge remains the only session capture mechanism. Handler identity
 * associates a factory with its exact loader, including aliases and replacements.
 */
export function registerNativeBinding(
	pi: ExtensionAPI,
	marker: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>,
	bind: (session: AgentSession, bindings: Bindings, socketPath: string) => Bindings,
	ready: (session: AgentSession) => void | Promise<void>,
): () => void {
	const offBound = registerSessionBoundHook((session) => {
		if (
			session.extensionRunner.getRegisteredCommands().some((command) => command.handler === marker)
		)
			return ready(session);
	});
	const offBinding = registerSessionBindingHook((session, bindings) => {
		if (
			!session.extensionRunner.getRegisteredCommands().some((command) => command.handler === marker)
		)
			return;
		// Only this loader's parsed CLI flag activates serving. An inherited process
		// environment must not accidentally turn ordinary SDK subagents into roots.
		const socketPath = pi.getFlag("session-link-socket");
		if (!socketPath) return;
		if (typeof socketPath !== "string") throw new Error("SESSION_LINK_SOCKET_MUST_BE_STRING");
		const manager = session.sessionManager as unknown as {
			_appendEntry?: unknown;
		};
		if (
			typeof manager._appendEntry !== "function" ||
			typeof session.sessionManager.branch !== "function" ||
			typeof session.sessionManager.resetLeaf !== "function"
		) {
			throw new Error(
				"SESSION_LINK_UNSUPPORTED_SDK: native observation/binding hooks unavailable.",
			);
		}
		if (bindings.mode !== "rpc") {
			throw new Error(
				"SESSION_LINK_REQUIRES_RPC_CLI: interactive serving is not fenced and is rejected.",
			);
		}
		resolveNativeCLIPath();
		// stdin belongs exclusively to process supervision, never a second user UI.
		return bind(session, bindings, socketPath);
	});
	return () => {
		offBinding();
		offBound();
	};
}
