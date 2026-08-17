import { sessionHome } from "../shared/session-home.ts";
import { InteractiveMode, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { NativeMode } from "./client-mode.ts";
import { resolveNativeCLIPath } from "./native-binding.ts";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { remoteConfigPath, singletonReleased } from "./daemon-management.ts";
import { fileURLToPath } from "node:url";
import { discoverDaemon } from "./daemon-discovery.ts";
import type { DaemonDescriptor, LaunchProfile } from "./daemon-protocol.ts";

export type StartupPolicy = "other-host" | "metadata" | "direct" | "daemon" | "worker" | "client";
type Marker = (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
type StartupMode = NativeMode & { init(): Promise<void>; stop(): void };
export interface StartupInputGate {
	/** Only use for a focused native selector, never while awaiting network I/O. */
	withSelectionInput<T>(select: () => Promise<T>): Promise<T>;
}
type Attach = (mode: NativeMode, gate: StartupInputGate) => Promise<void>;

const legacySelectors = new Set([
	"--session",
	"--session-id",
	"--session-dir",
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--fork",
	"--no-session",
	"--name",
	"-n",
]);
const valueFlags = new Set([
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--use-theme",
	"--provider",
	"--model",
	"--thinking",
	"--models",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--system-prompt",
	"--append-system-prompt",
	"--api-key",
	"--tui",
]);
const booleanFlags = new Set([
	"--no-extensions",
	"-ne",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--no-tools",
	"-nt",
	"--no-builtin-tools",
	"-nbt",
	"--verbose",
	"--offline",
]);

/** CLI parsing has already happened, but pi.getFlag is populated only AFTER factories.
 * This intentionally conservative raw parser does not reinterpret legacy selectors.
 * Native session selection/file access may already have occurred before this check.
 */
export function classifyStartup(args = process.argv.slice(2)): StartupPolicy {
	try {
		resolveNativeCLIPath();
	} catch {
		return "other-host";
	}
	const policyValueFlags = new Set([
		...valueFlags,
		"--mode",
		"--session",
		"--session-id",
		"--session-dir",
		"--fork",
		"--name",
		"-n",
		"--export",
		"--session-link-worker",
		"--session-link-socket",
	]);
	const options = new Map<string, { argument: string; value?: string }>();
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === "--") break;
		if (!argument.startsWith("-")) continue;
		const equals = argument.indexOf("=");
		const name = equals < 0 ? argument : argument.slice(0, equals);
		const value =
			equals >= 0
				? argument.slice(equals + 1)
				: policyValueFlags.has(name)
					? args[++index]
					: undefined;
		// A consumed option value may itself spell --direct or --daemon. It is
		// data, never a startup policy flag. The literal terminator also stops
		// boolean syntax validation, not just policy selection.
		if ((name === "--daemon" || name === "--direct") && equals >= 0)
			throw Error(`${name} is a boolean flag; do not supply a value.`);
		options.set(name, { argument, value });
	}
	const has = (name: string) => options.has(name);
	if (
		has("--daemon") &&
		(has("--direct") || has("--session-link-worker") || has("--session-link-socket"))
	)
		throw Error("--daemon cannot be combined with --direct or worker flags.");
	if (has("--direct") && (has("--session-link-worker") || has("--session-link-socket")))
		throw Error("--direct cannot be combined with worker flags.");
	if (has("--help") || has("-h") || has("--version") || has("-v") || has("--list-models"))
		return "metadata";
	if (has("--direct")) return "direct";
	if (has("--session-link-worker") || has("--session-link-socket")) {
		const token = options.get("--session-link-worker")?.value;
		if (
			!token ||
			token.startsWith("-") ||
			!has("--session-link-socket") ||
			options.get("--mode")?.value !== "rpc"
		)
			throw Error(
				"Internal owners require --session-link-worker TOKEN --session-link-socket PATH --mode rpc.",
			);
		return "worker";
	}
	if (has("--daemon")) {
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (["--daemon", "--no-session", "--no-extensions", "-ne", "--offline"].includes(arg))
				continue;
			if (
				["--extension", "-e"].includes(arg) &&
				args[index + 1] &&
				!args[index + 1]!.startsWith("-")
			) {
				index++;
				continue;
			}
			if (arg === "--mode" && args[index + 1] === "rpc") {
				index++;
				continue;
			}
			throw Error(`Unsupported daemon startup argument ${arg}; use bare pi --daemon.`);
		}
		return "daemon";
	}
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") break;
		const name = arg.split("=", 1)[0]!;
		if (legacySelectors.has(name))
			throw Error(
				`${name} requires --direct. Daemon clients select sessions in the UI. Native CLI selection may already have accessed local files.`,
			);
		if (valueFlags.has(name)) {
			if (arg.includes("=")) throw Error(`Use ${name} VALUE, not ${arg}.`);
			if (!args[index + 1]) throw Error(`${name} requires a value.`);
			index++;
			continue;
		}
		if (booleanFlags.has(name)) continue;
		if (arg.startsWith("-"))
			throw Error(`${arg} is not supported by daemon-client startup; use --direct explicitly.`);
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw Error(
			"Noninteractive local execution requires --direct; daemon clients require an interactive terminal.",
		);
	return "client";
}

