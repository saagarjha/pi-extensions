import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const STATE_PATH = join(getAgentDir(), "settings-changelog.json");
const PATCH_KEY = Symbol.for("pi.extensions.settings-changelog.patch");

type GetVersion = SettingsManager["getLastChangelogVersion"];
type SetVersion = SettingsManager["setLastChangelogVersion"];
type ChangelogPatch = {
	getVersion(): string | undefined;
	setVersion(version: string): void;
	getWrapper: GetVersion;
	setWrapper: SetVersion;
};

function reportError(action: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`[settings-changelog] Could not ${action} ${STATE_PATH}: ${message}\n`);
}

function readVersion(): string | undefined {
	try {
		const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { lastChangelogVersion?: unknown };
		return typeof state.lastChangelogVersion === "string" ? state.lastChangelogVersion : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") reportError("read", error);
		return undefined;
	}
}

function writeVersion(version: string): void {
	const temporaryPath = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify({ lastChangelogVersion: version }, null, 2)}\n`, "utf8");
		renameSync(temporaryPath, STATE_PATH);
	} catch (error) {
		if (existsSync(temporaryPath)) {
			try {
				unlinkSync(temporaryPath);
			} catch {}
		}
		reportError("write", error);
	}
}

function installPatch(): void {
	const existing = (globalThis as any)[PATCH_KEY] as ChangelogPatch | undefined;
	if (existing) {
		existing.getVersion = readVersion;
		existing.setVersion = writeVersion;
		return;
	}

	const patch = {
		getVersion: readVersion,
		setVersion: writeVersion,
		getWrapper: undefined as unknown as GetVersion,
		setWrapper: undefined as unknown as SetVersion,
	} satisfies ChangelogPatch;
	patch.getWrapper = function () {
		return patch.getVersion();
	};
	patch.setWrapper = function (version) {
		patch.setVersion(version);
	};
	(globalThis as any)[PATCH_KEY] = patch;
	SettingsManager.prototype.getLastChangelogVersion = patch.getWrapper;
	SettingsManager.prototype.setLastChangelogVersion = patch.setWrapper;
}

export default function extension(_pi: ExtensionAPI): void {
	installPatch();
}
