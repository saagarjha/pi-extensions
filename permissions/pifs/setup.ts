import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const cache = join(homedir(), "Library", "Caches", "pi", "fs");
const source = join(directory, "fs.swift");
export const helperPath = join(cache, "pifs");
let warnedStaleHelper = false;
let building: { promise: Promise<void>; signal?: AbortSignal } | undefined;

async function run(pi: ExtensionAPI, executable: string, args: string[], signal?: AbortSignal): Promise<string> {
	const result = await pi.exec(executable, args, { timeout: 120_000, signal });
	signal?.throwIfAborted();
	if (result.killed || result.code !== 0) {
		throw new Error(`${executable}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
	}
	return result.stdout;
}

function progress(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(`pifs: ${message}`, "info");
	else console.warn(`pifs: ${message}`);
}

async function build(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		throw new Error("pifs requires Apple Silicon macOS 27 or later and its Swift SDK.");
	}
	const version = await run(pi, "/usr/bin/sw_vers", ["-productVersion"], signal);
	const major = Number(version.trim().split(".")[0]);
	if (!Number.isInteger(major) || major < 27) throw new Error("macOS 27 or later is required.");
	mkdirSync(cache, { recursive: true, mode: 0o700 });
	const stage = mkdtempSync(join(cache, ".build-"));
	try {
		const input = join(stage, "fs.swift");
		const output = join(stage, "pifs");
		copyFileSync(source, input);
		progress(ctx, "Compiling the filesystem provider…");
		await run(pi, "/usr/bin/xcrun", [
			"swiftc", "-target", "arm64-apple-macos27.0", "-parse-as-library",
			"-swift-version", "6", "-strict-concurrency=complete", "-O", input, "-o", output,
		], signal);
		signal?.throwIfAborted();
		renameSync(output, helperPath);
		progress(ctx, "Filesystem provider ready.");
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

/** Like the VM helper: bootstrap if missing; warn once rather than rebuild from mutable source. */
export async function ensurePiFSSetup(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (existsSync(helperPath)) {
		if (!warnedStaleHelper && statSync(helperPath).mtimeMs < statSync(source).mtimeMs) {
			warnedStaleHelper = true;
			const warning = `pifs helper is older than its source; using the installed helper at ${helperPath}. Delete it to allow a bootstrap rebuild.`;
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			else console.warn(warning);
		}
		return;
	}
	building ??= { signal, promise: build(pi, ctx, signal).finally(() => { building = undefined; }) };
	const current = building;
	try {
		await current.promise;
	} catch (error) {
		signal?.throwIfAborted();
		if (current.signal?.aborted) return ensurePiFSSetup(pi, ctx, signal);
		throw error;
	}
	signal?.throwIfAborted();
}
