import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import type { BackgroundTaskMetadata, BackgroundTaskDetail } from "../../shared/control-plane.ts";
import { visibleWindowAroundSelected } from "../../shared/task-lifecycle.ts";
import { backgroundOutput } from "../../shared/background-activity.ts";
import { bordered } from "../../subagents/presentation.ts";
export interface BackgroundPanelState {
	selectedId?: string;
	scrollOffset?: number;
}
export interface BackgroundViewPort {
	list(): BackgroundTaskMetadata[] | Promise<BackgroundTaskMetadata[]>;
	status(id: string): BackgroundTaskDetail | Promise<BackgroundTaskDetail>;
	stop(id: string): Promise<BackgroundTaskDetail>;
	subscribe(listener: () => void): () => void;
}
export function openBackgroundPanel(
	ui: ExtensionUIContext,
	port: BackgroundViewPort,
	signal?: AbortSignal,
	label?: string,
	state: BackgroundPanelState = {},
) {
	return ui.custom<boolean>(
		(tui, theme, keys, done) =>
			new BackgroundPanel(tui, theme, keys, done, port, signal, label, state),
		{ overlay: true, overlayOptions: { width: "86%", maxHeight: "68%", anchor: "center" } },
	);
}
export class BackgroundPanel implements Component, Focusable {
	private selected = 0;
	private selectedId?: string;
	// Activity can reorder tabs between renders or just before a key press.
	private listedItems() {
		const items = this.jobs;
		const index = items.findIndex((item) => item.id === this.selectedId);
		this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, items.length - 1));
		const id = items[this.selected]?.id;
		if (id !== this.selectedId) this.scrollOffset = 0;
		this.selectedId = id;
		return items;
	}
	private select(index: number, items: BackgroundTaskMetadata[]) {
		this.selected = index;
		this.selectedId = items[index]?.id;
		this.scrollOffset = 0;
	}
	private scrollOffset = 0;
	private unsubscribe: () => void;
	focused = false;
	private jobs: BackgroundTaskMetadata[] = [];
	private detail?: BackgroundTaskDetail;
	private closed = false;
	private fetching = false;
	private dirty = false;
	private error = "";
	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: { matches(data: string, action: string): boolean },
		private done: (user: boolean) => void,
		private port: BackgroundViewPort,
		private signal?: AbortSignal,
		private label?: string,
		private state: BackgroundPanelState = {},
	) {
		this.selectedId = state.selectedId;
		this.scrollOffset = state.scrollOffset ?? 0;
		this.unsubscribe = port.subscribe(() => void this.refresh());
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
		else void this.refresh();
	}
	private abort = () => {
		this.dispose();
		this.done(false);
	};
	dispose() {
		if (this.closed) return;
		this.state.selectedId = this.selectedId;
		this.state.scrollOffset = this.scrollOffset;
		this.closed = true;
		this.unsubscribe();
		this.signal?.removeEventListener("abort", this.abort);
	}
	invalidate() {}
	private async refresh() {
		if (this.closed) return;
		if (this.fetching) {
			this.dirty = true;
			return;
		}
		this.fetching = true;
		try {
			const jobs = await this.port.list();
			if (this.closed) return;
			this.jobs = jobs;
			const id = this.listedItems()[this.selected]?.id;
			const detail = id ? await this.port.status(id) : undefined;
			if (!this.closed && id === this.selectedId) {
				this.detail = detail;
				this.error = "";
			}
		} catch (error) {
			if (!this.closed) this.error = String(error);
		} finally {
			this.fetching = false;
			if (!this.closed) {
				this.tui.requestRender();
				if (this.dirty) {
					this.dirty = false;
					void this.refresh();
				}
			}
		}
	}

	handleInput(data: string) {
		const jobs = this.listedItems();
		if (
			this.keybindings.matches(data, "tui.select.cancel") ||
			this.keybindings.matches(data, "app.interrupt")
		) {
			this.dispose();
			return this.done(true);
		}
		const stopSelected =
			data === "\x04" || this.keybindings.matches(data, "tui.input.deleteForward");
		if (stopSelected) {
			const job = jobs[this.selected];
			if (job)
				void this.port
					.stop(job.id)
					.then(() => this.refresh())
					.catch((error) => {
						if (!this.closed) {
							this.error = String(error);
							this.tui.requestRender();
						}
					});
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.select(Math.max(0, this.selected - 1), jobs);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.select(Math.min(Math.max(0, jobs.length - 1), this.selected + 1), jobs);
		} else if (matchesKey(data, "shift+tab")) {
			this.select(jobs.length === 0 ? 0 : (this.selected + jobs.length - 1) % jobs.length, jobs);
		} else if (this.keybindings.matches(data, "tui.input.tab")) {
			this.select(jobs.length === 0 ? 0 : (this.selected + 1) % jobs.length, jobs);
		} else if (
			this.keybindings.matches(data, "tui.select.pageUp") ||
			this.keybindings.matches(data, "tui.altScreen.pageUp")
		)
			this.scrollOffset += 10;
		else if (
			this.keybindings.matches(data, "tui.select.pageDown") ||
			this.keybindings.matches(data, "tui.altScreen.pageDown")
		)
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		else if (this.keybindings.matches(data, "tui.altScreen.bottom")) this.scrollOffset = 0;
		void this.refresh();
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const jobs = this.listedItems();
		const innerWidth = Math.max(1, width - 4);
		const maxOverlayHeight = Math.floor((this.tui.terminal.rows || 24) * 0.68);
		const helpText =
			"ctrl-d stop selected • pageUp/pageDown scroll • tab/shift-tab job • esc close";
		const helpHeight = wrapTextWithAnsi(helpText, innerWidth).length;
		const bodyHeight = Math.max(3, maxOverlayHeight - 1 - helpHeight);
		const lines: string[] = [];
		if (this.error) lines.push(this.theme.fg("error", this.error));
		if (jobs.length === 0) {
			lines.push("No background commands. Use bg_start from the agent.");
		} else {
			const tabs = jobs.map((job, i) => {
				const marker = job.status === "running" ? "●" : job.status === "done" ? "✓" : "✗";
				const label = `${marker} ${job.id}`;
				return i === this.selected
					? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${label} `))
					: this.theme.fg("dim", ` ${label} `);
			});
			const { start, end } = visibleWindowAroundSelected({
				count: tabs.length,
				selected: this.selected,
				maxWidth: innerWidth,
				itemWidth: (i) => visibleWidth(tabs[i] ?? ""),
			});
			const tabsLine = `${start > 0 ? "‹ " : ""}${tabs.slice(start, end).join(" ")}${end < tabs.length ? " ›" : ""}`;
			lines.push(truncateToWidth(tabsLine, innerWidth));
			lines.push("═".repeat(innerWidth));
			const job = jobs[this.selected];
			if (job) {
				lines.push(this.theme.fg("dim", truncateToWidth(`${job.target} · ${job.cwd}`, innerWidth)));
				lines.push(this.theme.fg("dim", "─".repeat(innerWidth)));
				const logLines = [
					`$ ${job.command}`,
					"",
					...backgroundOutput(
						this.detail?.id === job.id ? this.detail : { ...job, output: "" },
						40_000,
					).split("\n"),
				].flatMap((line) =>
					wrapTextWithAnsi(line || " ", innerWidth).map((wrapped) =>
						truncateToWidth(wrapped, innerWidth),
					),
				);
				const maxLogLines = Math.max(4, bodyHeight - lines.length - 2);
				if (logLines.length > maxLogLines) {
					const viewportLines = Math.max(1, maxLogLines - 1);
					const maxOffset = Math.max(0, logLines.length - viewportLines);
					this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
					const end = logLines.length - this.scrollOffset;
					const start = Math.max(0, end - viewportLines);
					lines.push(
						this.theme.fg(
							"dim",
							this.scrollOffset
								? `↑ ${start} earlier • ↓ ${logLines.length - end} later`
								: `… ${start} earlier lines hidden`,
						),
					);
					lines.push(...logLines.slice(start, end));
				} else {
					this.scrollOffset = 0;
					lines.push(...logLines);
				}
			}
		}
		while (lines.length < bodyHeight - 1) lines.push("");
		if (lines.length > bodyHeight - 1)
			lines.splice(
				0,
				lines.length - (bodyHeight - 1) + 1,
				this.theme.fg("dim", "… earlier panel content hidden"),
			);
		lines.push(this.theme.fg("dim", helpText));
		return bordered(
			lines,
			width,
			this.label ? `${this.label} · background commands` : "background commands",
			(text) => this.theme.fg("accent", text),
		);
	}
}
