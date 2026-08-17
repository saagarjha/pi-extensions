import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Disabled: Pi has native /thinking, app.thinking.cycle, and
 * thinking_level_select support. Keep this no-op entrypoint so auto-discovery
 * remains harmless until the directory is removed from the dotfiles repo.
 */
export default function extension(_pi: ExtensionAPI) {}
