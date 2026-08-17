import type { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

/** Presentation callbacks only; never expose an owner's tool executors. */
export type ToolRenderers = Pick<NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>, "renderCall" | "renderResult" | "renderShell">;
type Registration = { renderers: ReadonlyMap<string, ToolRenderers> };
const key = Symbol.for("pi.extensions.tool-renderers");
const shared = globalThis as typeof globalThis & { [key]?: Map<string, Registration> };
function registry() { return shared[key] ??= new Map<string, Registration>(); }

export function registerToolRenderers(sessionId: string, renderers: ReadonlyMap<string, ToolRenderers>): () => void {
	const registration = { renderers };
	registry().set(sessionId, registration);
	return () => {
		if (registry().get(sessionId) === registration) registry().delete(sessionId);
	};
}

export function getToolRenderers(sessionId: string, name: string): ToolRenderers | undefined {
	const definition = registry().get(sessionId)?.renderers.get(name);
	return definition && { renderCall: definition.renderCall, renderResult: definition.renderResult, renderShell: definition.renderShell };
}
