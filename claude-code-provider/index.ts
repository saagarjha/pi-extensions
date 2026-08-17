import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const PROVIDER_ID = "claude-code";
const IMAGE = process.env.PI_CLAUDE_CODE_IMAGE || "pi-claude-code-runner:latest";
const MCP_SERVER_NAME = process.env.PI_CLAUDE_CODE_MCP_SERVER || "session";
const mcpToolName = (toolName: string) => `mcp__${MCP_SERVER_NAME}__${toolName}`;
const CLAUDE_CODE_SYSTEM_PROMPT = `You are operating inside pi, a coding agent harness.

Use the available tools as your normal workspace tools for this session. They provide access to the files, commands, VMs, and session state that pi has made available. When asked about access to a path, check with the tools rather than guessing.`;

function claudeCodeModelsFromPi(anthropicModels: any[]) {
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
    // This provider uses Claude Code subscription auth, not Anthropic API billing.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // The current Docker bridge only serializes text. Do not advertise images until we explicitly support them.
    input: ["text"],
    name: `${model.name ?? model.id} via Claude Code`,
  }));
}

const DOCKERFILE = `FROM ubuntu:latest
RUN apt-get update
RUN apt-get install -y ca-certificates curl python3
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN cat > /usr/local/bin/pi-mcp-bridge <<'PY'
#!/usr/bin/env python3
import json, os, sys, urllib.request

BROKER_URL = os.environ.get('PI_MCP_BROKER_URL', '')

def read_message():
    # Claude Code's MCP stdio transport uses newline-delimited JSON-RPC.
    # Also tolerate Content-Length framing for easier standalone testing.
    first = sys.stdin.buffer.readline()
    if not first:
        return None
    stripped = first.strip()
    if stripped.startswith(b'{'):
        return json.loads(stripped.decode('utf-8'))

    headers = {}
    line = first.decode('ascii', 'replace').strip()
    if ':' in line:
        k, v = line.split(':', 1)
        headers[k.lower()] = v.strip()
    while True:
        line_bytes = sys.stdin.buffer.readline()
        if not line_bytes:
            return None
        line = line_bytes.decode('ascii', 'replace').strip()
        if line == '':
            break
        if ':' in line:
            k, v = line.split(':', 1)
            headers[k.lower()] = v.strip()
    length = int(headers.get('content-length', '0'))
    if length <= 0:
        return None
    return json.loads(sys.stdin.buffer.read(length).decode('utf-8'))

def send_message(message):
    sys.stdout.write(json.dumps(message, separators=(',', ':')) + '\\n')
    sys.stdout.flush()

def result(request, value):
    send_message({'jsonrpc': '2.0', 'id': request.get('id'), 'result': value})

def error(request, code, message):
    send_message({'jsonrpc': '2.0', 'id': request.get('id'), 'error': {'code': code, 'message': message}})

def broker_post(path, payload):
    if not BROKER_URL:
        raise RuntimeError('PI_MCP_BROKER_URL is not set')
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(BROKER_URL.rstrip('/') + path, data=data, headers={'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=None) as resp:
        return json.loads(resp.read().decode('utf-8'))

def call_broker(name, arguments):
    return broker_post('/tool-call', {'name': name, 'arguments': arguments or {}})

def list_tools():
    return broker_post('/tools-list', {})

while True:
    msg = read_message()
    if msg is None:
        break
    method = msg.get('method')
    if method == 'initialize':
        result(msg, {'protocolVersion': msg.get('params', {}).get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {'listChanged': False}}, 'serverInfo': {'name': 'pi-mcp-bridge', 'version': '0.0.1'}})
    elif method == 'tools/list':
        result(msg, {'tools': list_tools().get('tools', [])})
    elif method == 'tools/call':
        params = msg.get('params') or {}
        try:
            broker = call_broker(params.get('name'), params.get('arguments') or {})
            result(msg, {'content': [{'type': 'text', 'text': broker.get('text', '')}], 'isError': bool(broker.get('isError'))})
        except Exception as e:
            result(msg, {'content': [{'type': 'text', 'text': 'MCP bridge error: ' + str(e)}], 'isError': True})
    elif 'id' in msg:
        error(msg, -32601, 'method not found')
PY
RUN chmod +x /usr/local/bin/pi-mcp-bridge
RUN cat > /usr/local/bin/claude-with-pi-mcp <<'SH'
#!/bin/sh
set -eu
cat > /tmp/pi-mcp.json <<EOF
{"mcpServers":{"${MCP_SERVER_NAME}":{"command":"/usr/local/bin/pi-mcp-bridge","env":{"PI_MCP_BROKER_URL":"\${PI_MCP_BROKER_URL:-}"}}}}
EOF
exec /root/.local/bin/claude --mcp-config /tmp/pi-mcp.json "$@"
SH
RUN chmod +x /usr/local/bin/claude-with-pi-mcp
ENTRYPOINT ["/usr/local/bin/claude-with-pi-mcp"]
`;

