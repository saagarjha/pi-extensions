export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

export function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function usageNumber(value: unknown): number {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
	return Number.isFinite(number) ? number : 0;
}

function usageCost(usage: any): number {
	const cost = usage?.cost;
	return typeof cost === "object" && cost !== null ? usageNumber(cost.total ?? cost.amount) : usageNumber(cost);
}

type UsageManager = {
	getSessionId(): string;
	getLeafId(): string | null;
	getHeader(): object | null;
	getEntries(): unknown[];
};

/** Like the main footer's native session/leaf cache, but scoped to a child and
 * fenced by manager and header identity too (including same-file reloads).
 * Native entries are immutable and appends advance the leaf. Non-streaming
 * lifecycle events can explicitly refresh after native accounting changes.
 * Never use inference-context messages: totals include ALL native entries.
 */
export function createUsageReader() {
	let manager: UsageManager | undefined;
	let sessionId: string | undefined;
	let leafId: string | null | undefined;
	let header: object | null | undefined;
	let totals: UsageTotals | undefined;
	return (next: UsageManager, refresh = false): UsageTotals => {
		const nextSessionId = next.getSessionId(), nextLeafId = next.getLeafId(), nextHeader = next.getHeader();
		if (!refresh && totals && manager === next && sessionId === nextSessionId && leafId === nextLeafId && header === nextHeader)
			return totals;
		const value = emptyUsage();
		for (const entry of next.getEntries() as Array<any>) {
			const message = entry?.message;
			const usage = message?.usage ?? entry?.usage;
			if (!usage || typeof usage !== "object") continue;
			if (message && message.role !== "assistant" && message.role !== "toolResult") continue;
			value.input += usageNumber(usage.input);
			value.output += usageNumber(usage.output);
			value.cacheRead += usageNumber(usage.cacheRead);
			value.cacheWrite += usageNumber(usage.cacheWrite);
			value.cost += usageCost(usage);
		}
		manager = next;
		sessionId = nextSessionId;
		leafId = nextLeafId;
		header = nextHeader;
		totals = value;
		return value;
	};
}
