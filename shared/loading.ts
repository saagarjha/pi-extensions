import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CustomEditor, getPackageDir, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { activityLabel } from "./activity.ts";

/**
 * Opt custom editors into Pi's own editor-border status indicator. Pi owns the
 * actual indicator, animation, theme, clipping, and retry/compaction lifecycle.
 * Preserve any previously configured editor when using this as a factory fallback.
 */
export function createInBarEditor(
	...args: Parameters<NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>>
): CustomEditor {
	return new CustomEditor(...args, { embedWorkingStatus: true });
}

export type WorkingIndicatorUI = Pick<ExtensionUIContext, "setWorkingIndicator" | "setWorkingMessage" | "setWorkingVisible">;

/**
 * Session-scoped binding to Pi's working indicator.
 * Create after session_start; dispose before releasing that session.
 * This does NOT infer idleness or hide loaders on agent_end: retries, queued
 * continuations, background work, subagents, and goals keep their own lifecycle.
 */
export function createWorkingIndicator(initialUI: WorkingIndicatorUI) {
	let ui: WorkingIndicatorUI | undefined = initialUI;
	let message: string | undefined;
	ui.setWorkingIndicator(); // Reuse the native indicator, never duplicate it.
	ui.setWorkingMessage();
	ui.setWorkingVisible(true);

	function setMessage(next?: string): void {
		if (!ui || next === message) return;
		message = next;
		ui.setWorkingMessage(next);
	}

	return {
		/** Apply an activity label (including undefined to restore Pi's default). */
		setMessage,
		/** Ignore unrelated events; ending a run resets its label, not visibility. */
		handleEvent(event: { type: string; [key: string]: unknown }, activeTools: readonly string[] = []): void {
			if (!ui) return;
			const label = activityLabel(event, activeTools);
			if (label !== undefined || event.type === "agent_end" || event.type === "agent_settled") setMessage(label);
		},
		/**
		 * No timers or subscriptions are installed. Release the UI reference and
		 * make late events inert. Pi/adapter teardown clears the native loader;
		 * writing here could overwrite a newly attached owner's indicator.
		 */
		dispose(): void { ui = undefined; },
	};
}

type PanelNativeIndicator = NonNullable<Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]>;
type PanelNativeIndicatorConstructor = new (
	kind: "working", tui: TUI, spinnerColor: (text: string) => string,
	messageColor: (text: string) => string, message: string,
) => PanelNativeIndicator;

let nativePanelIndicator: Promise<PanelNativeIndicatorConstructor> | undefined;
function loadPanelIndicator(): Promise<PanelNativeIndicatorConstructor> {
	return nativePanelIndicator ??= (async () => {
		// Pi doesn't export this constructor publicly. Load its implementation
		// from the running SDK rather than duplicating the indicator.
		const url = pathToFileURL(join(getPackageDir(), "dist/modes/interactive/components/status-indicator.js"));
		const native = await import(url.href);
		return native.StatusIndicator as PanelNativeIndicatorConstructor;
	})();
}

export interface PanelWorkingIndicator {
	/** Start/stop only this panel's indicator. An omitted label keeps its message. */
	setWorking(working: boolean, message?: string): void;
	/** Change the activity label; undefined restores the default. */
	setMessage(message?: string): void;
	invalidate(): void;
	dispose(): void;
}

const panelOwners = new WeakMap<CustomEditor, PanelWorkingIndicator>();

/**
 * Indicator for a child panel, NOT the main session's working UI.
 * Await in the panel factory, pass its own createInBarEditor() instance, and
 * dispose when closing/reselecting. Pi owns rendering inside the editor bar.
 * No ctx.ui, owner runtime, provider, or event callback is captured.
 */
export async function createPanelWorkingIndicator(
	tui: TUI, editor: CustomEditor,
): Promise<PanelWorkingIndicator> {
	const NativeIndicator = await loadPanelIndicator();
	panelOwners.get(editor)?.dispose();
	let resources: { tui: TUI; editor: CustomEditor } | undefined = { tui, editor };
	let indicator: PanelNativeIndicator | undefined;
	let message = "Working…";

	// Native Loader only calls requestRender. The gate prevents a queued native
	// animation tick from touching a disposed/replaced panel. Release resources
	// below as well as stopping the native timer; don't retain the owner TUI.
	const renderTarget = { requestRender: () => resources?.tui.requestRender() } as TUI;
	const color = (text: string) => resources?.editor.borderColor(text) ?? text;

	function clear(): void {
		if (!indicator) return;
		indicator.dispose();
		indicator = undefined;
		resources?.editor.setWorkingStatusIndicator(undefined);
	}

	const binding: PanelWorkingIndicator = {
		setMessage(next): void {
			if (!resources) return;
			const value = next ?? "Working…";
			if (value === message) return;
			message = value;
			indicator?.setMessage(message);
		},
		setWorking(working, ...label: [message?: string]): void {
			if (!resources) return;
			if (label.length) binding.setMessage(label[0]);
			if (!working) {
				if (indicator) { clear(); resources.tui.requestRender(); }
				return;
			}
			if (indicator) return;
			indicator = new NativeIndicator("working", renderTarget, color, color, message);
			try {
				resources.editor.setWorkingStatusIndicator(indicator);
				resources.tui.requestRender();
			} catch (error) { clear(); throw error; }
		},
		invalidate(): void {
			if (!resources || !indicator) return;
			indicator.invalidate();
		},
		dispose(): void {
			if (!resources) return;
			clear();
			if (panelOwners.get(resources.editor) === binding) panelOwners.delete(resources.editor);
			const target = resources.tui;
			resources = undefined;
			target.requestRender();
		},
	};
	panelOwners.set(editor, binding);
	return binding;
}