type ClaudeRun = {
  child: ChildProcess;
  rl: ReadlineInterface;
  stderr: string;
  events: any[];
  waiters: Array<(event: any) => void>;
  closed: boolean;
  exitCode?: number;
  onMcpToolCall?: (call: { name: string; arguments: any }, res: ServerResponse) => void;
};

type PendingMcpToolCall = {
  run: ClaudeRun;
  response: ServerResponse;
  toolCallId: string;
  toolName: string;
  arguments: any;
};

type ProviderState = {
  broker?: { server: Server; url: string };
  activeRun?: ClaudeRun;
  pendingMcpToolCall?: PendingMcpToolCall;
  containerReady?: Promise<string>;
};

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function runProcess(command: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

let imageReady: Promise<void> | undefined;

async function ensureImage(): Promise<string> {
  if (!imageReady) {
    imageReady = (async () => {
      // Always run docker build once per pi process. Docker reuses cached layers, but this
      // keeps the stable tag pointed at the current inline Dockerfile while we iterate.
      const build = await runProcess("docker", ["build", "-t", IMAGE, "-"], DOCKERFILE);
      if (build.code !== 0) {
        throw new Error(`Failed to build ${IMAGE}:\n${build.stderr || build.stdout}`);
      }
    })();
  }
  await imageReady;
  return IMAGE;
}

async function ensureContainer(state: ProviderState): Promise<string> {
  if (!state.containerReady) {
    state.containerReady = (async () => {
      const image = await ensureImage();
      const created = await runProcess("docker", [
        "create",
        "-i",
        "--entrypoint",
        "sleep",
        image,
        "infinity",
      ]);
      if (created.code !== 0) {
        throw new Error(`Failed to create Claude Code Docker container:\n${created.stderr || created.stdout}`);
      }
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
  if (!state.containerReady) return;
  const id = await state.containerReady.catch(() => undefined);
  state.containerReady = undefined;
  if (id) await runProcess("docker", ["rm", "-f", id]).catch(() => undefined);
}

function activePiTools(pi: ExtensionAPI) {
  const active = new Set(pi.getActiveTools());
  return pi.getAllTools()
    .filter((tool: any) => active.has(tool.name))
    .map((tool: any) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
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
        const tools = activePiTools(pi);
        if (!tools.some((tool) => tool.name === call.name)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ isError: true, text: `unknown or inactive pi tool: ${call.name}` }));
          return;
        }
        if (!state.activeRun?.onMcpToolCall) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ isError: true, text: "no active Claude Code provider turn is accepting MCP tool calls" }));
          return;
        }
        state.activeRun.onMcpToolCall({ name: call.name, arguments: call.arguments ?? {} }, res);
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ isError: true, text: error instanceof Error ? error.message : String(error) }));
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

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);

  return content
    .map((block: any) => {
      if (!block) return "";
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking") return `<thinking>\n${block.thinking ?? block.text ?? ""}\n</thinking>`;
      if (block.type === "toolCall") return `[tool call: ${block.name ?? "unknown"} ${JSON.stringify(block.arguments ?? {})}]`;
      if (block.type === "image") return "[image]";
      return block.text ?? JSON.stringify(block);
    })
    .filter(Boolean)
    .join("\n");
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

function closeRun(run: ClaudeRun) {
  run.onMcpToolCall = undefined;
  run.rl.close();
  if (!run.closed) run.child.kill("SIGTERM");
}

function clearPendingMcpToolCall(state: ProviderState, pending: PendingMcpToolCall) {
  if (state.pendingMcpToolCall === pending) state.pendingMcpToolCall = undefined;
}

function endMcpResponse(pending: PendingMcpToolCall, status: number, payload: { text: string; isError?: boolean }) {
  const res = pending.response;
  if (res.destroyed || res.writableEnded) return false;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
  return true;
}

