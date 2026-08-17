import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { toMcpContent } from "./content.ts";
import { createDockerfile } from "./dockerfile.ts";
import { ClaudeOutput } from "./output.ts";
import { registerAbortDetails } from "./abort-details.ts";
import { claudeErrorMessage } from "./error-details.ts";
import { createClaudeSession } from "./session.ts";

const PROVIDER_ID = "claude-code";
const IMAGE = process.env.PI_CLAUDE_CODE_IMAGE || "pi-claude-code-runner:latest";
const MCP_SERVER_NAME = process.env.PI_CLAUDE_CODE_MCP_SERVER || "session";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const mcpToolName = (toolName: string) => `${MCP_TOOL_PREFIX}${toolName}`;
const DOCKERFILE = createDockerfile(MCP_SERVER_NAME);
const CLAUDE_CODE_SYSTEM_PROMPT = `You are operating inside pi, a coding agent harness.

Use the available tools as your normal workspace tools for this session. They provide access to the files, commands, VMs, and session state that pi has made available. When asked about access to a path, check with the tools rather than guessing.`;

function claudeCodeModelsFromPi(anthropicModels: readonly any[]) {
  const explicitIds = process.env.PI_CLAUDE_CODE_MODELS?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const selected = explicitIds
    ? explicitIds.map((id) => {
        const model = anthropicModels.find((candidate) => candidate.id === id);
        if (!model) throw new Error(`PI_CLAUDE_CODE_MODELS includes unknown Anthropic model: ${id}`);
        return model;
      })
    : anthropicModels;
  return selected.map((model) => ({
    ...model,
    provider: PROVIDER_ID,
    api: "claude-code-docker" as any,
    baseUrl: "docker://claude-code",
    headers: undefined,
    // Keep catalog prices for API-equivalent accounting, like subscription Codex.
    name: `${model.name ?? model.id} via Claude Code`,
  }));
}

type McpReply = { content?: ReturnType<typeof toMcpContent>; text?: string; isError?: boolean };
type McpCall = { toolUseId: string; name: string; arguments: any };
type PendingTool = {
  nativeId: string;
  toolCallId: string;
  toolName: string;
  arguments: any;
  declared: boolean;
  presented: boolean;
  response?: ServerResponse;
  reply?: McpReply;
};
type ToolBatch = { calls: PendingTool[]; continuationKey: string };
type ClaudeRun = {
  child: ChildProcess;
  rl: ReadlineInterface;
  stderr: string;
  events: any[];
  waiters: Array<(event: any) => void>;
  calls: Map<string, PendingTool>;
  batch: PendingTool[];
  awaiting?: ToolBatch;
  closed: boolean;
  exitCode?: number;
  sawResult: boolean;
  inputEnded: boolean;
  interrupted: boolean;
  interruptRequestId?: string;
  whenClosed: Promise<void>;
  terminate: () => Promise<void>;
  forced?: Promise<void>;
  stopping?: Promise<void>;
  abortCleanup?: () => void;
};
type ProviderState = {
  broker?: { server: Server; url: string };
  activeRun?: ClaudeRun;
  containerReady?: Promise<string>;
  containerNeedsRefresh?: boolean;
  runCleanup?: Promise<void>;
};

function emptyUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function runProcess(command: string, args: string[], input?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`${command} cleanup timed out`));
    }, timeoutMs);
    const clearTimer = () => { if (timer) clearTimeout(timer); };
    child.once("error", clearTimer);
    child.once("close", clearTimer);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

let imageReady: Promise<void> | undefined;

async function buildImage(refresh = false): Promise<void> {
  const args = ["build", "-t", IMAGE];
  if (refresh) args.push("--build-arg", `CLAUDE_CACHE_BUST=${randomUUID()}`);
  // Docker only moves the tag after a successful build. A failed update leaves
  // the previous image available, without invalidating the apt dependency layers.
  const build = await runProcess("docker", [...args, "-"], DOCKERFILE);
  if (build.code !== 0) throw new Error(`Failed to build ${IMAGE}:\n${build.stderr || build.stdout}`);
}

