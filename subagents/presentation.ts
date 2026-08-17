import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createInBarEditor } from "../shared/loading.ts";
function padToWidth(text: string, width: number) {
	const visible = visibleWidth(text);
	return visible >= width ? truncateToWidth(text, width) : text + " ".repeat(width - visible);
}

function stripTranscriptControlCodes(line: string) {
	// Main transcript components add OSC 133 shell-integration zones. Those are
	// useful in the real scrollback but confuse overlay redraw/clipping, so strip
	// them when embedding the components inside our panel.
	return line.replace(/\x1b\]133;[ABC]\x07/g, "");
}

function bordered(
	lines: string[],
	width: number,
	title = "",
	style: (text: string) => string = (text) => text,
) {
	if (width < 8)
		return lines.map((line) => truncateToWidth(stripTranscriptControlCodes(line), width));
	const bodyInner = Math.max(1, width - 4);
	const borderInner = Math.max(1, width - 2);
	const rawTitle = title ? ` ${title.toUpperCase()} ` : "";
	const titleText = truncateToWidth(rawTitle, borderInner, "");
	const topRest = Math.max(0, borderInner - visibleWidth(titleText));
	const top = style(`╔${titleText}${"═".repeat(topRest)}╗`);
	const body = lines.flatMap((line) =>
		wrapTextWithAnsi(stripTranscriptControlCodes(line), bodyInner).map(
			(wrapped) => `${style("║")} ${padToWidth(wrapped, bodyInner)} ${style("║")}`,
		),
	);
	return [top, ...body, style(`╚${"═".repeat(borderInner)}╝`)];
}

/** Keep Pi's colored/status-bearing top editor rule, but omit its bottom rule. */
function createTopChromeEditor(...args: Parameters<typeof createInBarEditor>) {
	const editor = createInBarEditor(...args);
	const render = editor.render.bind(editor);
	editor.render = (width) => {
		const lines = render(width);
		// The bottom border precedes autocomplete rows; remove only that rule.
		const bottomBorder = lines.findIndex((line, index) => {
			if (index === 0) return false;
			const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
			return /^─+$/.test(plain) || plain.startsWith("─── ↑ ") || plain.startsWith("─── ↓ ");
		});
		if (bottomBorder >= 0) lines.splice(bottomBorder, 1);
		return lines;
	};
	return editor;
}

export { bordered, createTopChromeEditor };