function findPendingToolResult(context: any, pending: PendingMcpToolCall): string | undefined {
  const messages = context?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "toolResult") continue;
    if (message.toolCallId && message.toolCallId !== pending.toolCallId) continue;
    return textFromContent(message.content);
  }
  return undefined;
}

function startClaudeRun(args: string[], input: string, env: NodeJS.ProcessEnv, state: ProviderState): ClaudeRun {
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], env });
  const rl = createInterface({ input: child.stdout });
  const run: ClaudeRun = { child, rl, stderr: "", events: [], waiters: [], closed: false };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (run.stderr += String(chunk)));
  child.on("error", (error) => pushRunEvent(run, { type: "__error", error }));
  child.on("close", (code) => {
    run.closed = true;
    run.exitCode = code ?? 1;
    pushRunEvent(run, { type: "__closed", exitCode: run.exitCode });
  });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      pushRunEvent(run, JSON.parse(line));
    } catch {
      pushRunEvent(run, { type: "__text", text: `${line}\n` });
    }
  });
  child.stdin.end(input);
  state.activeRun = run;
  return run;
}

function renderClaudeCodeSystemPrompt(context: any): string {
  return [CLAUDE_CODE_SYSTEM_PROMPT, context?.systemPrompt].filter((part) => typeof part === "string" && part.trim()).join("\n\n");
}

function renderContext(context: any, tools: any[]): string {
  const parts: string[] = [];

  if (tools.length > 0) {
    const toolList = tools
      .map((tool) => `- ${mcpToolName(tool.name)}: ${tool.description ?? "workspace tool"}`)
      .join("\n");
    parts.push(`Available tools:\n${toolList}\n\nUse these as your normal tools for this pi session. They provide the files, commands, VMs, and session state available in the current workspace. If the user asks about access to a path, check with the tools rather than guessing.`);
  }

  for (const message of context?.messages ?? []) {
    const role = message.role ?? "message";
    const text = textFromContent(message.content);
    if (!text.trim()) continue;

    if (role === "toolResult") {
      const attrs = [
        message.toolCallId ? ` toolCallId=${JSON.stringify(message.toolCallId)}` : "",
        message.toolName ? ` toolName=${JSON.stringify(message.toolName)}` : "",
        message.isError ? " isError=\"true\"" : "",
      ].join("");
      parts.push(`<toolResult${attrs}>\n${text}\n</toolResult>`);
      continue;
    }

    parts.push(`<${role}>\n${text}\n</${role}>`);
  }

  return parts.join("\n\n");
}

function parseSyntheticToolCall(text: string): { name: string; arguments: any } | undefined {
  const match = text.match(/<pi-tool-call>\s*([\s\S]*?)\s*<\/pi-tool-call>/);
  if (!match) return undefined;
  const parsed = JSON.parse(match[1] ?? "");
  if (!parsed || typeof parsed.name !== "string" || typeof parsed.arguments !== "object" || parsed.arguments === null) {
    throw new Error("Invalid <pi-tool-call>: expected { name: string, arguments: object }");
  }
  return { name: parsed.name, arguments: parsed.arguments };
}

function assistantBlocks(event: any): any[] {
  if (event?.type !== "assistant") return [];
  const content = event.message?.content;
  return Array.isArray(content) ? content : [];
}

function usageFromRaw(raw: any) {
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
  return usage;
}

function usageFromAssistantEvent(event: any) {
  return usageFromRaw(event?.message?.usage);
}

function usageFromResultEvent(event: any) {
  // Claude Code top-level result.usage is cumulative billing/processing usage for
  // the whole CLI run. pi's assistant usage is context-prefix accounting, so use
  // the terminal model request when Claude exposes it instead of summing turns.
  const iterations = event?.usage?.iterations;
  const terminal = Array.isArray(iterations) && iterations.length > 0 ? iterations[iterations.length - 1] : undefined;
  return usageFromRaw(terminal ?? event?.usage);
}

function stopReasonFrom(event: any): "stop" | "length" | "toolUse" | "error" {
  const reason = event?.stop_reason ?? event?.message?.stop_reason ?? event?.terminal_reason;
  if (event?.is_error || event?.error || reason === "api_error") return "error";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "toolUse";
  return "stop";
}

function claudeCodeEffort(reasoning: unknown): string | undefined {
  if (typeof reasoning !== "string") return undefined;
  if (reasoning === "off" || reasoning === "minimal") return undefined;
  if (["low", "medium", "high", "xhigh", "max"].includes(reasoning)) return reasoning;
  return undefined;
}

