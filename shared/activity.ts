/** A concise, session-local description of the most recently observable activity. */
export function activityLabel(event: any, activeTools: readonly string[] = []): string | undefined {
	if (event?.type === "tool_execution_start") return `Running ${event.toolName}…`;
	if (event?.type === "tool_execution_update") return `${event.toolName ?? "Tool"}: receiving output…`;
	if (event?.type === "tool_execution_end") return activeTools.length > 0 ? `Running ${activeTools.join(", ")}…` : "Processing tool result…";
	if (event?.type === "message_start" && event.message?.role === "assistant") return "Waiting for response…";
	if (event?.type === "message_update" && event.assistantMessageEvent) {
		const type = event.assistantMessageEvent.type as string;
		if (type.startsWith("thinking_")) return "Thinking…";
		if (type.startsWith("text_")) return "Writing…";
		if (type.startsWith("toolcall_")) return "Preparing tool…";
	}
	if (event?.type === "message_end" && event.message?.role === "assistant") return "Finishing response…";
	if (event?.type === "turn_start") return "Preparing request…";
	if (event?.type === "before_provider_request") return "Waiting for provider…";
	if (event?.type === "after_provider_response") return "Receiving response…";
	if (event?.type === "agent_end" || event?.type === "agent_settled") return undefined;
	return undefined;
}
