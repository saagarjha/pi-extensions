import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This directory is extension-discovered. The subsystem has no hooks or tools
// of its own yet; permissions imports its API directly.
export default function targetsExtension(_pi: ExtensionAPI): void {}

export * from "./api.ts";
export * from "./manager.ts";
