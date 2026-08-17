import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type IdleStatusBridge = {
	backgroundActiveCount?: () => number;
	subagentsActiveCount?: () => number;
	goalActiveCount?: () => number;
	subagentsUsage?: () => { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
};
const REQUEST = "pi.private.idle-status.request.v1";

/**
 * Call once per extension factory. Extension event wrappers differ, but reach
 * the same per-loader bus. Every participant retains the same bridge, so one
 * unloading cannot orphan the others. Native unloading removes its listener.
 */
export function bindIdleStatus(events: ExtensionAPI["events"]): IdleStatusBridge {
	let bridge: IdleStatusBridge | undefined;
	events.emit(REQUEST, { accept: (value: IdleStatusBridge) => { bridge ??= value; } });
	bridge ??= {};
	const bound = bridge;
	events.on(REQUEST, (request: unknown) => {
		const accept = (request as { accept?: (value: IdleStatusBridge) => void })?.accept;
		if (typeof accept === "function") accept(bound);
	});
	return bound;
}
