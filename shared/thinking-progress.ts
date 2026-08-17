/** Live estimates are stream metadata, not transcript content or billed usage. */
export function estimatedThinkingTokens(event: any): number | undefined {
	const tokens = event?.estimatedThinkingTokens;
	return event?.type === "thinking_delta" && event.partial?.provider === "claude-code"
		&& typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
		? tokens : undefined;
}
