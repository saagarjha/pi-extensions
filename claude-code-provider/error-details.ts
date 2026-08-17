// Preserve error diagnostics without serializing arbitrary provider payloads,
// which may contain prompts, request bodies, or authentication headers.
export function claudeErrorMessage(...values: unknown[]): string {
  const lines: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, prefix = "") => {
    if (typeof value === "string") {
      if (value.trim()) lines.push(prefix + value.trim());
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, prefix);
      return;
    }
    // Structural checks also handle exceptions from other JS realms.
    const error = value as { stack?: unknown; message?: unknown; name?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
    const text = typeof error.stack === "string" && error.stack.trim() ? error.stack
      : typeof error.message === "string" ? error.message : "";
    if (text.trim()) lines.push(prefix + text.trim());
    if (typeof error.code === "string" || typeof error.code === "number") lines.push(`Error code: ${error.code}`);
    if (error.cause !== undefined) visit(error.cause, "Caused by: ");
    if (Array.isArray(error.errors)) visit(error.errors, "Underlying error: ");
  };
  for (const value of values) visit(value);
  const message = [...new Set(lines)].join("\n");
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return token ? message.split(token).join("[REDACTED]") : message;
}
