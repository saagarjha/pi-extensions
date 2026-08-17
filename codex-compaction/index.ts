import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

type AnyRecord = Record<string, any>;

const EXTENSION_ID = "codex-compaction";
const SENTINEL = "PI_CODEX_REMOTE_COMPACTION";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const POISON_SUMMARY = process.env.PI_CODEX_COMPACTION_POISON_SUMMARY;

const PI_SUMMARY_PROMPT = `Create a structured handoff summary for the next model in this Pi session.

Use this format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

Be concise but complete enough to replace the summarized transcript.`;

function isCodexModel(model: any): boolean {
	return model?.api === "openai-codex-responses" || String(model?.provider ?? "").toLowerCase().includes("codex");
}

function bearerToken(authResult: any): string | undefined {
	const key = authResult?.auth?.apiKey ?? authResult?.apiKey;
	if (typeof key !== "string" || !key.trim()) return undefined;
	return key.replace(/^Bearer\s+/i, "");
}

function extractAccountId(token: string): string | undefined {
	try {
		const [, payload] = token.split(".");
		if (!payload) return undefined;
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function resolveCodexResponsesUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : "https://chatgpt.com/backend-api";
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

async function codexAuth(ctx: any, model: any): Promise<{ headers: Headers; baseUrl?: string } | undefined> {
	const authResult = await ctx.modelRegistry.getProviderAuth(model.provider).catch(() => undefined);
	const token = bearerToken(authResult);
	if (!token) return undefined;

	const headers = new Headers(authResult?.auth?.headers ?? authResult?.headers ?? model?.headers ?? {});
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("originator", "pi");
	headers.set("User-Agent", "pi-codex-compaction-extension");
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");

	const accountId = headers.get("chatgpt-account-id") ?? extractAccountId(token);
	if (accountId) headers.set("chatgpt-account-id", accountId);
	return { headers, baseUrl: authResult?.auth?.baseUrl ?? authResult?.baseUrl ?? model?.baseUrl };
}

function extractText(response: any): string {
	return (response?.content ?? [])
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n")
		.trim();
}

function findTextSummaryModel(ctx: any): any | undefined {
	const scoped = Array.isArray(ctx.scopedModels) ? ctx.scopedModels.map((entry: any) => entry.model) : [];
	return [ctx.model, ...scoped].find((model: any) => model && !isCodexModel(model)) ?? ctx.model;
}

async function generateTextSummary(ctx: any, event: any, conversationText: string): Promise<{ text: string; usage?: any } | undefined> {
	const model = findTextSummaryModel(ctx);
	if (!model) return undefined;
	const previous = event.preparation.previousSummary ? `\n\nPrevious summary:\n${event.preparation.previousSummary}\n` : "";
	const response = await ctx.modelRegistry.complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `${PI_SUMMARY_PROMPT}${previous}\n\n<conversation>\n${conversationText}\n</conversation>` }],
					timestamp: Date.now(),
				},
			],
		},
		{ maxTokens: 8192, signal: event.signal, cacheRetention: "none", sessionId: uuidv7() },
	);
	const text = extractText(response);
	return text ? { text, usage: response.usage } : undefined;
}

function findCodexCheckpointModel(ctx: any): any | undefined {
	if (isCodexModel(ctx.model)) return ctx.model;
	const scoped = Array.isArray(ctx.scopedModels) ? ctx.scopedModels.map((entry: any) => entry.model) : [];
	const candidates = [...scoped, ...(ctx.modelRegistry.getAvailable?.() ?? []), ...(ctx.modelRegistry.getAll?.() ?? [])].filter((model: any) => isCodexModel(model));
	return candidates.find((model: any) => String(model.id).includes("gpt-5.4-mini")) ?? candidates.find((model: any) => !String(model.id).includes("spark")) ?? candidates[0];
}

async function captureCodexPayload(ctx: any, model: any, messages: any[], systemPrompt: string, signal: AbortSignal): Promise<AnyRecord> {
	let captured: AnyRecord | undefined;
	await ctx.modelRegistry.complete(
		model,
		{ systemPrompt, messages: convertToLlm(messages), tools: [] },
		{
			maxTokens: 16,
			signal,
			cacheRetention: "none",
			sessionId: uuidv7(),
			reasoningEffort: "medium",
			reasoningSummary: "auto",
			textVerbosity: "low",
			onPayload(payload: unknown) {
				captured = payload as AnyRecord;
				throw new Error("codex-compaction captured provider payload");
			},
		},
	).catch(() => undefined);
	if (!captured || !Array.isArray(captured.input)) throw new Error("Could not capture Codex provider payload");
	return captured;
}

