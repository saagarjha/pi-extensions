import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { toAnthropicContent } from "./content.ts";

// Resolve the public SDK subpath from Pi's installation, not this extension.
const { transformMessages } = await import(import.meta.resolve(
  "@earendil-works/pi-ai/api/transform-messages",
  pathToFileURL(join(getPackageDir(), "package.json")).href,
)) as typeof import("@earendil-works/pi-ai/api/transform-messages");

// The disposable transcript schema we write, not the version of the installed CLI.
const SESSION_VERSION = "2.1.278";
type Content = Record<string, unknown>[];
type Turn = {
  role: "user" | "assistant";
  content: Content;
  timestamp: number;
  toolResult: boolean;
};

// Pi providers can use long IDs containing characters Anthropic does not accept.
function toolId(id: string): string {
  return `toolu_${createHash("sha256").update(id).digest("hex").slice(0, 48)}`;
}

export function createClaudeSession(context: Context, model: Model<Api>, toolName: (name: string) => string) {
  const turns: Turn[] = [];
  const pendingTools = new Set<string>();
  const append = (role: Turn["role"], content: Content, timestamp: number, toolResult = false) => {
    if (content.length === 0) return;
    const previous = turns.at(-1);
    if (previous?.role === role && previous.toolResult === toolResult) previous.content.push(...content);
    else turns.push({ role, content, timestamp, toolResult });
  };

  // Reuse Pi's handling of cross-model thinking, unsupported images, aborted
  // replies, and missing tool results before translating into Anthropic blocks.
  for (const message of transformMessages(context.messages, model)) {
    if (message.role === "user") {
      pendingTools.clear();
      append("user", toAnthropicContent(message.content), message.timestamp);
    } else if (message.role === "assistant") {
      pendingTools.clear();
      const content: Content = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          // Older bridge transcripts used this marker without the redacted flag.
          if ((block.redacted || block.thinking === "[Reasoning redacted]") && block.thinkingSignature) {
            content.push({ type: "redacted_thinking", data: block.thinkingSignature });
          } else if (block.thinkingSignature) {
            content.push({ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature });
          } else if (block.thinking.trim()) {
            content.push({ type: "text", text: block.thinking });
          }
        } else if (block.type === "toolCall") {
          pendingTools.add(block.id);
          content.push({ type: "tool_use", id: toolId(block.id), name: toolName(block.name), input: block.arguments });
        }
      }
      append("assistant", content, message.timestamp);
    } else if (message.role === "toolResult") {
      const content = toAnthropicContent(message.content);
      if (pendingTools.delete(message.toolCallId)) {
        append("user", [{ type: "tool_result", tool_use_id: toolId(message.toolCallId), content, is_error: message.isError }], message.timestamp, true);
      } else {
        // A result whose call was removed (e.g. an aborted reply) is still useful
        // context, but must not become an unmatched native tool_result block.
        append("user", [{ type: "text", text: `Tool result (${message.toolName}):` }, ...content], message.timestamp, true);
      }
    }
  }

  const last = turns.at(-1);
  if (!last) throw new Error("Claude Code requires a non-empty conversation");
  // stdin accepts user text and images, but strips tool_result blocks. Load complete tool
  // exchanges together from disk; use a non-human continuation to start the next
  // request when there is no new user prompt. Never duplicate a real user turn.
  // Built-in slash commands still execute with --disable-slash-commands. Keep
  // slash-prefixed user text in history too, so the CLI cannot intercept it.
  // Find the first text block even when images precede it.
  const firstText = last.content.find((block) => block.type === "text")?.text;
  const synthetic = last.role !== "user" || last.toolResult
    || (typeof firstText === "string" && firstText.trimStart().startsWith("/"));
  const prompt = synthetic
    ? { role: "user" as const, content: [{ type: "text", text: "Continue." }] }
    : turns.pop()!;

  const sessionId = randomUUID();
  let parentUuid: string | null = null;
  const transcript = turns.map((turn) => {
    const uuid = randomUUID();
    const message = turn.role === "user"
      ? { role: turn.role, content: turn.content }
      : {
          id: `msg_${uuid.replaceAll("-", "")}`,
          type: "message",
          role: turn.role,
          model: model.id,
          content: turn.content,
          stop_reason: turn.content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
    const entry = JSON.stringify({
      parentUuid, isSidechain: false, type: turn.role, message, uuid,
      timestamp: new Date(turn.timestamp).toISOString(),
      userType: "external", cwd: "/", sessionId, version: SESSION_VERSION,
    });
    parentUuid = uuid;
    return `${entry}\n`;
  }).join("");

  return {
    sessionId,
    transcript,
    input: {
      type: "user",
      ...(synthetic ? { isSynthetic: true } : {}),
      message: { role: prompt.role, content: prompt.content },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
    },
  };
}
