import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Shared helpers for extension task lifecycle code. This file lives at the
// extension root, which Pi auto-discovers, so export a no-op extension factory
// in addition to the helper exports.
export default function extension(_pi: ExtensionAPI) {}

export type TaskTerminalStatus = "done" | "failed" | "cancelled" | "stopped";

export function isTerminalStatus(status: string): boolean {
	return status === "done" || status === "failed" || status === "cancelled" || status === "stopped";
}

export function transitionTaskStatus<TTask extends { status: string; updatedAt: number; completionRead?: boolean }>(
	task: TTask,
	status: TTask["status"],
	options: { isTerminal?: (status: string) => boolean; now?: () => number } = {},
): { changed: boolean; becameTerminal: boolean } {
	const isTerminal = options.isTerminal ?? isTerminalStatus;
	const previous = task.status;
	const changed = previous !== status;
	const becameTerminal = changed && !isTerminal(previous) && isTerminal(status);
	task.status = status;
	task.updatedAt = options.now?.() ?? Date.now();
	if (becameTerminal && "completionRead" in task) task.completionRead = false;
	return { changed, becameTerminal };
}

export function shortText(text: string, maxLength = 120): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

export function newestFirst<T>(items: Iterable<T>, getTime: (item: T) => number): T[] {
	return [...items].sort((a, b) => getTime(b) - getTime(a));
}

export function visibleWindowAroundSelected(options: {
	count: number;
	selected: number;
	maxWidth: number;
	itemWidth(index: number): number;
	separatorWidth?: number;
	edgeMarkerWidth?: number;
}): { start: number; end: number } {
	const separatorWidth = options.separatorWidth ?? 1;
	const edgeMarkerWidth = options.edgeMarkerWidth ?? 2;
	const widthOfRange = (start: number, end: number) => {
		let total = start > 0 ? edgeMarkerWidth : 0;
		for (let i = start; i < end; i++) total += options.itemWidth(i) + (i + 1 < end ? separatorWidth : 0);
		if (end < options.count) total += edgeMarkerWidth;
		return total;
	};
	let start = Math.min(Math.max(0, options.selected), Math.max(0, options.count - 1));
	let end = Math.min(options.count, start + 1);
	while (start > 0 && widthOfRange(start - 1, end) <= options.maxWidth) start--;
	while (end < options.count && widthOfRange(start, end + 1) <= options.maxWidth) end++;
	while (widthOfRange(start, end) > options.maxWidth && start < options.selected) start++;
	while (widthOfRange(start, end) > options.maxWidth && end > options.selected + 1) end--;
	return { start, end };
}

export type CompletionItem<TStatus extends string = string> = {
	id: string;
	taskId: string;
	taskName: string;
	status: TStatus;
	summary: string;
	time: number;
	read: boolean;
};

export class CompletionMailbox<TStatus extends string = string> {
	private items: Array<CompletionItem<TStatus>> = [];

	constructor(private readonly maxItems = 50) {}

	publish(input: Omit<CompletionItem<TStatus>, "id" | "time" | "read"> & { id?: string; time?: number; read?: boolean }): CompletionItem<TStatus> {
		const existing = this.items.find((item) => item.taskId === input.taskId);
		if (existing) return existing;
		const item: CompletionItem<TStatus> = {
			id: input.id ?? `mail_${Math.random().toString(36).slice(2, 8)}`,
			taskId: input.taskId,
			taskName: input.taskName,
			status: input.status,
			summary: input.summary,
			time: input.time ?? Date.now(),
			read: input.read ?? false,
		};
		this.items.push(item);
		if (this.items.length > this.maxItems) this.items.splice(0, this.items.length - this.maxItems);
		return item;
	}

	list(markRead = false): Array<CompletionItem<TStatus>> {
		const out = this.items.map((item) => ({ ...item })).sort((a, b) => a.time - b.time);
		if (markRead) this.markAllRead();
		return out;
	}

	unread(markRead = false): Array<CompletionItem<TStatus>> {
		const out = this.items.filter((item) => !item.read).map((item) => ({ ...item })).sort((a, b) => a.time - b.time);
		if (markRead) for (const item of this.items) if (!item.read) item.read = true;
		return out;
	}

	markAllRead(): void {
		for (const item of this.items) item.read = true;
	}

	clear(): void {
		this.items = [];
	}
}

export async function waitForUnread<T>(options: {
	getUnread(markRead: boolean): T[];
	subscribe(listener: () => void): () => void;
	timeoutMs: number;
	markRead?: boolean;
	beforeCheck?: () => void | Promise<void>;
	pollIntervalMs?: number;
}): Promise<T[]> {
	const markRead = options.markRead ?? true;
	const check = async () => {
		await options.beforeCheck?.();
		return options.getUnread(markRead);
	};
	const existing = await check();
	if (existing.length > 0) return existing;
	return await new Promise<T[]>((resolve) => {
		let unsubscribe: (() => void) | undefined;
		let poll: NodeJS.Timeout | undefined;
		let checking = false;
		let settled = false;
		const finish = (items: T[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (poll) clearInterval(poll);
			unsubscribe?.();
			resolve(items);
		};
		const runCheck = () => {
			if (checking || settled) return;
			checking = true;
			void check().then((items) => {
				checking = false;
				if (items.length > 0) finish(items);
			}).catch(() => {
				checking = false;
			});
		};
		const timer = setTimeout(() => finish([]), options.timeoutMs);
		if (options.pollIntervalMs !== undefined && options.pollIntervalMs > 0) poll = setInterval(runCheck, options.pollIntervalMs);
		unsubscribe = options.subscribe(runCheck);
	});
}
