export function createDockerfile(mcpServerName: string): string {
  return `FROM ubuntu:latest
RUN apt-get update
RUN apt-get install -y ca-certificates curl python3
ARG CLAUDE_CACHE_BUST=initial
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh && bash /tmp/claude-install.sh && rm /tmp/claude-install.sh
RUN cat > /usr/local/bin/pi-mcp-bridge <<'PY'
#!/usr/bin/env python3
import json, os, sys, threading, urllib.request

BROKER_URL = os.environ.get('PI_MCP_BROKER_URL', '')
OUTPUT_LOCK = threading.Lock()
OUTPUT_FD = sys.stdout.fileno()

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
    data = (json.dumps(message, separators=(',', ':')) + '\\n').encode('utf-8')
    # Daemon workers must not hold a buffered stdout lock during shutdown.
    # Keep the entire JSONL frame locked, including any partial raw writes.
    with OUTPUT_LOCK:
        remaining = memoryview(data)
        try:
            while remaining:
                written = os.write(OUTPUT_FD, remaining)
                if not written:
                    return
                remaining = remaining[written:]
        except BrokenPipeError:
            # Native Claude may close the MCP transport during interruption.
            return

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

def handle_tool_call(request):
    try:
        params = request.get('params') or {}
        metadata = params.get('_meta') or {}
        broker = broker_post('/tool-call', {
            'name': params.get('name'),
            'arguments': params.get('arguments') or {},
            # This is Claude's native assistant tool_use ID, not the JSON-RPC ID.
            'toolUseId': metadata.get('claudecode/toolUseId')
        })
        response = {
            'content': broker.get('content', [{'type': 'text', 'text': broker.get('text', '')}]),
            'isError': bool(broker.get('isError'))
        }
        if '_meta' in broker:
            response['_meta'] = broker['_meta']
        result(request, response)
    except Exception as exc:
        result(request, {'content': [{'type': 'text', 'text': 'MCP bridge error: ' + str(exc)}], 'isError': True})

def handle_tools_list(request):
    try:
        result(request, {'tools': broker_post('/tools-list', {}).get('tools', [])})
    except Exception as exc:
        error(request, -32603, 'MCP bridge error: ' + str(exc))

while True:
    msg = read_message()
    if msg is None:
        break
    method = msg.get('method')
    if method == 'initialize':
        result(msg, {'protocolVersion': msg.get('params', {}).get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {'listChanged': False}}, 'serverInfo': {'name': 'pi-mcp-bridge', 'version': '0.0.1'}})
    elif method == 'tools/list':
        threading.Thread(target=handle_tools_list, args=(msg,), daemon=True).start()
    elif method == 'tools/call':
        # A blocked pi tool must not prevent Claude from submitting another call.
        threading.Thread(target=handle_tool_call, args=(msg,), daemon=True).start()
    elif 'id' in msg:
        error(msg, -32601, 'method not found')
PY
RUN chmod +x /usr/local/bin/pi-mcp-bridge
RUN cat > /usr/local/bin/claude-with-pi-mcp <<'PY'
#!/usr/bin/python3
import json, os, signal, subprocess, sys, tempfile, threading
from pathlib import Path

launching_child = False
pending_signal = None

def interrupted(signum, frame):
    global pending_signal
    pending_signal = signum
    # Do not lose the process handle if a signal arrives inside Popen.
    if not launching_child:
        raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)

def parent_lines():
    # Read raw bytes so control lines are forwarded verbatim. Avoid holding a
    # sys.stdin BufferedReader lock in a daemon when Claude exits before EOF.
    pending = bytearray()
    while True:
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            if pending:
                yield bytes(pending)
            return
        parts = chunk.split(b'\\n')
        pending.extend(parts[0])
        for part in parts[1:]:
            yield bytes(pending) + b'\\n'
            pending.clear()
            pending.extend(part)

def stop_child(child):
    if child.poll() is None:
        try:
            child.terminate()
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    child.stdin.close()

def run_claude(payload, lines, config_dir, mcp_config, session_args):
    global launching_child
    initial_input = (json.dumps(payload['input']) + '\\n').encode('utf-8')
    child = None
    feeder_failed = threading.Event()
    feeder_errors = []
    try:
        launching_child = True
        try:
            child = subprocess.Popen(
                ['/root/.local/bin/claude', '--mcp-config', str(mcp_config), *sys.argv[1:], *session_args],
                stdin=subprocess.PIPE, bufsize=0, cwd='/',
                env={**os.environ, 'CLAUDE_CONFIG_DIR': config_dir})
        finally:
            launching_child = False
        if pending_signal is not None:
            raise SystemExit(128 + pending_signal)

        def write_line(line):
            # FileIO is unbuffered; handle short writes without altering bytes.
            remaining = memoryview(line)
            while remaining:
                written = child.stdin.write(remaining)
                if not written:
                    raise BrokenPipeError('Claude stdin closed')
                remaining = remaining[written:]
            child.stdin.flush()

        def feed_input():
            try:
                write_line(initial_input)
                for line in lines:
                    write_line(line)
            except BrokenPipeError:
                # Claude may exit or close its input before the parent does.
                pass
            except Exception as exc:
                feeder_errors.append(exc)
                feeder_failed.set()
            finally:
                child.stdin.close()

        threading.Thread(target=feed_input, daemon=True).start()
        # Do not close stdin after the seed: the parent sends native control
        # messages and closes its side only after the terminal native result.
        while True:
            if feeder_failed.is_set():
                raise RuntimeError('Claude stdin relay failed') from feeder_errors[0]
            try:
                return child.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                pass
    finally:
        # A repeated signal must not interrupt reaping or temp-config cleanup.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if child is not None:
            stop_child(child)

lines = parent_lines()
payload = json.loads(next(lines, b''))
# Pi owns the history. Nothing in this per-run Claude config is durable state.
with tempfile.TemporaryDirectory(prefix='pi-claude-') as config_dir:
    config = Path(config_dir)
    session_args = ['--session-id', payload['sessionId']]
    if payload['transcript']:
        sessions = config / 'projects' / '-'
        sessions.mkdir(parents=True)
        (sessions / (payload['sessionId'] + '.jsonl')).write_text(payload['transcript'], encoding='utf-8')
        session_args = ['--resume', payload['sessionId']]
    mcp_config = config / 'pi-mcp.json'
    mcp_config.write_text(json.dumps({'mcpServers': {${JSON.stringify(mcpServerName)}: {
        'command': '/usr/local/bin/pi-mcp-bridge',
        'env': {'PI_MCP_BROKER_URL': os.environ.get('PI_MCP_BROKER_URL', '')}
    }}}), encoding='utf-8')
    sys.exit(run_claude(payload, lines, config_dir, mcp_config, session_args))
PY
RUN chmod +x /usr/local/bin/claude-with-pi-mcp
ENTRYPOINT ["/usr/local/bin/claude-with-pi-mcp"]
`;
}
