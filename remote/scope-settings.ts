import { SettingsManager } from "@earendil-works/pi-coding-agent";
type SettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];
type ModelSettings = { enabledModels?: string[] };

/** Isolated native settings transaction over the SAME storage. The live manager
 * is never made optimistic, so neither failed writes nor queued unrelated writes
 * can contain a rejected selection. No alternate file writer or disk rollback. */
export async function persistEnabledModels(settings: SettingsManager, patterns: string[] | undefined, check: () => void) {
	await settings.flush();
	const storage = Reflect.get(settings, "storage") as SettingsStorage | undefined;
	const global = Reflect.get(settings, "globalSettings") as ModelSettings | undefined;
	const effective = Reflect.get(settings, "settings") as ModelSettings | undefined;
	const modified = Reflect.get(settings, "modifiedFields") as Set<string> | undefined;
	const mutable = (value: unknown): value is ModelSettings => {
		if (!value || typeof value !== "object" || !Object.isExtensible(value)) return false;
		const field = Object.getOwnPropertyDescriptor(value, "enabledModels");
		return !field || field.writable === true;
	};
	if (!storage || typeof storage.withLock !== "function" || !mutable(global) || !mutable(effective) || !(modified instanceof Set))
		throw Error("Worker model-scope persistence adapter unavailable");
	// Do not subsume an earlier failed native model/default-settings write.
	if (modified.has("enabledModels")) throw Error("Worker has an unresolved model-settings write; scope not saved");
	let committed = false, newer = false;
	const transaction = SettingsManager.fromStorage({
		withLock(scope, callback) {
			let wrote = false;
			storage.withLock(scope, current => {
				const next = callback(current);
				wrote = scope === "global" && typeof next === "string";
				return next;
			});
			// A later writer can supersede this commit; readback is NOT an ACK.
			if (wrote) committed = true;
		},
	}, { projectTrusted: settings.isProjectTrusted() });
	const initialErrors = transaction.drainErrors();
	if (initialErrors.length) throw Error(initialErrors.map(item => item.error.message).join("; "));
	const descriptor = Object.getOwnPropertyDescriptor(settings, "setEnabledModels");
	const nativeSet = settings.setEnabledModels;
	const observe = function(this: SettingsManager, value: string[] | undefined) { newer = true; return nativeSet.call(this, value); };
	if (!Reflect.set(settings, "setEnabledModels", observe)) throw Error("Worker settings setter is not adaptable");
	try {
		check();
		transaction.setEnabledModels(patterns);
		await transaction.flush();
		const errors = transaction.drainErrors();
		if (!committed) throw Error(errors.map(item => item.error.message).join("; ") || "Worker settings write was not committed");
		// Synchronize only acknowledged enabledModels caches, never unrelated
		// settings/dirty flags or a newer same-worker model-settings mutation.
		if (newer || Reflect.get(settings, "globalSettings") !== global) return false;
		const now = Reflect.get(settings, "settings") as ModelSettings;
		if (!mutable(now)) throw Error("Worker settings cache changed; saved scope requires reopening");
		if (JSON.stringify(now.enabledModels) !== JSON.stringify(effective.enabledModels)) return false;
		global.enabledModels = patterns === undefined ? undefined : [...patterns];
		const project = settings.getProjectSettings().enabledModels;
		now.enabledModels = project === undefined ? global.enabledModels : project;
		return true;
	} finally {
		if (settings.setEnabledModels === observe) {
			if (descriptor) Object.defineProperty(settings, "setEnabledModels", descriptor);
			else Reflect.deleteProperty(settings, "setEnabledModels");
		}
	}
}
