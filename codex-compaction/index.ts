import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

type AnyRecord = Record<string, any>;

const EXTENSION_ID = "codex-compaction";
const SENTINEL = "PI_CODEX_REMOTE_COMPACTION";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

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

let convertResponsesMessagesPromise: Promise<any> | undefined;

async function getConvertResponsesMessages(): Promise<any> {
	convertResponsesMessagesPromise ??= (async () => {
		// Pi's extension loader currently resolves pi-ai's package root to a concrete
		// dist entrypoint (index.js or compat.js). Resolve the sibling dist/api file
		// from that entrypoint instead of asking jiti to resolve the package subpath;
		// jiti mis-resolves the subpath as dist/compat.js/api/...
		const piAiEntry = import.meta.resolve("@earendil-works/pi-ai");
		const specifier = new URL("./api/openai-responses-shared.js", piAiEntry).href;
		return (await import(specifier)).convertResponsesMessages;
	})();
	return convertResponsesMessagesPromise;
}

async function makeCodexInput(model: any, messages: any[], systemPrompt: string): Promise<AnyRecord[]> {
	const convertResponsesMessages = await getConvertResponsesMessages();
	return convertResponsesMessages(
		model,
		{ systemPrompt, messages: convertToLlm(messages), tools: [] },
		CODEX_TOOL_CALL_PROVIDERS,
		{
			includeSystemPrompt: false,
			toolOptions: {
				strict: null,
				supportsStrictMode: true,
				supportsOpenAIGrammarTools: model?.compat?.supportsOpenAIGrammarTools ?? false,
			},
		},
	) as AnyRecord[];
}

async function fetchCodexRemoteCompaction(ctx: any, model: any, input: AnyRecord[], systemPrompt: string, signal: AbortSignal): Promise<AnyRecord[] | undefined> {
	const auth = await codexAuth(ctx, model);
	if (!auth) return undefined;

	// Match Codex remote compaction v2 exactly: send a normal streamed
	// /responses request whose final input item is { type: "compaction_trigger" }.
	// The stream must produce exactly one output item of type "compaction".
	const headers = new Headers(auth.headers);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");

	const body = {
		model: model.id,
		store: false,
		stream: true,
		instructions: systemPrompt || "You are a helpful assistant.",
		input: [...input, { type: "compaction_trigger" }],
		include: ["reasoning.encrypted_content"],
		parallel_tool_calls: true,
		reasoning: { effort: "medium", summary: "auto" },
		text: { verbosity: "low" },
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
	try {
		return JSON.parse(text.slice(index + SENTINEL.length + 1));
	} catch {
		return undefined;
	}
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
		if (!isCodexModel(ctx.model)) return;

		const messages = [...(event.preparation.messagesToSummarize ?? []), ...(event.preparation.turnPrefixMessages ?? [])];
		if (messages.length === 0 && !event.preparation.previousSummary) return;

		ctx.ui.notify("Codex-aware compaction: generating Pi summary + Codex remote checkpoint", "info");
		const conversationText = serializeConversation(convertToLlm(messages));
		const systemPrompt = ctx.getSystemPrompt?.() ?? "You are a helpful assistant.";
		const codexInput = await makeCodexInput(ctx.model, messages, systemPrompt);
		if (event.preparation.previousSummary) {
			codexInput.unshift({ role: "user", content: [{ type: "input_text", text: String(event.preparation.previousSummary) }] });
		}

		try {
			const [textSummary, codexOutput] = await Promise.all([
				generateTextSummary(ctx, event, conversationText),
				fetchCodexRemoteCompaction(ctx, ctx.model, codexInput, systemPrompt, event.signal),
			]);
			if (!textSummary?.text || !codexOutput?.length) return;
			return {
				compaction: {
					summary: textSummary.text,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: textSummary.usage,
					details: { [EXTENSION_ID]: { version: 2, codex: { output: codexOutput } } },
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
