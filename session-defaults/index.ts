import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Disabled: current Pi only persists model/thinking defaults for explicit
 * persist=true actions, so the old SettingsManager monkey patch is obsolete
 * and blocks legitimate native default-saving flows.
 */
export default function extension(_pi: ExtensionAPI) {}