/** Snapshot the actual root's extension paths and execution selection. Prompts and
 * local session selectors are deliberately absent; only the remote owner receives
 * initial messages after attachment. Credentials remain in memory-only env/args.
 */
export function getLaunchProfile(mode: NativeMode): LaunchProfile {
	const session = mode.session;
	const args: string[] = ["--no-extensions"];
	for (const extension of session.resourceLoader.getExtensions().extensions) {
		if (extension.resolvedPath && !extension.resolvedPath.startsWith("<"))
			args.push("--extension", extension.resolvedPath);
	}
	const inherited = process.argv.slice(2);
	for (let index = 0; index < inherited.length; index++) {
		const flag = inherited[index]!;
		if (flag === "--") break;
		if (valueFlags.has(flag)) {
			const value = inherited[++index]!;
			if (!["--extension", "-e", "--provider", "--model", "--thinking"].includes(flag))
				args.push(flag, value);
		} else if (booleanFlags.has(flag) && !["--no-extensions", "-ne"].includes(flag)) {
			args.push(flag);
		}
	}
	if (session.model) args.push("--provider", session.model.provider, "--model", session.model.id);
	args.push("--thinking", session.thinkingLevel);
	// Keep explicit CLI --models patterns above. Effective scopes from saved
	// enabledModels must not become a synthetic permanent CLI override.
	return {
		agentDir: mode.runtimeHost.services.agentDir,
		executable: process.execPath,
		cliPath: resolveNativeCLIPath(),
		args,
		env: { ...process.env },
	};
}

/** Concurrent clients may race to spawn; the broker's kernel singleton arbitrates.
 * Never delete discovery files, kill an existing daemon, or fall back to local Pi.
 */
export async function ensureDaemon(profile: LaunchProfile): Promise<DaemonDescriptor> {
	try {
		return await discoverDaemon();
	} catch {
		/* broker itself adjudicates startup */
	}
	const extension = fileURLToPath(new URL("./index.ts", import.meta.url));
	let launchError: Error | undefined;
	let launchPending = false;
	const deadline = Date.now() + 30_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return await discoverDaemon();
		} catch (error) {
			lastError = error;
		}
		if (launchError) throw launchError;
		// Discovery can disappear before inherited worker guards are released.
		// Do not lose our only launch to that shutdown; retry exited contenders.
		if (!launchPending && await singletonReleased()) {
			launchPending = true;
			const child = spawn(
				profile.executable,
				[
					profile.cliPath,
					"--no-session",
					"--mode",
					"rpc",
					"--no-extensions",
					"--extension",
					extension,
					"--daemon",
				],
				{
					cwd: sessionHome(),
					env: {
						...profile.env,
						PI_CODING_AGENT_DIR: profile.agentDir,
						PI_SESSION_LINK_LAUNCH_PROFILE: JSON.stringify(profile),
						...(existsSync(remoteConfigPath())
							? { PI_SESSION_LINK_REMOTE_CONFIG: remoteConfigPath() }
							: {}),
					},
					detached: true,
					stdio: "ignore",
				},
			);
			child.once("error", (error) => {
				launchError = error;
			});
			child.once("exit", (code, signal) => {
				// Only the daemon’s explicit temporary singleton-contention exit retries.
				// Fatal CLI/configuration failures must not respawn for the whole deadline.
				if (code === 75 && !signal) launchPending = false;
				else launchError = Error(`DAEMON_STARTUP_EXITED: ${signal ?? `code ${code}`}. Check the CLI and local daemon configuration.`);
			});
			child.unref();
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	throw Error(
		`DAEMON_STARTUP_UNAVAILABLE: ${lastError instanceof Error ? lastError.message : String(lastError)}. No local fallback.`,
	);
}

