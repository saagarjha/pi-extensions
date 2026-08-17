type BlockKind = "text" | "thinking" | "redacted_thinking";

type NativeBlock = {
  kind: BlockKind;
  contentIndex: number;
  value: string;
  signature?: string;
  id?: string;
  nativeIndex?: number;
  streamed: boolean;
  streamValue: string;
  streamSignature: string;
  snapshotSeen: boolean;
  closed: boolean;
};

type NativeMessage = {
  id?: string;
  blocks: NativeBlock[];
  indexes: Map<number, NativeBlock>;
  ignoredIndexes: Set<number>;
  lastIndex: number;
};

const REDACTED = "[Reasoning redacted]";

function kindOf(block: any): BlockKind | undefined {
  if (block?.type === "text" || block?.type === "thinking" || block?.type === "redacted_thinking") {
    return block.type;
  }
  return undefined;
}

function valueOf(block: any, kind: BlockKind): string {
  if (kind === "redacted_thinking") return REDACTED;
  const value = kind === "text" ? block?.text : block?.thinking;
  return typeof value === "string" ? value : "";
}

function signatureOf(block: any, kind: BlockKind): string | undefined {
  const value = kind === "redacted_thinking" ? block?.data : block?.signature;
  return typeof value === "string" ? value : undefined;
}

/** Translates native Claude content into Pi blocks; tools and terminal events belong to the caller. */
export class ClaudeOutput {
  private readonly messages = new Map<string, NativeMessage>();
  private readonly blocks: NativeBlock[] = [];
  private current?: NativeMessage;
  private finished = false;
  private estimatedThinkingTokens = 0;
  private hasSystemThinkingProgress = false;

  constructor(private readonly output: any, private readonly stream: { push(event: any): void }) {
    output.content ??= [];
  }

  private newMessage(id?: string): NativeMessage {
    const message: NativeMessage = {
      id, blocks: [], indexes: new Map(), ignoredIndexes: new Set(), lastIndex: 0,
    };
    if (id !== undefined) this.messages.set(id, message);
    return message;
  }

  private messageForSnapshot(id?: string): NativeMessage {
    if (id !== undefined) {
      // Some transports omit message_start, or omit its message ID. Bind the current
      // unnamed generation before looking up an ID which an older response may have used.
      if (this.current && this.current.id === undefined) {
        this.current.id = id;
        this.messages.set(id, this.current);
        return this.current;
      }
      const known = this.messages.get(id);
      if (known) return known;
      const message = this.newMessage(id);
      if (!this.current || this.current.indexes.size === 0) this.current = message;
      return message;
    }
    return this.current ??= this.newMessage();
  }

  private createBlock(message: NativeMessage, kind: BlockKind, native: any = {}): NativeBlock {
    const signature = signatureOf(native, kind);
    const block: NativeBlock = {
      kind, contentIndex: this.output.content.length, value: "", signature,
      id: typeof native.id === "string" ? native.id : undefined,
      streamed: false, streamValue: "", streamSignature: "", snapshotSeen: false, closed: false,
    };
    const content: any = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
    if (kind !== "text" && signature !== undefined) content.thinkingSignature = signature;
    if (kind === "redacted_thinking") content.redacted = true;
    this.output.content.push(content);
    message.blocks.push(block);
    this.blocks.push(block);
    this.stream.push({ type: `${content.type}_start`, contentIndex: block.contentIndex, partial: this.output });
    return block;
  }

  private append(block: NativeBlock, delta: string): void {
    if (!delta || block.closed) return;
    block.value += delta;
    const content = this.output.content[block.contentIndex];
    if (block.kind === "text") content.text = block.value;
    else content.thinking = block.value;
    this.stream.push({
      type: `${content.type}_delta`, contentIndex: block.contentIndex, delta, partial: this.output,
    });
  }

  private reconcileValue(block: NativeBlock, value: string): void {
    // A snapshot may already contain deltas which are subsequently replayed by the transport.
    if (value.startsWith(block.value)) this.append(block, value.slice(block.value.length));
  }

  private setSignature(block: NativeBlock, signature: string | undefined): void {
    if (block.kind === "text" || signature === undefined) return;
    // Do not replace a complete snapshot signature with an earlier streamed prefix.
    if (block.signature !== undefined && block.signature.startsWith(signature)) return;
    block.signature = signature;
    this.output.content[block.contentIndex].thinkingSignature = signature;
  }