function toolCallId() {
  return `claude_code_tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function (pi: ExtensionAPI) {
  const state: ProviderState = {};

  pi.on("session_shutdown", () => {
    if (state.pendingMcpToolCall) {
      endMcpResponse(state.pendingMcpToolCall, 500, { isError: true, text: "pi session shut down before the tool result was available" });
      state.pendingMcpToolCall = undefined;
    }
    if (state.activeRun) {
      closeRun(state.activeRun);
      state.activeRun = undefined;
    }
    void removeContainer(state);
    state.broker?.server.close();
    state.broker = undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    const anthropicModels = ctx.modelRegistry.getAll().filter((model: any) => model.provider === "anthropic");
    if (anthropicModels.length === 0) {
      throw new Error("Claude Code provider could not find pi's built-in Anthropic models");
    }

    pi.registerProvider(PROVIDER_ID, {
      name: "Claude Code (Docker)",
      baseUrl: "docker://claude-code",
      // Makes pi's normal model availability check depend on the same env var the Docker runner uses.
      apiKey: "$CLAUDE_CODE_OAUTH_TOKEN",
      api: "claude-code-docker" as any,
      models: claudeCodeModelsFromPi(anthropicModels),

      streamSimple(model: any, context: any, options?: any) {
      const stream = createAssistantMessageEventStream();

      void (async () => {
        const output: any = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider ?? PROVIDER_ID,
          model: model.id,
          usage: emptyUsage(),
          stopReason: "pending",
          timestamp: Date.now(),
        };

        let run: ClaudeRun | undefined;
        let lastText = "";
        let resultEvent: any;
        let contentIndex = -1;
        let sawPartialText = false;

        const ensureText = () => {
          if (contentIndex >= 0) return contentIndex;
          contentIndex = output.content.length;
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex, partial: output });
          return contentIndex;
        };

        const append = (delta: string) => {
          if (!delta) return;
          const idx = ensureText();
          output.content[idx].text += delta;
          stream.push({ type: "text_delta", contentIndex: idx, delta, partial: output });
        };

        const appendThinking = (thinking: string, signature?: string) => {
          if (!thinking) return;
          const idx = output.content.length;
          output.content.push({ type: "thinking", thinking: "", ...(signature ? { thinkingSignature: signature } : {}) });
          stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
          output.content[idx].thinking = thinking;
          stream.push({ type: "thinking_delta", contentIndex: idx, delta: thinking, partial: output });
          stream.push({ type: "thinking_end", contentIndex: idx, content: thinking, partial: output });
        };

        try {
          stream.push({ type: "start", partial: output });

          const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
          if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set in pi's environment");

          if (state.pendingMcpToolCall) {
            const result = findPendingToolResult(context, state.pendingMcpToolCall);
            run = state.pendingMcpToolCall.run;
            if (result === undefined) {
              endMcpResponse(state.pendingMcpToolCall, 500, { isError: true, text: "pi resumed without the expected tool result" });
              state.pendingMcpToolCall = undefined;
              closeRun(run);
              state.activeRun = undefined;
              throw new Error("Claude Code MCP bridge expected a tool result, but none was found in pi context");
            }
            endMcpResponse(state.pendingMcpToolCall, 200, { text: result });
            state.pendingMcpToolCall = undefined;
          } else {
            const containerId = await ensureContainer(state);
            const brokerUrl = await ensureBroker(pi, state);
            const tools = activePiTools(pi);

            const args = [
              "exec",
              "-i",
              "-e",
              "CLAUDE_CODE_OAUTH_TOKEN",
              "-e",
              "PI_MCP_BROKER_URL",
              containerId,
              "/usr/local/bin/claude-with-pi-mcp",
              "-p",
              "--output-format",
              "stream-json",
              "--verbose",
              "--include-partial-messages",
              "--strict-mcp-config",
              "--tools",
              "",
              "--allowedTools",
              tools.map((tool) => mcpToolName(tool.name)).join(","),
              "--permission-mode",
              "acceptEdits",
              "--disable-slash-commands",
              "--system-prompt",
              renderClaudeCodeSystemPrompt(context),
              "--no-session-persistence",
            ];

            args.push("--model", model.id);

            const effort = claudeCodeEffort(options?.reasoning);
            if (effort) args.push("--effort", effort);

            run = startClaudeRun(args, renderContext(context, tools), {
              PATH: process.env.PATH,
              CLAUDE_CODE_OAUTH_TOKEN: token,
              PI_MCP_BROKER_URL: brokerUrl,
            }, state);
          }

          const abort = () => run && closeRun(run);
          options?.signal?.addEventListener?.("abort", abort, { once: true });

          run.onMcpToolCall = (call, response) => {
            const id = toolCallId();
            const pending: PendingMcpToolCall = { run: run!, response, toolCallId: id, toolName: call.name, arguments: call.arguments };
            state.pendingMcpToolCall = pending;

            const abortPending = () => {
              clearPendingMcpToolCall(state, pending);
              closeRun(pending.run);
              if (state.activeRun === pending.run) state.activeRun = undefined;
            };
            response.on("close", () => {
              if (!response.writableEnded) abortPending();
            });
            response.on("error", abortPending);

            pushRunEvent(run!, { type: "__mcp_tool_call", toolCallId: id, toolName: call.name, arguments: call.arguments });
          };

          while (true) {
            const event = await nextRunEvent(run);
            if (event.type === "__text") {
              lastText += event.text;
              continue;
            }
            if (event.type === "__error") {
              throw event.error;
            }
            if (event.type === "stream_event") {
              const streamEvent = event.event ?? event.stream_event ?? event;
              if (streamEvent.type === "content_block_start" && streamEvent.content_block?.type === "text") {
                ensureText();
                sawPartialText = true;
              } else if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
                sawPartialText = true;
                append(streamEvent.delta.text ?? "");
              }
              continue;
            }
            if (event.type === "__mcp_tool_call") {
              const idx = output.content.length;
              const toolCall = { type: "toolCall" as const, id: event.toolCallId, name: event.toolName, arguments: event.arguments };
              const delta = JSON.stringify(event.arguments);
              output.content.push(toolCall);
              output.stopReason = "toolUse";
              stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
              stream.push({ type: "toolcall_delta", contentIndex: idx, delta, partial: output });
              stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
              stream.push({ type: "done", reason: output.stopReason, message: output });
              stream.end();
              options?.signal?.removeEventListener?.("abort", abort);
              return;
            }
            if (event.type === "assistant") {
              if (event.message?.usage) output.usage = usageFromAssistantEvent(event);
              for (const block of assistantBlocks(event)) {
                if (block?.type === "thinking") appendThinking(block.thinking ?? "", block.signature);
                else if (block?.type === "redacted_thinking") appendThinking("[Reasoning redacted]", block.data);
              }
              const text = assistantBlocks(event)
                .filter((block: any) => block?.type === "text")
                .map((block: any) => block.text ?? "")
                .join("\n");
              if (text && !sawPartialText) lastText = text;
              continue;
            }
            if (event.type === "result") {
              resultEvent = event;
              output.usage = usageFromResultEvent(event);
              if (!sawPartialText && !lastText && typeof event.result === "string") lastText = event.result;
              continue;
            }
            if (event.type === "__closed") {
              break;
            }
          }

          options?.signal?.removeEventListener?.("abort", abort);
          run.onMcpToolCall = undefined;
          if (state.activeRun === run) state.activeRun = undefined;

          output.stopReason = options?.signal?.aborted
            ? "aborted"
            : resultEvent
              ? stopReasonFrom(resultEvent)
              : run.exitCode === 0
                ? "stop"
                : "error";

          if (output.stopReason === "error") {
            if (lastText && !sawPartialText) append(lastText);
            if (contentIndex >= 0) {
              stream.push({ type: "text_end", contentIndex, content: output.content[contentIndex].text, partial: output });
            }
            output.errorMessage = resultEvent?.result || resultEvent?.error || run.stderr.trim() || `docker/claude exited with code ${run.exitCode}`;
            stream.push({ type: "error", reason: output.stopReason, error: output });
          } else {
            if (lastText && !sawPartialText) append(lastText);
            if (contentIndex >= 0) {
              stream.push({ type: "text_end", contentIndex, content: output.content[contentIndex].text, partial: output });
            }
            stream.push({ type: "done", reason: output.stopReason, message: output });
          }
          stream.end();
        } catch (error) {
          if (run) {
            closeRun(run);
            if (state.activeRun === run) state.activeRun = undefined;
          }
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
          stream.end();
        }
      })();

      return stream;
    },
    } as any);
  });
}