/** CacheWarmer's constructor is inert in Pi 0.86; sdk.streamFn first calls
 * start() after an actual request. Fence this exact client's warmer before native
 * init emits session_start. Never persist cacheWarming=off or touch worker state.
 */
function suppressTransientCacheWarmer(mode: NativeMode): void {
	const warmer = mode.session._cacheWarmer;
	if (!warmer) return;
	const cancel: unknown = Reflect.get(warmer, "cancel");
	if (typeof cancel !== "function")
		throw Error("SESSION_LINK_UNSUPPORTED_SDK: local warmer cancellation missing");
	cancel.call(warmer);
	for (const method of ["start", "schedule", "refresh", "onAgentSettled", "onModeChanged"]) {
		if (typeof Reflect.get(warmer, method) !== "function" || !Reflect.set(warmer, method, () => {}))
			throw Error(`SESSION_LINK_UNSUPPORTED_SDK: cannot suppress local warmer ${method}`);
	}
}

interface StartupHook {
	callbacks: Map<Marker, Attach>;
	started: WeakSet<object>;
	rootClaimed: boolean;
}
const hookKey = Symbol.for("pi.private.session-link.default-client-startup.v1");

/** Uses the CLI's one existing InteractiveMode, never constructs an SDK/TUI host.
 * There IS a transient native Agent/AgentSession. Initialize its startup handlers,
 * then retire it through the proven attachment driver before run() sees prompts.
 */
export function installDefaultClientStartup(marker: Marker, attach: Attach): void {
	const prototype = InteractiveMode.prototype as unknown as StartupMode & {
		[hookKey]?: StartupHook;
	};
	let hook = prototype[hookKey];
	if (!hook) {
		const original = prototype.init;
		if (typeof original !== "function")
			throw Error("SESSION_LINK_UNSUPPORTED_SDK: native init seam missing");
		hook = { callbacks: new Map(), started: new WeakSet(), rootClaimed: false };
		Object.defineProperty(prototype, hookKey, { value: hook });
		const state = hook;
		prototype.init = async function () {
			if (state.rootClaimed) return original.call(this);
			const handlers = this.session.extensionRunner
				.getRegisteredCommands()
				.map((command) => command.handler);
			const matched = [...state.callbacks].find(([identity]) =>
				handlers.some((handler) => handler === identity),
			);
			if (!matched || state.started.has(this)) return original.call(this);
			state.started.add(this);
			state.rootClaimed = true;
			// Capture only THIS loader's registered marker, not inherited process flags
			// in SDK-created subagents that happen to share the CLI process.
			state.callbacks.clear();
			let selectionInput = false;
			const releaseInput = this.ui.addInputListener(() =>
				selectionInput ? undefined : { consume: true },
			);
			const gate: StartupInputGate = {
				async withSelectionInput(select) {
					selectionInput = true;
					try {
						return await select();
					} finally {
						selectionInput = false;
					}
				},
			};
			try {
				suppressTransientCacheWarmer(this);
				await original.call(this);
				await matched[1](this, gate);
				releaseInput();
			} catch (error) {
				// No direct-mode fallback and no replay into the transient local owner.
				// Native shutdown() exits zero, so use its primitives for a failure exit.
				try {
					this.stop();
				} catch {
					/* best-effort terminal restoration */
				}
				console.error(
					`SESSION_LINK_STARTUP_FAILED: ${error instanceof Error ? error.message : String(error)}`,
				);
				try {
					await this.runtimeHost.dispose();
				} catch (cleanupError) {
					console.error(String(cleanupError));
				}
				process.exit(1);
			}
		};
	}
	if (!hook.rootClaimed) hook.callbacks.set(marker, attach);
}