  private close(block: NativeBlock): void {
    if (block.closed) return;
    block.closed = true;
    this.stream.push({
      type: block.kind === "text" ? "text_end" : "thinking_end",
      contentIndex: block.contentIndex, content: block.value, partial: this.output,
    });
  }

  private closeMessage(message: NativeMessage): void {
    for (const block of message.blocks) this.close(block);
  }

  private publishThinkingProgress(block: NativeBlock, tokens: number): void {
    if (block.closed || !Number.isFinite(tokens) || tokens <= this.estimatedThinkingTokens) return;
    this.estimatedThinkingTokens = tokens;
    this.stream.push({
      type: "thinking_delta", contentIndex: block.contentIndex, delta: "",
      estimatedThinkingTokens: tokens, partial: this.output,
    });
  }

  /** CLI cumulative estimates include a final update not always mirrored in deltas. */
  handleThinkingTokens(tokens: unknown): void {
    if (this.finished || typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return;
    this.hasSystemThinkingProgress = true;
    const block = this.current?.blocks.findLast((candidate) => candidate.kind === "thinking" && !candidate.closed);
    if (block) this.publishThinkingProgress(block, tokens);
  }

  /** Receives the native event inside a CLI stream_event envelope. */
  handleStreamEvent(nativeEvent: any): void {
    if (this.finished || !nativeEvent) return;
    const event = nativeEvent.type === "stream_event" ? nativeEvent.event ?? nativeEvent.stream_event : nativeEvent;
    if (!event) return;
    if (event.type === "message_start") {
      const id = typeof event.message?.id === "string" ? event.message.id : undefined;
      if (this.current) this.closeMessage(this.current);
      // A message_start is a new API response, even if a transport reuses its ID.
      // Snapshots before the next start belong to this generation, not an older ID match.
      this.current = this.newMessage(id);
      // Normally empty, but tolerate transports which include initial content here.
      if (Array.isArray(event.message?.content) && event.message.content.length) {
        this.handleAssistantMessage(event.message);
      }
      return;
    }
    if (event.type === "message_stop") {
      if (this.current) this.closeMessage(this.current);
      return;
    }
    if (event.type !== "content_block_start" && event.type !== "content_block_delta" &&
        event.type !== "content_block_stop" && event.type !== "text_delta" &&
        event.type !== "thinking_delta" && event.type !== "signature_delta") return;

    const message = this.current ??= this.newMessage();
    const index = Number.isInteger(event.index) && event.index >= 0 ? event.index : message.lastIndex;
    message.lastIndex = index;
    if (event.type === "content_block_start") {
      const native = event.content_block;
      const kind = kindOf(native);
      if (!kind) {
        message.ignoredIndexes.add(index);
        return;
      }
      message.ignoredIndexes.delete(index);
      if (message.indexes.has(index)) return; // Replayed start, not a second Pi block.
      // Snapshot-first input is unusual, but can be reconciled without assuming snapshot indexes.
      const initial = valueOf(native, kind);
      const signature = signatureOf(native, kind);
      const block = message.blocks.find((candidate) =>
        candidate.nativeIndex === undefined && candidate.snapshotSeen && candidate.kind === kind &&
        candidate.value.startsWith(initial) &&
        (signature === undefined || candidate.signature === undefined || candidate.signature.startsWith(signature)) &&
        (native.id === undefined || candidate.id === undefined || native.id === candidate.id),
      ) ?? this.createBlock(message, kind, native);
      block.nativeIndex = index;
      block.streamed = true;
      block.streamValue = initial;
      block.streamSignature = signature ?? "";
      message.indexes.set(index, block);
      this.setSignature(block, signature);
      this.reconcileValue(block, initial);
      return;
    }
    if (event.type === "content_block_stop") {
      const block = message.indexes.get(index);
      if (block) this.close(block);
      return;
    }
    if (message.ignoredIndexes.has(index)) return;
    const delta = event.type === "content_block_delta" ? event.delta : event;
    if (!delta || !["text_delta", "thinking_delta", "signature_delta"].includes(delta.type)) return;
    let block = message.indexes.get(index);
    const kind = delta.type === "text_delta" ? "text" : "thinking";
    if (!block) {
      block = this.createBlock(message, kind);
      block.nativeIndex = index;
      block.streamed = true;
      message.indexes.set(index, block);
    }
    if (block.kind !== kind) return;
    if (delta.type === "signature_delta") {
      if (typeof delta.signature === "string") {
        block.streamSignature += delta.signature;
        this.setSignature(block, block.streamSignature);
      }
    } else {
      const value = delta.type === "text_delta" ? delta.text : delta.thinking;
      if (typeof value === "string") {
        block.streamValue += value;
        this.reconcileValue(block, block.streamValue);
      }
      // Fallback for streams without the CLI's cumulative system updates.
      // Never double count the two envelopes or invent reasoning/usage.
      const tokens = delta.estimated_tokens;
      if (!this.hasSystemThinkingProgress && delta.type === "thinking_delta"
          && typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
        this.publishThinkingProgress(block, this.estimatedThinkingTokens + tokens);
      }
    }
  }

  private matchSnapshot(message: NativeMessage, native: any, kind: BlockKind, used: Set<NativeBlock>): NativeBlock | undefined {
    const value = valueOf(native, kind);
    const signature = signatureOf(native, kind);
    let best: NativeBlock | undefined;
    let bestScore = -1;
    for (const block of message.blocks) {
      if (used.has(block) || block.kind !== kind) continue;
      if (typeof native.id === "string" && block.id !== undefined && native.id !== block.id) continue;
      if (signature !== undefined && block.signature !== undefined && signature !== block.signature) {
        if (kind === "redacted_thinking" ||
            (!signature.startsWith(block.signature) && !block.signature.startsWith(signature))) continue;
      }
      const sameId = typeof native.id === "string" && native.id === block.id;
      const sameSignature = signature !== undefined && signature.length > 0 && signature === block.signature;
      let score = sameId ? 200 : sameSignature ? 100 : 0;
      if (value === block.value) {
        score += 50;
      } else if (((block.streamed && !block.snapshotSeen) || sameId || sameSignature) &&
          ((!block.closed && value.startsWith(block.value)) || block.value.startsWith(value))) {
        // Prefix matching is for partial streams, not distinct complete snapshot-only blocks.
        score += 10 + Math.min(20, Math.min(value.length, block.value.length));
      } else {
        continue;
      }
      // Per-block snapshots often all use array index zero. Prefer an as-yet-unacknowledged
      // matching native block, not that array index. Within one array, match one-to-one.
      if (!block.snapshotSeen) score += 1;
      if (score > bestScore) {
        best = block;
        bestScore = score;
      }
    }
    return best;
  }

  /** Receives event.message, which may contain a whole message or just one completed block. */
  handleAssistantMessage(nativeMessage: any): void {
    if (this.finished || !nativeMessage) return;
    const content = typeof nativeMessage.content === "string"
      ? [{ type: "text", text: nativeMessage.content }]
      : nativeMessage.content;
    if (!Array.isArray(content)) return;
    const id = typeof nativeMessage.id === "string" ? nativeMessage.id : undefined;
    const message = this.messageForSnapshot(id);
    const used = new Set<NativeBlock>();
    for (const native of content) {
      const kind = kindOf(native);
      if (!kind) continue;
      const block = this.matchSnapshot(message, native, kind, used) ?? this.createBlock(message, kind, native);
      used.add(block);
      block.snapshotSeen = true;
      this.setSignature(block, signatureOf(native, kind));
      this.reconcileValue(block, valueOf(native, kind));
      // A full assistant snapshot completes snapshot-only blocks. Let native block_stop
      // close streamed blocks, since additional deltas/signatures can still arrive.
      if (!block.streamed) this.close(block);
    }
  }

  /** Result-event fallback only: never repeat text already obtained from streams or snapshots. */
  appendText(text: string): void {
    if (this.finished || !text || this.blocks.some((block) => block.kind === "text" && block.value.length > 0)) return;
    const message = this.current ??= this.newMessage();
    const block = message.blocks.find((candidate) => candidate.kind === "text" && !candidate.closed)
      ?? this.createBlock(message, "text");
    this.append(block, text);
  }

  /** Safe on success, abort, or repeated cleanup; never emits the caller's done/error event. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const block of this.blocks) this.close(block);
  }
}
