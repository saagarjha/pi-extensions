import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "claude-code.abort-details";

export function registerAbortDetails(pi: ExtensionAPI) {
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { errorMessage?: unknown } | undefined;
    if (typeof data?.errorMessage !== "string") return undefined;
    return new Text(theme.fg("error", `Claude interruption details\n${data.errorMessage}`), 1, 0);
  });

  return (message: { stopReason: string; errorMessage?: string }) => {
    if (message.stopReason !== "aborted" || !message.errorMessage?.trim()) return;
    // Pi's TUI overwrites aborted assistant errorMessage on message_end.
    // Snapshot it before publishing the provider error. Custom entries persist
    // and render independently, without becoming messages in model context.
    pi.appendEntry(ENTRY_TYPE, { errorMessage: message.errorMessage });
  };
}
