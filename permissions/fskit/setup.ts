import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const signingIdentity = "Apple Development";
const profilePath = join(directory, "extension.provisionprofile");
const cache = join(homedir(), "Library", "Caches", "pi", "permissions");
const outputApp = join(cache, "pi-fs.app");
const source = join(directory, "fs.swift");
const entitlement = join(directory, "Extension.entitlements");
const binary = join(outputApp, "Contents", "Extensions", "pi-fs.appex", "Contents", "MacOS", "pi-fs");
let warnedStaleHelper = false;

async function run(pi: ExtensionAPI, executable: string, args: string[]): Promise<string> {
	const result = await pi.exec(executable, args, { timeout: 120_000 });
	if (result.killed || result.code !== 0) throw new Error(`${executable}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
	return result.stdout;
}
function progress(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(`FSKit: ${message}`, "info");
	else console.warn(`FSKit: ${message}`);
}
async function assemble(pi: ExtensionAPI, ctx: ExtensionContext): Promise<{ stage: string; app: string; appex: string }> {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		throw new Error("Prototype requires Apple Silicon macOS 27 and its Swift SDK.");
	const version = await run(pi, "/usr/bin/sw_vers", ["-productVersion"]);
	if (Number(version.split(".")[0]) < 27) throw new Error("macOS 27 or later is required.");
	mkdirSync(cache, { recursive: true, mode: 0o700 });
	const stage = mkdtempSync(join(cache, ".build-"));
	try {
		const app = join(stage, "pi-fs.app"),
			appex = join(app, "Contents", "Extensions", "pi-fs.appex");
		for (const bundle of [app, appex]) mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
		copyFileSync(join(directory, "App-Info.plist"), join(app, "Contents", "Info.plist"));
		copyFileSync(join(directory, "Extension-Info.plist"), join(appex, "Contents", "Info.plist"));
		const entitlements = join(stage, "extension.entitlements");
		copyFileSync(entitlement, entitlements);
		copyFileSync(source, join(stage, "fs.swift"));
		progress(ctx, "Compiling the filesystem extension. This may take a little while…");
		await run(pi, "/usr/bin/xcrun", [
			"swiftc",
			"-target",
			"arm64-apple-macos27.0",
			"-parse-as-library",
			"-swift-version",
			"6",
			"-strict-concurrency=complete",
			"-O",
			"-application-extension",
			join(stage, "fs.swift"),
			"-framework",
			"FSKit",
			"-framework",
			"ExtensionFoundation",
			"-Xlinker",
			"-e",
			"-Xlinker",
			"_EXExtensionMain",
			"-o",
			join(appex, "Contents", "MacOS", "pi-fs"),
		]);
		progress(ctx, "Compiling the containing app…");
		await run(pi, "/bin/sh", [
			"-c", 'exec "$@" < /dev/null', "sh", "/usr/bin/xcrun",
			"swiftc", "-target", "arm64-apple-macos27.0", "-", "-o", join(app, "Contents", "MacOS", "pi-fs"),
		]);
		return { stage, app, appex };
	} catch (error) {
		rmSync(stage, { recursive: true, force: true });
		throw error;
	}
}

/** Like the VM helper: bootstrap if missing; warn once rather than rebuild from mutable source. */
export async function ensureFSKitSetup(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (existsSync(binary)) {
		if (!warnedStaleHelper && statSync(binary).mtimeMs < Math.max(statSync(source).mtimeMs, statSync(entitlement).mtimeMs)) {
			warnedStaleHelper = true;
			const warning = `FSKit helper is older than its source; using the installed helper at ${outputApp}. Delete it to allow a bootstrap rebuild.`;
			if (ctx.hasUI) ctx.ui.notify(warning, "warning"); else console.warn(warning);
		}
		progress(ctx, `Using the cached app at ${outputApp}.`);
		return;
	}
	// Bootstrap automatically, as with the VM helper. codesign presents any
	// required Keychain interaction itself; no separate build/review dialog.
	progress(ctx, `No cached helper found; building ${outputApp}.`);
	const build = await assemble(pi, ctx);
	try {
		copyFileSync(profilePath, join(build.appex, "Contents", "embedded.provisionprofile"));
		progress(ctx, "Signing the extension and app. macOS may ask for Keychain access…");
		await run(pi, "/usr/bin/codesign", ["--force", "--sign", signingIdentity, "--entitlements", join(build.stage, "extension.entitlements"), build.appex]);
		await run(pi, "/usr/bin/codesign", ["--force", "--sign", signingIdentity, build.app]);
		progress(ctx, "Verifying the signatures…");
		await run(pi, "/usr/bin/codesign", ["--verify", "--strict", build.appex]);
		await run(pi, "/usr/bin/codesign", ["--verify", "--strict", build.app]);
		rmSync(outputApp, { recursive: true, force: true });
		renameSync(build.app, outputApp);
		progress(ctx, "Build complete. Launching pi-fs so macOS can discover the extension…");
		await run(pi, "/usr/bin/open", [outputApp]);
		if (ctx.hasUI && !await ctx.ui.confirm("Continue after enabling pi-fs", "The containing app has been launched and exits immediately. If pi-fs is not enabled, enable it in System Settings > General > Login Items & Extensions > File System Extensions (ⓘ), then continue.")) {
			throw new Error("FSKit activation was cancelled; the built helper is cached for the next session.");
		}
	} finally {
		rmSync(build.stage, { recursive: true, force: true });
	}
}