async function ensureImage(): Promise<string> {
  if (!imageReady) {
    imageReady = (async () => {
      const existing = await runProcess("docker", ["image", "inspect", IMAGE]);
      if (existing.code !== 0) await buildImage();
    })();
  }
  const pending = imageReady;
  try {
    await pending;
  } catch (error) {
    if (imageReady === pending) imageReady = undefined;
    throw error;
  }
  return IMAGE;
}

async function ensureContainer(state: ProviderState): Promise<string> {
  // A terminal result completes Pi's turn before the CLI necessarily exits.
  // Never reuse its container until bounded cleanup decides whether to retire it.
  await state.runCleanup;
  if (state.containerNeedsRefresh) {
    state.containerNeedsRefresh = false;
    await removeContainer(state);
  }
  if (!state.containerReady) {
    state.containerReady = (async () => {
      const image = await ensureImage();
      const created = await runProcess("docker", ["create", "-i", "--entrypoint", "sleep", image, "infinity"]);
      if (created.code !== 0) throw new Error(`Failed to create Claude Code Docker container:\n${created.stderr || created.stdout}`);
      const id = created.stdout.trim();
      if (!id) throw new Error("docker create did not return a container id");
      const started = await runProcess("docker", ["start", id]);
      if (started.code !== 0) {
        await runProcess("docker", ["rm", "-f", id]).catch(() => undefined);
        throw new Error(`Failed to start Claude Code Docker container:\n${started.stderr || started.stdout}`);
      }
      return id;
    })();
  }
  return state.containerReady;
}

async function removeContainer(state: ProviderState) {
  const container = state.containerReady;
  if (!container) return;
  state.containerReady = undefined;
  const id = await container.catch(() => undefined);
  if (id) await runProcess("docker", ["rm", "-f", id]).catch(() => undefined);
}

