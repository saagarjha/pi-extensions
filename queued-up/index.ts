import type {
	ExtensionAPI,
	ExtensionUIContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { createInBarEditor } from "../shared/loading.ts";

export default function queuedUp(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const clientUI = ctx.ui as typeof ctx.ui & { installClientEditor?: (name: string) => void };
		if (typeof clientUI.installClientEditor === "function") {
			clientUI.installClientEditor("queued-up");
			return;
		}

		installQueuedEditor(ctx.ui, () => ctx.hasPendingMessages());
	});
}

export function installQueuedEditor(ui: ExtensionUIContext, hasPendingMessages: () => boolean) {
	const previousFactory = ui.getEditorComponent();

	ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const editor =
			previousFactory?.(tui, theme, keybindings) ?? createInBarEditor(tui, theme, keybindings);
		const originalHandleInput = editor.handleInput.bind(editor);

		editor.handleInput = (data: string) => {
			if (
				keybindings.matches(data, "tui.editor.cursorUp") &&
				editor.getText().trim().length === 0 &&
				hasPendingMessages()
			) {
				const customEditor = editor as typeof editor & {
					actionHandlers?: Map<string, () => void>;
				};
				const dequeue = customEditor.actionHandlers?.get("app.message.dequeue");
				if (dequeue) {
					dequeue();
					return;
				}
			}

			originalHandleInput(data);
		};

		return editor;
	});
}
