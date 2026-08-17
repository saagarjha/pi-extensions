import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { BackgroundTaskPort } from "./control-plane.ts";
import type { StatusFooterData } from "../status/footer.ts";

/** Finite owned UI data/actions. No factories, components or executable render RPCs. */
export const ownedUI = Symbol.for("pi.owned-ui.v1");
export type OwnedPresentation = (
	| { kind: "subagents" }
	| { kind: "background"; port: BackgroundTaskPort }
) & { label?: string; signal?: AbortSignal };
export type OwnedStatus =
	| { kind: "subagents"; total: number; running: number; idle: number; failed: number }
	| { kind: "background"; total: number; running: number; done: number; failed: number }
	| { kind: "goal"; state: "active" | "paused" | "evaluating" };
export interface OwnedUI {
	readonly remote: true;
	present(request: OwnedPresentation): Promise<void>;
	footer(read: () => StatusFooterData): void;
	status(key: string, value: OwnedStatus | undefined): void;
}
export function remoteUI(ui: ExtensionUIContext | undefined): OwnedUI | undefined {
	return ui ? (ui as ExtensionUIContext & { [ownedUI]?: OwnedUI })[ownedUI] : undefined;
}
export const isOwnedPresentation = (kind: unknown): kind is "subagents" | "background" =>
	kind === "subagents" || kind === "background";
export const remoteLogin = (text: unknown) =>
	typeof text === "string" && /^\/(?:login(?:\s|$)|account\s+login(?:\s|$))/i.test(text.trim());
export const REMOTE_LOGIN_UNSUPPORTED =
	"Login is unavailable in attached sessions. Run standalone Pi to log in; no credentials or account profiles were changed.";
export function renderOwnedStatus(
	value: OwnedStatus | undefined,
	theme: Theme,
): string | undefined {
	if (!value) return;
	if (value.kind === "goal")
		return theme.fg(
			value.state === "paused" ? "dim" : "accent",
			value.state === "evaluating" ? "[evaluating goal…]" : `[goal ${value.state}]`,
		);
	if (!value.total) return;
	const parts = [
		theme.fg("accent", `[${value.total} ${value.kind === "subagents" ? "subagents" : "bg"}`),
	];
	if (value.running) parts.push(theme.fg("accent", `${value.running} running`));
	if (value.kind === "subagents" && value.idle) parts.push(theme.fg("dim", `${value.idle} idle`));
	if (value.kind === "background" && value.done)
		parts.push(theme.fg("success", `${value.done} done`));
	if (value.failed) parts.push(theme.fg("error", `${value.failed} failed`));
	parts[parts.length - 1] += "]";
	return parts.join(" • ");
}
export function setOwnedStatus(
	ui: ExtensionUIContext,
	key: string,
	value: OwnedStatus | undefined,
) {
	const remote = remoteUI(ui);
	if (remote) remote.status(key, value);
	else ui.setStatus(key, renderOwnedStatus(value, ui.theme));
}

export const presentationPriority = (kind: unknown) =>
	kind === "subagents" ? 2 : kind === "background" ? 1 : 0;

/** Borrow the installed native bookkeeping on the REAL owning runner. A data-only
 * presentation is still a native UI prompt; no factories execute on the worker. */
export function nativeOwnedPrompt(
	runner: import("@earendil-works/pi-coding-agent").AgentSession["extensionRunner"],
	label: string | undefined,
	run: () => Promise<void>,
): Promise<void> {
	const method = (
		runner as unknown as {
			withUIPrompt?: (
				kind: string,
				title: string | undefined,
				run: () => Promise<void>,
			) => Promise<void>;
		}
	).withUIPrompt;
	if (typeof method !== "function") throw Error("Native owned UI prompt seam unavailable");
	return method.call(runner, "custom", label, run);
}