function activePiTools(pi: ExtensionAPI) {
  const active = new Set(pi.getActiveTools());
  return pi.getAllTools().filter((tool: any) => active.has(tool.name))
    .map((tool: any) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

function respond(res: ServerResponse, status: number, payload: McpReply) {
  if (res.destroyed || res.writableEnded) return false;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
  return true;
}

function replyToTool(call: PendingTool) {
  if (call.response && call.reply) respond(call.response, 200, call.reply);
}

function failToolCalls(run: ClaudeRun, text: string) {
  for (const call of run.calls.values()) {
    call.reply = { text, isError: true };
    replyToTool(call);
  }
}

function pendingTool(run: ClaudeRun, nativeId: string, name: string, args: any): PendingTool {
  const existing = run.calls.get(nativeId);
  if (existing) {
    if (existing.toolName !== name || !isDeepStrictEqual(existing.arguments, args)) {
      throw new Error(`Claude Code MCP call does not match tool use ${nativeId}`);
    }
    return existing;
  }
  const call: PendingTool = {
    nativeId, toolCallId: `claude_code_tool_${randomUUID().replaceAll("-", "")}`,
    toolName: name, arguments: args, declared: false, presented: false,
  };
  run.calls.set(nativeId, call);
  return call;
}

function receiveMcpCall(run: ClaudeRun, request: McpCall, response: ServerResponse) {
  if (run.closed || run.interrupted) {
    respond(response, 409, { text: "Claude Code run is no longer accepting tool calls", isError: true });
    return;
  }
  try {
    const call = pendingTool(run, request.toolUseId, request.name, request.arguments);
    if (call.response && !call.response.destroyed && !call.response.writableEnded) {
      respond(response, 409, { text: "Duplicate pending MCP request", isError: true });
      return;
    }
    call.response = response;
    const disconnected = () => {
      if (!response.writableEnded && !run.closed && !run.interrupted) void closeRun(run);
    };
    response.on("close", disconnected);
    response.on("error", disconnected);
    // Claude can dispatch a serial MCP request after Pi has already completed
    // the whole batch. Cache results until their native requests arrive.
    replyToTool(call);
  } catch (error) {
    respond(response, 400, { text: error instanceof Error ? error.message : String(error), isError: true });
    pushRunEvent(run, { type: "__error", error });
    void closeRun(run);
  }
}

async function ensureBroker(pi: ExtensionAPI, state: ProviderState): Promise<string> {
  if (state.broker) return state.broker.url;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || (req.url !== "/tool-call" && req.url !== "/tools-list")) {
      res.writeHead(404).end("not found");
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        if (req.url === "/tools-list") {
          const tools = activePiTools(pi).map((tool) => ({
            name: tool.name,
            description: `${tool.description}\n\nThis MCP tool requests pi to execute and display the real '${tool.name}' tool. The MCP call returns the actual tool result after pi finishes executing it.`,
            inputSchema: tool.parameters,
          }));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ tools }));
          return;
        }
        const call = JSON.parse(body || "{}");
        if (!activePiTools(pi).some((tool) => tool.name === call.name)) {
          respond(res, 400, { isError: true, text: `unknown or inactive pi tool: ${call.name}` });
          return;
        }
        if (typeof call.toolUseId !== "string" || !call.toolUseId) {
          respond(res, 400, { isError: true, text: "Claude Code did not provide an MCP tool-use ID" });
          return;
        }
        if (!state.activeRun) {
          respond(res, 409, { isError: true, text: "no active Claude Code provider turn is accepting MCP tool calls" });
          return;
        }
        receiveMcpCall(state.activeRun, { toolUseId: call.toolUseId, name: call.name, arguments: call.arguments ?? {} }, res);
      } catch (error) {
        respond(res, 500, { isError: true, text: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to start MCP broker");
  state.broker = { server, url: `http://host.docker.internal:${address.port}` };
  return state.broker.url;
}

function pushRunEvent(run: ClaudeRun, event: any) {
  const waiter = run.waiters.shift();
  if (waiter) waiter(event);
  else run.events.push(event);
}

function nextRunEvent(run: ClaudeRun): Promise<any> {
  const event = run.events.shift();
  if (event) return Promise.resolve(event);
  if (run.closed) return Promise.resolve({ type: "__closed", exitCode: run.exitCode });
  return new Promise((resolve) => run.waiters.push(resolve));
}

function finishInput(run: ClaudeRun) {
  if (run.inputEnded) return;
  run.inputEnded = true;
  run.child.stdin?.end();
}

function forceClose(run: ClaudeRun): Promise<void> {
  return run.forced ??= (async () => {
    // Killing the docker exec client alone does not stop its in-container process.
    run.child.kill("SIGTERM");
    await run.terminate();
    if (!run.closed) {
      // A wedged Docker client must not retain pipes or hold Pi open forever.
      run.child.kill("SIGKILL");
      run.rl.close();
      run.child.stdin?.destroy();
      run.child.stdout?.destroy();
      run.child.stderr?.destroy();
    }
  })();
}

function finishRun(run: ClaudeRun, state: ProviderState) {
  run.abortCleanup?.();
  run.abortCleanup = undefined;
  const cleanup = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run.whenClosed,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); }),
      ]);
      if (!run.closed) await forceClose(run);
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
  state.runCleanup = cleanup;
  void cleanup.finally(() => {
    if (state.runCleanup === cleanup) state.runCleanup = undefined;
  });
}

function closeRun(run: ClaudeRun): Promise<void> {
  if (run.stopping) return run.stopping;
  run.interrupted = true;
  run.abortCleanup?.();
  run.abortCleanup = undefined;
  run.stopping = (async () => {
    if (run.closed) {
      if (!run.sawResult && run.exitCode !== 0) await forceClose(run);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => { void forceClose(run).then(resolve); }, 3000);
    });
    try {
      if (run.inputEnded || !run.child.stdin?.writable) {
        await forceClose(run);
      } else {
        run.interruptRequestId = randomUUID();
        run.child.stdin.write(JSON.stringify({
          type: "control_request", request_id: run.interruptRequestId,
          request: { subtype: "interrupt" },
        }) + "\n");
      }
      await Promise.race([run.whenClosed, timeout]);
      await run.forced;
      if (run.closed && !run.sawResult && run.exitCode !== 0) await forceClose(run);
    } finally {
      if (timer) clearTimeout(timer);
      failToolCalls(run, "Claude Code run was interrupted");
      // Docker transport closure is not guaranteed, even after bounded removal.
      // Release the provider's pending read independently of child 'close'.
      if (!run.closed) pushRunEvent(run, { type: "__closed", exitCode: 1 });
    }
  })();
  return run.stopping;
}

