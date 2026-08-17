import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

type PiContent = string | readonly (TextContent | ImageContent)[];
type TextBlock = Pick<TextContent, "type" | "text">;
type AnthropicBlock = TextBlock | {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

// MCP uses Pi's image shape. Copy only wire fields, keeping block order and
// base64 data intact rather than collapsing images into text placeholders.
export function toMcpContent(content: PiContent, supportsImages = true): (TextBlock | ImageContent)[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks: (TextBlock | ImageContent)[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      if (supportsImages) {
        blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
      } else {
        // Match transformMessages' non-vision tool-result downgrade, including
        // collapsing adjacent images/placeholders into a single text block.
        const text = "(tool image omitted: model does not support images)";
        const previous = blocks.at(-1);
        if (previous?.type !== "text" || previous.text !== text) {
          blocks.push({ type: "text", text });
        }
      }
    }
  }
  return blocks;
}

// Call after transformMessages so Pi remains responsible for downgrading
// images when the selected model does not support them.
export function toAnthropicContent(content: PiContent): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  for (const block of toMcpContent(content)) {
    if (block.type === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      });
    } else if (block.text.trim()) {
      // Anthropic rejects empty text blocks; preserve non-empty text verbatim.
      blocks.push(block);
    }
  }
  return blocks;
}
