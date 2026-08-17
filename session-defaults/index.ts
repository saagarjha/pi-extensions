import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("pi.extensions.session-defaults.patched");

/**
 * Temporary patch until Pi stops treating interactive model/thinking changes as
 * global default changes. Model and thinking selection are already persisted in
 * the session transcript via model_change/thinking_level_change entries; these
 * setters only mutate ~/.pi/agent/settings.json defaults for future sessions.
 */
export default function extension(_pi: ExtensionAPI) {
	const proto = (SettingsManager as any).prototype as Record<PropertyKey, unknown>;
	if (proto[PATCHED]) return;
	proto[PATCHED] = true;

	for (const name of ["setDefaultProvider", "setDefaultModel", "setDefaultThinkingLevel"]) {
		if (typeof proto[name] === "function") {
			proto[name] = function noopDefaultSettingWrite() {
				return undefined;
			};
		}
	}
}