function bindAbort(run: ClaudeRun, signal?: AbortSignal) {
  run.abortCleanup?.();
  const abort = () => { void closeRun(run); };
  signal?.addEventListener("abort", abort, { once: true });
  run.abortCleanup = () => signal?.removeEventListener("abort", abort);
  if (signal?.aborted) abort();
}

function continuationKey(model: any, context: any, reasoning: unknown): string {
  // Pi annotates the returned assistant with thinkingLevel after stream.result().
  // It is not a history edit and must not invalidate the live MCP continuation.
  const messages = context.messages.map((message: any) => {
    if (message.role !== "assistant") return message;
    const { thinkingLevel: _thinkingLevel, ...rest } = message;
    return rest;
  });
  return createHash("sha256").update(JSON.stringify({ model: [model.provider, model.api, model.id], reasoning,
    context: { ...context, messages } })).digest("hex");
}

function batchResults(batch: ToolBatch, model: any, context: any, reasoning: unknown) {
  const tail = context.messages.slice(-batch.calls.length);
  if (tail.length !== batch.calls.length || tail.some((message: any) => message.role !== "toolResult")) return undefined;
  const results = new Map<string, any>(tail.map((message: any) => [message.toolCallId, message]));
  if (results.size !== batch.calls.length || batch.calls.some((call) => !results.has(call.toolCallId))) return undefined;
  const prefix = { ...context, messages: context.messages.slice(0, -batch.calls.length) };
  return batch.continuationKey === continuationKey(model, prefix, reasoning) ? results : undefined;
}

function startClaudeRun(containerId: string, args: string[], seed: ReturnType<typeof createClaudeSession>, env: NodeJS.ProcessEnv, state: ProviderState): ClaudeRun {
  const container = state.containerReady;
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], env });
  const rl = createInterface({ input: child.stdout });
  let resolveClosed!: () => void;
  const whenClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const run: ClaudeRun = {
    child, rl, stderr: "", events: [], waiters: [], calls: new Map(), batch: [],
    closed: false, sawResult: false, inputEnded: false, interrupted: false, whenClosed,
    terminate: async () => {
      if (state.containerReady === container) state.containerReady = undefined;
      await runProcess("docker", ["rm", "-f", containerId], undefined, env, 3000).catch(() => undefined);
    },
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (run.stderr += String(chunk)));
  child.on("error", (error) => pushRunEvent(run, { type: "__error", error }));
  child.stdin.on("error", (error) => {
    if (!run.interrupted && !run.sawResult) pushRunEvent(run, { type: "__error", error });
  });
  child.on("close", (code) => {
    run.closed = true;
    run.exitCode = code ?? 1;
    run.abortCleanup?.();
    run.abortCleanup = undefined;
    failToolCalls(run, "Claude Code run closed before the tool result was delivered");
    pushRunEvent(run, { type: "__closed", exitCode: run.exitCode });
    resolveClosed();
  });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "control_response" && event.response?.request_id === run.interruptRequestId) {
        if (event.response.subtype === "success") {
          // Wait for Claude to acknowledge cancellation before releasing tools,
          // so their replies cannot accidentally trigger another model request.
          failToolCalls(run, "Interrupted by Pi");
          finishInput(run);
        } else {
          void forceClose(run);
        }
      }
      if (event.type === "result" && !run.sawResult) {
        run.sawResult = true;
        finishInput(run);
        finishRun(run, state);
      }
      pushRunEvent(run, event);
    } catch {
      pushRunEvent(run, { type: "__text", text: `${line}\n` });
    }
  });
  state.activeRun = run;
  // The launcher consumes one seed line, then relays subsequent control frames.
  // Keep stdin open through tool calls; the terminal result closes it.
  child.stdin.write(JSON.stringify(seed) + "\n");
  return run;
}

