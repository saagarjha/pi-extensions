import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

export default function queuedUp(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const previousFactory = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			const editor = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const originalHandleInput = editor.handleInput.bind(editor);

			editor.handleInput = (data: string) => {
				if (
					keybindings.matches(data, "tui.editor.cursorUp") &&
					editor.getText().trim().length === 0 &&
					ctx.hasPendingMessages()
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
	});
}
