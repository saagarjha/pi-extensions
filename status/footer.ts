import type { Theme, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
export interface StatusFooterData {
	totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	latestCacheHitRate?: number;
	contextUsage?: { percent: number | null; contextWindow: number };
	model?: { id: string; provider: string; api: string; contextWindow: number };
	thinking: string;
	account?: string;
}
function statusLabel(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function count(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}
function formatTokens(value: number): string {
	value = count(value);
	if (value < 1000) return `${Math.round(value)}`;
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
	return `${Math.round(value / 1000000)}M`;
}

// Clip both sides with Pi's ANSI/grapheme-aware utilities.
function columns(left: string, right: string, width: number, minimumRight = 0): string {
	if (!left)
		return `${" ".repeat(Math.max(0, width - visibleWidth(right)))}${truncateToWidth(right, width, "")}`;
	if (!right) return truncateToWidth(left, width, "");
	if (visibleWidth(left) + 2 + visibleWidth(right) <= width) {
		return `${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;
	}

	left = truncateToWidth(left, Math.max(0, width - minimumRight - (minimumRight ? 2 : 0)), "");
	if (!left) return truncateToWidth(right, width, "");
	const remaining = Math.max(0, width - visibleWidth(left) - 2);
	return remaining ? `${left}  ${truncateToWidth(right, remaining, "")}` : left;
}

function connectionLine(status: string, connection: string, width: number): string {
	const right = truncateToWidth(connection, width, "");
	const left = truncateToWidth(
		status,
		Math.max(0, width - visibleWidth(right) - (right ? 2 : 0)),
		"",
	);
	return right
		? `${left}${" ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)))}${right}`
		: left;
}

export function createStatusFooter(
	read: () => StatusFooterData,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			let data: StatusFooterData | undefined;
			try {
				data = read();
				width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
				if (!width) return [""];
				const { totals, latestCacheHitRate } = data;
				const contextUsage = data.contextUsage;
				const model = data?.model;
				const rawAccount = data?.account;
				const account = rawAccount === undefined ? undefined : statusLabel(rawAccount);
				const percent = contextUsage?.percent;
				const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
				const context =
					percent == null
						? `?/${formatTokens(contextWindow)}`
						: `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
				const stats: string[] = [];
				if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
				if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
				if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
				if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
				if ((totals.cacheRead || totals.cacheWrite) && latestCacheHitRate != null)
					stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				if (totals.cost) stats.push(`$${totals.cost.toFixed(3)}`);
				stats.push(
					percent != null && percent > 90
						? theme.fg("error", context)
						: percent != null && percent > 70
							? theme.fg("warning", context)
							: context,
				);
				const left = theme.fg("dim", stats.join(" "));
				const statuses = footerData.getExtensionStatuses();
				const connection = statuses.get("remote.connection") ?? "";
				const fast = model?.api === "openai-codex-responses" && statuses.has("codex-fast");
				const thinking = data.thinking || "off";
				const modelSuffix = `${model?.id ?? "no-model"}${thinking !== "off" || fast ? ` • ${thinking}${fast ? "+" : ""}` : ""}`;
				let right = account
					? `${theme.fg("accent", account)} ${theme.fg("dim", modelSuffix)}`
					: theme.fg("dim", modelSuffix);
				if (!account && model && footerData.getAvailableProviderCount() > 1) {
					const withProvider = theme.fg("dim", `(${model.provider}) ${modelSuffix}`);
					if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
				}
				const lines = [columns(left, right, width)];
				const order = ["subagents", "background", "goal"];
				const rank = (key: string) => {
					const index = order.indexOf(key);
					return index < 0 ? order.length : index;
				};
				const extensionText = [...statuses]
					.filter(
						([key]) =>
							key !== "auth-account" && key !== "codex-fast" && key !== "remote.connection",
					)
					.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
					.map(([, text]) => text)
					.filter(Boolean)
					.join("  ");
				if (extensionText || connection)
					lines.push(connectionLine(extensionText, connection, width));
				return lines;
			} catch {
				const model = data?.model;
				const connection = footerData.getExtensionStatuses().get("remote.connection") ?? "";
				const right = [
					data?.account,
					model?.provider ? `(${model.provider})` : undefined,
					model?.id ?? "no-model",
				]
					.filter(Boolean)
					.join(" ");
				const lines = [theme.fg("dim", truncateToWidth(right, width, "..."))];
				if (connection) lines.push(connectionLine("", connection, width));
				return lines;
			}
		},
	};
}

export const emptyOutputRenderer: import("@earendil-works/pi-coding-agent").MessageRenderer = (
	_message,
	_options,
	theme,
) => ({
	invalidate() {},
	render: (width) => [truncateToWidth(theme.fg("warning", "∅  Model returned no output"), width)],
});
