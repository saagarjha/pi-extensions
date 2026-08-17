import { persistEnabledModels } from "./scope-settings.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const thinkingScopes = new WeakMap<AgentSession, Map<string, AgentSession["thinkingLevel"] | undefined>>();
const queues = new WeakMap<AgentSession, Promise<unknown>>();
/** Only IDs cross the wire; the owner supplies model objects and thinking scopes. */
export function changeModelScope(session: AgentSession, input: unknown, persist: unknown, check: () => void) {
	if (input !== null && (!Array.isArray(input) || !input.every(id => typeof id === "string")))
		throw Error("INVALID_MODEL_SCOPE");
	if (typeof persist !== "boolean") throw Error("INVALID_MODEL_SCOPE_PERSIST");
	const ids = input === null ? null : [...new Set(input as string[])];
	const pending = (queues.get(session) ?? Promise.resolve()).catch(() => {}).then(async () => {
		check();
		const models = session.modelRuntime.getAvailableSnapshot();
		const byId = new Map(models.map(model => [`${model.provider}/${model.id}`, model]));
		const previous = thinkingScopes.get(session) ?? new Map();
		for (const scope of session.scopedModels) previous.set(`${scope.model.provider}/${scope.model.id}`, scope.thinkingLevel);
		thinkingScopes.set(session, previous);
		const selected = ids?.filter(id => byId.has(id)) ?? [];
		// Native clear/zero-available and all mean unrestricted cycling, not no models.
		const scopes = ids !== null && selected.length > 0 && selected.length < models.length
			? selected.map(id => ({ model: byId.get(id)!, thinkingLevel: previous.get(id) })) : [];
		if (persist) {
			const settings = session.settingsManager;
			const all = ids !== null && ids.length === models.length && ids.every(id => byId.has(id));
			if (!await persistEnabledModels(settings, ids === null || all ? undefined : [...ids], check))
				throw Error("Scope saved, but newer worker model settings retained; reopen the picker");
		}
		check();
		session.setScopedModels(scopes);
	});
	queues.set(session, pending);
	return pending;
}