async function fetchCodexRemoteCompaction(ctx: any, model: any, payload: AnyRecord, signal: AbortSignal): Promise<AnyRecord[] | undefined> {
	const auth = await codexAuth(ctx, model);
	if (!auth) return undefined;

	// Match Codex remote compaction v2 exactly: send a normal streamed
	// /responses request whose final input item is { type: "compaction_trigger" }.
	// The stream must produce exactly one output item of type "compaction".
	const headers = new Headers(auth.headers);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");

	const body = {
		...payload,
		model: model.id,
		store: false,
		stream: true,
		input: [...payload.input, { type: "compaction_trigger" }],
		include: ["reasoning.encrypted_content"],
		parallel_tool_calls: true,
		reasoning: payload.reasoning ?? { effort: "medium", summary: "auto" },
		text: payload.text ?? { verbosity: "low" },
	};
	const response = await fetch(resolveCodexResponsesUrl(auth.baseUrl), {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	const raw = await response.text();
	if (!response.ok) throw new Error(`Codex compact v2 failed ${response.status}: ${raw.slice(0, 500)}`);

	let sawCompleted = false;
	const outputItems: AnyRecord[] = [];
	for (const chunk of raw.split("\n\n")) {
		const data = chunk
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") continue;
		const event = JSON.parse(data) as AnyRecord;
		if (event.type === "response.completed") sawCompleted = true;
		if (event.type === "response.failed" || event.type === "error") {
			throw new Error(`Codex compact v2 stream error: ${JSON.stringify(event).slice(0, 500)}`);
		}
		if (event.type === "response.output_item.done" && event.item) {
			outputItems.push(event.item);
		}
	}
	if (!sawCompleted) throw new Error("Codex compact v2 stream ended before response.completed");
	const compactions = outputItems.filter((item) => item?.type === "compaction");
	if (compactions.length !== 1) {
		throw new Error(`Codex compact v2 expected exactly one compaction item, got ${compactions.length} from ${outputItems.length} output items`);
	}
	return compactions;
}

function latestCodexDetailsBySummary(ctx: any): Map<string, any> {
	const map = new Map<string, any>();
	for (const entry of ctx.sessionManager.buildContextEntries?.() ?? []) {
		if (entry?.type !== "compaction") continue;
		const codex = entry.details?.[EXTENSION_ID]?.codex;
		if (typeof entry.summary === "string" && codex) map.set(entry.summary, codex);
	}
	return map;
}

function sentinelText(codex: any): string {
	return `${SENTINEL}:${JSON.stringify(codex)}`;
}

function parseSentinel(text: string): any | undefined {
	const index = text.indexOf(`${SENTINEL}:`);
	if (index < 0) return undefined;
	const start = index + SENTINEL.length + 1;
	const raw = text.slice(start).trimStart();
	try {
		return JSON.parse(raw);
	} catch {}
	if (!raw.startsWith("{")) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(raw.slice(0, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

function sentinelReplacementForItem(item: any): any[] | undefined {
	if (!item || typeof item !== "object") return undefined;
	const texts: string[] = [];
	if (typeof item.content === "string") texts.push(item.content);
	if (Array.isArray(item.content)) {
		for (const part of item.content) if (typeof part?.text === "string") texts.push(part.text);
	}
	for (const text of texts) {
		const codex = parseSentinel(text);
		if (Array.isArray(codex?.output)) return codex.output;
	}
	return undefined;
}

function replaceSentinels(value: any): any {
	if (Array.isArray(value)) {
		const out: any[] = [];
		for (const item of value) {
			const replacement = sentinelReplacementForItem(item);
			if (replacement) out.push(...replacement);
			else out.push(replaceSentinels(item));
		}
		return out;
	}
	if (value && typeof value === "object") {
		const replacement = sentinelReplacementForItem(value);
		if (replacement) return replacement;
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceSentinels(v)]));
	}
	return value;
}

export default function extension(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		const codexModel = findCodexCheckpointModel(ctx);
		if (!codexModel) return;

		const messages = [...(event.preparation.messagesToSummarize ?? []), ...(event.preparation.turnPrefixMessages ?? [])];
		if (messages.length === 0 && !event.preparation.previousSummary) return;

		ctx.ui.notify("Codex-aware compaction: generating Pi summary + Codex remote checkpoint", "info");
		const conversationText = serializeConversation(convertToLlm(messages));
		const systemPrompt = ctx.getSystemPrompt?.() ?? "You are a helpful assistant.";

		try {
			const payload = await captureCodexPayload(ctx, codexModel, messages, systemPrompt, event.signal);
			if (event.preparation.previousSummary) {
				payload.input.unshift({ role: "user", content: [{ type: "input_text", text: String(event.preparation.previousSummary) }] });
			}
			const [textSummary, codexOutput] = await Promise.all([
				generateTextSummary(ctx, event, conversationText),
				fetchCodexRemoteCompaction(ctx, codexModel, payload, event.signal),
			]);
			if (!textSummary?.text || !codexOutput?.length) return;
			return {
				compaction: {
					summary: POISON_SUMMARY ? `POISONED_PI_COMPACTION:${POISON_SUMMARY}` : textSummary.text,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: textSummary.usage,
					details: { [EXTENSION_ID]: { version: 3, codex: { output: codexOutput, model: { provider: codexModel.provider, id: codexModel.id } } } },
				},
			};
		} catch (error) {
			if (!event.signal?.aborted) ctx.ui.notify(`Codex remote compaction failed; falling back to Pi default: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}
	});

	pi.on("context", (event: any, ctx: any) => {
		if (!isCodexModel(ctx.model)) return;
		const codexBySummary = latestCodexDetailsBySummary(ctx);
		if (codexBySummary.size === 0) return;
		return {
			messages: event.messages.map((message: any) => {
				if (message?.role !== "compactionSummary") return message;
				const codex = codexBySummary.get(String(message.summary ?? ""));
				return codex ? { ...message, summary: sentinelText(codex) } : message;
			}),
		};
	});

	pi.on("before_provider_request", (event: any, ctx: any) => {
		if (!isCodexModel(ctx.model)) return;
		return replaceSentinels(event.payload);
	});
}
