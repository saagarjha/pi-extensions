import { runSsh, shellQuote, type SshTargetConfig } from "./ssh.ts";

export type RemoteSshJob = { jobId: string; session: string; cwd: string };
export type RemoteSshStatus = { status: "starting" | "running" | "done" | "failed" | "killed" | "unknown" | "unreachable"; exitCode?: number; output: string; error?: string };
export class SshJobContinuesError extends Error { constructor(message: string, readonly remote: RemoteSshJob) { super(message); } }

export async function probeSshTarget(target: SshTargetConfig): Promise<void> {
	const res = await runSsh(target, "command -v tmux >/dev/null && command -v bash >/dev/null");
	if (res.exitCode !== 0) throw new Error((res.stderr || res.stdout || "remote tmux and bash are required").trim());
}


export async function launchSshJob(target: SshTargetConfig, jobId: string, command: string, cwd: string): Promise<RemoteSshJob> {
	const session = `pi_${jobId.replace(/[^A-Za-z0-9_]/g, "_")}`;
	const script = `
set -eu
command -v tmux >/dev/null
command -v bash >/dev/null
jobid=${shellQuote(jobId)}
session=${shellQuote(session)}
cwd=${shellQuote(cwd)}
cmd=${shellQuote(command)}
user=$(id -un 2>/dev/null || printf unknown)
root="\${TMPDIR:-/tmp}/pi-ssh-jobs-$user"
jobdir="$root/$jobid"
mkdir -p "$jobdir"
printf '%s' "$cmd" > "$jobdir/command"
printf '%s' "$cwd" > "$jobdir/cwd"
printf '%s' "$session" > "$jobdir/tmux_session"
date +%s > "$jobdir/started_at"
printf starting > "$jobdir/status"
cat > "$jobdir/runner.sh" <<'PI_RUNNER'
#!/bin/sh
set +e
jobdir=$1
cwd=$(cat "$jobdir/cwd" 2>/dev/null)
printf running > "$jobdir/status"
cd "$cwd" 2>>"$jobdir/output"
cd_code=$?
if [ "$cd_code" -ne 0 ]; then
	code=$cd_code
else
	cmd=$(cat "$jobdir/command")
	bash -lc "$cmd" >>"$jobdir/output" 2>&1
	code=$?
fi
printf '%s' "$code" > "$jobdir/exit_code"
date +%s > "$jobdir/finished_at"
if [ "$code" -eq 0 ]; then printf done > "$jobdir/status"; else printf failed > "$jobdir/status"; fi
exit "$code"
PI_RUNNER
chmod +x "$jobdir/runner.sh"
tmux new-session -d -s "$session" "sh '$jobdir/runner.sh' '$jobdir'"
sleep 0.1
if tmux has-session -t "$session" 2>/dev/null; then
	printf launched
elif [ -s "$jobdir/exit_code" ]; then
	printf launched
else
	printf unknown
	exit 1
fi
`;
	const res = await runSsh(target, "sh -s", { stdin: script });
	if (res.exitCode !== 0 || !res.stdout.includes("launched")) throw new Error((res.stderr || res.stdout || "could not launch remote tmux job").trim());
	return { jobId, session, cwd };
}

export async function followSshJob(target: SshTargetConfig, remote: RemoteSshJob, opts: { signal?: AbortSignal; timeoutMs?: number; onData?: (chunk: Buffer) => void } = {}): Promise<{ exitCode: number | undefined }> {
	let delivered = 0;
	const remoteCommand = `
jobid=${shellQuote(remote.jobId)}
user=$(id -un 2>/dev/null || printf unknown)
jobdir="\${TMPDIR:-/tmp}/pi-ssh-jobs-$user/$jobid"
pos=0
while :; do
	if [ ! -d "$jobdir" ]; then echo __PI_SSH_LOST__; exit 2; fi
	size=$(wc -c < "$jobdir/output" 2>/dev/null || printf 0)
	if [ "$size" -gt "$pos" ]; then
		tail -c +$((pos + 1)) "$jobdir/output" 2>/dev/null
		pos=$size
	fi
	status=$(cat "$jobdir/status" 2>/dev/null || printf unknown)
	case "$status" in
		done|failed|killed)
			code=$(cat "$jobdir/exit_code" 2>/dev/null || true)
			echo "__PI_SSH_DONE__:$status:$code"
			exit 0
			;;
	esac
	sleep 0.2
done
`;
	const buffered: Buffer[] = [];
	const res = await runSsh(target, remoteCommand, {
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
		onData: (chunk) => {
			buffered.push(chunk);
			const text = Buffer.concat(buffered).toString();
			const marker = text.match(/__PI_SSH_DONE__:[^\n]*\n?/);
			const clean = marker ? text.slice(0, marker.index) : text;
			const next = Buffer.from(clean).subarray(delivered);
			if (next.length) {
				delivered += next.length;
				opts.onData?.(next);
			}
		},
	});
	if (res.exitCode !== 0) throw new SshJobContinuesError((res.stderr || "SSH stream ended before remote job completed").trim(), remote);
	const m = res.stdout.match(/__PI_SSH_DONE__:(done|failed|killed):(\d*)/);
	return { exitCode: m?.[2] ? Number(m[2]) : undefined };
}

export async function statusSshJob(target: SshTargetConfig, remote: RemoteSshJob, tailChars = 8000): Promise<RemoteSshStatus> {
	const remoteCommand = `
jobid=${shellQuote(remote.jobId)}
session=${shellQuote(remote.session)}
user=$(id -un 2>/dev/null || printf unknown)
jobdir="\${TMPDIR:-/tmp}/pi-ssh-jobs-$user/$jobid"
if [ ! -d "$jobdir" ]; then echo __STATUS__:unknown; exit 0; fi
status=$(cat "$jobdir/status" 2>/dev/null || printf unknown)
if [ "$status" = running ] || [ "$status" = starting ]; then
	if ! tmux has-session -t "$session" 2>/dev/null; then status=unknown; fi
fi
code=$(cat "$jobdir/exit_code" 2>/dev/null || true)
echo "__STATUS__:$status:$code"
tail -c ${Math.max(1, Math.floor(tailChars))} "$jobdir/output" 2>/dev/null || true
`;
	try {
		const res = await runSsh(target, remoteCommand);
		if (res.exitCode !== 0) return { status: "unreachable", output: "", error: (res.stderr || res.stdout).trim() };
		const [first = "", ...rest] = res.stdout.split("\n");
		const m = first.match(/^__STATUS__:(starting|running|done|failed|killed|unknown):(\d*)$/);
		return { status: (m?.[1] as RemoteSshStatus["status"]) ?? "unknown", exitCode: m?.[2] ? Number(m[2]) : undefined, output: rest.join("\n") };
	} catch (err) {
		return { status: "unreachable", output: "", error: err instanceof Error ? err.message : String(err) };
	}
}

export async function stopSshJob(target: SshTargetConfig, remote: RemoteSshJob): Promise<void> {
	const remoteCommand = `
jobid=${shellQuote(remote.jobId)}
session=${shellQuote(remote.session)}
user=$(id -un 2>/dev/null || printf unknown)
jobdir="\${TMPDIR:-/tmp}/pi-ssh-jobs-$user/$jobid"
tmux kill-session -t "$session" 2>/dev/null || true
mkdir -p "$jobdir"
printf killed > "$jobdir/status"
date +%s > "$jobdir/finished_at"
`;
	const res = await runSsh(target, remoteCommand);
	if (res.exitCode !== 0) throw new Error((res.stderr || res.stdout || "ssh stop failed").trim());
}