function renderClaudeCodeSystemPrompt(context: any, tools: any[]): string {
  const parts = [CLAUDE_CODE_SYSTEM_PROMPT, context?.systemPrompt];
  if (tools.length > 0) {
    const toolList = tools.map((tool) => `- ${mcpToolName(tool.name)}: ${tool.description ?? "workspace tool"}`).join("\n");
    parts.push(`Available tools:\n${toolList}\n\nUse these as your normal tools for this pi session. They provide the files, commands, VMs, and session state available in the current workspace. If the user asks about access to a path, check with the tools rather than guessing.`);
  }
  return parts.filter((part) => typeof part === "string" && part.trim()).join("\n\n");
}

function usageFromRaw(raw: any, model: any) {
  const usage = emptyUsage();
  if (!raw) return usage;
  usage.input = Number(raw.input_tokens ?? 0);
  usage.output = Number(raw.output_tokens ?? 0);
  usage.cacheRead = Number(raw.cache_read_input_tokens ?? 0);
  usage.cacheWrite = Number(raw.cache_creation_input_tokens ?? 0);
  (usage as any).cacheWrite1h = Number(raw.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const reasoning = raw.output_tokens_details?.thinking_tokens;
  if (reasoning != null) (usage as any).reasoning = Number(reasoning);
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  calculateCost(model, usage);
  return usage;
}

function usageFromResultEvent(event: any, model: any) {
  // The top-level usage is cumulative for the CLI run; Pi needs the terminal request.
  const iterations = event?.usage?.iterations;
  const terminal = Array.isArray(iterations) && iterations.length > 0 ? iterations[iterations.length - 1] : undefined;
  return usageFromRaw(terminal ?? event?.usage, model);
}

function claudeEventErrorDetails(event: any): unknown[] {
  const details: unknown[] = [event.errorDetails, event.message?.errorDetails];
  if (event.type === "assistant" && (event.is_api_error_message || event.isApiErrorMessage || event.error)) {
    const blocks = event.message?.content;
    details.push(typeof blocks === "string" ? blocks
      : Array.isArray(blocks) ? blocks.filter((block: any) => block.type === "text").map((block: any) => block.text) : undefined);
    if (typeof event.error === "string") details.push(`Claude error type: ${event.error}`);
    if (typeof event.request_id === "string") details.push(`Claude request ID: ${event.request_id}`);
  }
  if (event.type === "error") details.push(event.error, event.message);
  if (event.type === "stream_event") {
    const native = event.event ?? event.stream_event;
    if (native?.type === "error") details.push(native.error, native.message);
  }
  if (event.type === "system" && event.subtype === "status" && event.compact_result === "failed") {
    details.push(`Claude compaction failed: ${claudeErrorMessage(event.compact_error) || "unspecified"}`);
  }
  if (event.type === "result") {
    details.push(event.errors);
    if (event.is_error) {
      if (typeof event.terminal_reason === "string") details.push(`Claude terminal reason: ${event.terminal_reason}`);
      if (typeof event.api_error_status === "number") details.push(`Claude API status: ${event.api_error_status}`);
    }
  }
  return details;
}

function stopReasonFrom(event: any): "stop" | "length" | "toolUse" | "error" {
  const reason = event?.stop_reason ?? event?.message?.stop_reason ?? event?.terminal_reason;
  if (event?.is_error || event?.error || reason === "api_error") return "error";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "toolUse";
  return "stop";
}

function claudeCodeEffort(reasoning: unknown): string | undefined {
  return typeof reasoning === "string" && ["low", "medium", "high", "xhigh", "max"].includes(reasoning) ? reasoning : undefined;
}

export default async function (pi: ExtensionAPI) {
  const preserveAbortDetails = registerAbortDetails(pi);
  // Independent requests (summaries/evaluators) must not steal a live CLI.
  // Agent tool turns share one signal, preserving their MCP continuation.
  const owners = new WeakMap<AbortSignal, ProviderState>();
  const states = new Set<ProviderState>();
  const retiring = new Set<Promise<void>>();
  const retired = new WeakMap<ProviderState, Promise<void>>();
  const ownerCleanup = new WeakMap<ProviderState, () => void>();
  const inflight = new WeakMap<ProviderState, number>();
  const idleWaiters = new WeakMap<ProviderState, Array<() => void>>();
  let shuttingDown = false;
  function checkRunning() {
    if (shuttingDown) throw new Error("Claude Code provider is shutting down");
  }
  function waitForRequests(state: ProviderState): Promise<void> {
    if (!inflight.get(state)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = idleWaiters.get(state) ?? [];
      waiters.push(resolve);
      idleWaiters.set(state, waiters);
    });
  }
  function acquire(signal?: AbortSignal): ProviderState {
    const previous = signal && owners.get(signal);
    if (previous) return previous;
    const state: ProviderState = {};
    states.add(state);
    if (signal) {
      owners.set(signal, state);
      const abort = () => {
        void (async () => {
          if (state.activeRun) await closeRun(state.activeRun);
          // A startup may still be creating its container/broker. Its finally
          // retires after creation settles; do not race cleanup against startup.
          if (!inflight.get(state)) await retire(state, signal);
        })().catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      ownerCleanup.set(state, () => signal.removeEventListener("abort", abort));
    }
    return state;
  }
  function retire(state: ProviderState, signal?: AbortSignal) {
    const previous = retired.get(state);
    if (previous) return previous;
    if (signal && owners.get(signal) === state) owners.delete(signal);
    ownerCleanup.get(state)?.();
    ownerCleanup.delete(state);
    states.delete(state);
    const cleanup = (async () => {
      await state.runCleanup;
      await removeContainer(state);
      state.broker?.server.close();
      state.broker = undefined;
    })();
    retired.set(state, cleanup);
    retiring.add(cleanup);
    void cleanup.finally(() => retiring.delete(cleanup)).catch(() => undefined);
    return cleanup;
  }
  let updating = false;
  pi.registerCommand("claude", {
    getArgumentCompletions: (prefix) => ["update"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    description: "Update the Claude Code Docker image (/claude update)",
    handler: async (args, ctx) => {
      if (args.trim() !== "update") {
        ctx.ui.notify("Usage: /claude update", "info");
        return;
      }
      if (updating) {
        ctx.ui.notify("Claude Code update is already running.", "info");
        return;
      }
      updating = true;
      ctx.ui.notify("Updating Claude Code…", "info");
      try {
        await imageReady?.catch(() => undefined);
        await buildImage(true);
        imageReady = Promise.resolve();
        // Do not interrupt a live tool exchange. ensureContainer is only called
        // when starting a fresh Claude run, never when resuming a tool batch.
        for (const state of states) state.containerNeedsRefresh = true;
        ctx.ui.notify("Claude Code updated. The next fresh Claude run will use the new image.", "info");
      } catch (error) {
        ctx.ui.notify(`Claude Code update failed; any existing image is unchanged.\n${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        updating = false;
      }
    },
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    await Promise.all([...states].map(async (state) => {
      if (state.activeRun) await closeRun(state.activeRun);
      // Startup checks below stop new processes; let pending container/broker
      // creation settle before retirement so no resource can appear afterward.
      await waitForRequests(state);
      state.activeRun = undefined;
      await retire(state);
    }));
    await Promise.all([...retiring]);
  });

  // Register from Pi's configured/cached catalog before startup resolves models.
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const anthropicModels = modelRuntime.getModels("anthropic");
  if (anthropicModels.length === 0) throw new Error("Claude Code provider could not find pi's built-in Anthropic models");
  pi.registerProvider(PROVIDER_ID, {
    name: "Claude Code (Docker)",
    baseUrl: "docker://claude-code",
    apiKey: "$CLAUDE_CODE_OAUTH_TOKEN",
    api: "claude-code-docker" as any,
    models: claudeCodeModelsFromPi(anthropicModels),
    streamSimple(model: any, context: any, options?: any) {
      const state = acquire(options?.signal);
      inflight.set(state, (inflight.get(state) ?? 0) + 1);
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const output: any = {
          role: "assistant", content: [], api: model.api, provider: model.provider ?? PROVIDER_ID,
          model: model.id, usage: emptyUsage(), stopReason: "pending", timestamp: Date.now(),
        };
        const content = new ClaudeOutput(output, stream);
        let run: ClaudeRun | undefined;
        let resultEvent: any;
        const errorDetails: unknown[] = [];
        let sawClaudeError = false;
        let claudeStatus: string | undefined;
        let fallbackText = "";
        try {
          stream.push({ type: "start", partial: output });
          checkRunning();
          options?.signal?.throwIfAborted();
          const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
          if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set in pi's environment");

          const previous = state.activeRun;
          if (previous) {
            const batch = previous.awaiting;
            const results = batch && !previous.closed && !previous.sawResult && !previous.interrupted
              ? batchResults(batch, model, context, options?.reasoning) : undefined;
            if (batch && results) {
              run = previous;
              run.awaiting = undefined;
              bindAbort(run, options?.signal);
              options?.signal?.throwIfAborted();
              // Set every result before releasing any request. MCP dispatch may
              // be concurrent or serial; both use the same per-tool ID mapping.
              for (const call of batch.calls) {
                const result = results.get(call.toolCallId)!;
                call.reply = { content: toMcpContent(result.content, model.input.includes("image")), isError: result.isError };
              }
              for (const call of batch.calls) replyToTool(call);
            } else {
              // Steering, compaction, and model changes use Pi's new history.
              await closeRun(previous);
              if (state.activeRun === previous) state.activeRun = undefined;
            }
          }
          if (!run) {
            options?.signal?.throwIfAborted();
            const seed = createClaudeSession(context, model, mcpToolName);
            const containerId = await ensureContainer(state);
            checkRunning();
            options?.signal?.throwIfAborted();
            const brokerUrl = await ensureBroker(pi, state);
            checkRunning();
            options?.signal?.throwIfAborted();
            const tools = activePiTools(pi);
            const args = [
              "exec", "-i", "-e", "CLAUDE_CODE_OAUTH_TOKEN", "-e", "PI_MCP_BROKER_URL",
              // Pi owns compaction and the history used to seed future runs.
              // Native compaction would report usage for a summary Pi never received.
              "-e", "DISABLE_COMPACT=1",
              containerId, "/usr/local/bin/claude-with-pi-mcp", "-p",
              "--input-format", "stream-json", "--output-format", "stream-json",
              "--verbose", "--include-partial-messages", "--strict-mcp-config", "--tools", "",
              "--allowedTools", tools.map((tool) => mcpToolName(tool.name)).join(","),
              "--permission-mode", "acceptEdits", "--disable-slash-commands",
              "--system-prompt", renderClaudeCodeSystemPrompt(context, tools),
              "--no-session-persistence", "--model", model.id,
            ];
            const effort = claudeCodeEffort(options?.reasoning);
            if (effort) args.push("--effort", effort);
            run = startClaudeRun(containerId, args, seed, {
              ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, PI_MCP_BROKER_URL: brokerUrl,
            }, state);
            bindAbort(run, options?.signal);
          }

          while (true) {
            const event = await nextRunEvent(run);
            errorDetails.push(...claudeEventErrorDetails(event));
            const native = event.type === "stream_event" ? event.event ?? event.stream_event : undefined;
            if (event.type === "error" || native?.type === "error"
                || (event.type === "assistant" && (event.is_api_error_message || event.isApiErrorMessage || event.error))) sawClaudeError = true;
            if (event.type === "system" && event.subtype === "status") claudeStatus = typeof event.status === "string" ? event.status : undefined;
            if (event.type === "__error") throw event.error;
            if (event.type === "__text") {
              fallbackText += event.text;
            } else if (event.type === "system" && event.subtype === "thinking_tokens") {
              content.handleThinkingTokens(event.estimated_tokens);
            } else if (event.type === "stream_event") {
              const native = event.event ?? event.stream_event ?? event;
              if (native.type === "message_start") {
                if (!run.interrupted && run.batch.some((call) => call.presented && !call.response?.writableEnded)) {
                  throw new Error("Claude Code continued before receiving all Pi tool results");
                }
                run.batch = [];
              }
              content.handleStreamEvent(native);
              if (native.type === "message_stop" && !run.interrupted) {
                const calls = run.batch.filter((call) => !call.presented);
                if (calls.length > 0) {
                  content.finish();
                  output.stopReason = "toolUse";
                  for (const call of calls) call.presented = true;
                  run.awaiting = {
                    calls,
                    continuationKey: continuationKey(model, { ...context, messages: [...context.messages, output] }, options?.reasoning),
                  };
                  stream.push({ type: "done", reason: "toolUse", message: output });
                  stream.end();
                  // Keep the abort binding alive while Pi executes the tools.
                  return;
                }
              }
            } else if (event.type === "assistant") {
              if (event.message?.usage) output.usage = usageFromRaw(event.message.usage, model);
              content.handleAssistantMessage(event.message);
              if (!run.interrupted) {
                for (const block of event.message?.content ?? []) {
                  if (block.type !== "tool_use" || typeof block.name !== "string" || !block.name.startsWith(MCP_TOOL_PREFIX)) continue;
                  const name = block.name.slice(MCP_TOOL_PREFIX.length);
                  if (!pi.getActiveTools().includes(name)) continue;
                  const call = pendingTool(run, block.id, name, block.input ?? {});
                  if (call.declared) continue;
                  call.declared = true;
                  run.batch.push(call);
                  const toolCall = { type: "toolCall" as const, id: call.toolCallId, name: call.toolName, arguments: call.arguments };
                  const contentIndex = output.content.length;
                  output.content.push(toolCall);
                  stream.push({ type: "toolcall_start", contentIndex, partial: output });
                  stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
                  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
                }
              }
            } else if (event.type === "result") {
              resultEvent = event;
              output.usage = usageFromResultEvent(event, model);
              if (typeof event.result === "string") fallbackText = event.result;
              break;
            } else if (event.type === "__closed") {
              break;
            }
          }

          if (state.activeRun === run) state.activeRun = undefined;
          if (fallbackText && !output.content.some((block: any) => block.type === "text" && block.text)) content.appendText(fallbackText);
          content.finish();
          output.stopReason = run.interrupted || (!resultEvent && options?.signal?.aborted)
            ? "aborted" : resultEvent ? stopReasonFrom(resultEvent) : !sawClaudeError && run.exitCode === 0 ? "stop" : "error";
          if (output.stopReason === "error" || output.stopReason === "aborted") {
            if (!run.sawResult) await closeRun(run);
            output.errorMessage = claudeErrorMessage(
              output.stopReason === "aborted" ? "Claude Code was interrupted" : undefined,
              resultEvent?.result, resultEvent?.error, ...errorDetails,
              claudeStatus ? `Last Claude status: ${claudeStatus}` : undefined,
              run.stderr,
              options?.signal?.aborted ? options.signal.reason : undefined,
            ) || `docker/claude exited with code ${run.exitCode}`;
            preserveAbortDetails(output);
            stream.push({ type: "error", reason: output.stopReason, error: output });
          } else {
            stream.push({ type: "done", reason: output.stopReason, message: output });
          }
          stream.end();
        } catch (error) {
          if (run) {
            await closeRun(run);
            if (state.activeRun === run) state.activeRun = undefined;
          }
          content.finish();
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = claudeErrorMessage(error,
            resultEvent?.result, resultEvent?.error, ...errorDetails,
            claudeStatus ? `Last Claude status: ${claudeStatus}` : undefined, run?.stderr,
            options?.signal?.aborted ? options.signal.reason : undefined) || String(error);
          preserveAbortDetails(output);
          stream.push({ type: "error", reason: output.stopReason, error: output });
          stream.end();
        } finally {
          // Without an owner signal a later call cannot identify this live MCP
          // continuation. Return its toolUse but close the orphaned transport;
          // the next independent call will reseed from its supplied history.
          if (!options?.signal && state.activeRun) {
            await closeRun(state.activeRun);
            state.activeRun = undefined;
          }
          // A yielded MCP batch owns its process until the next same-signal turn.
          // Terminal attempts release containers even if the owner never aborts.
          inflight.set(state, (inflight.get(state) ?? 1) - 1);
          if (!inflight.get(state)) {
            for (const resolve of idleWaiters.get(state) ?? []) resolve();
            idleWaiters.delete(state);
          }
          if (!inflight.get(state) && (!state.activeRun || options?.signal?.aborted || shuttingDown)) {
            await retire(state, options?.signal);
          }
        }
      })();
      return stream;
    },
  } as any);
}
