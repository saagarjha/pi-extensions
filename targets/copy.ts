import type { ChildProcess } from "node:child_process";
import { posix as path } from "node:path";

export type CopyEndpoint = {
	id: string;
	local: boolean;
	spawn(command: string, signal?: AbortSignal): ChildProcess;
};

export type CopyScope = {
	path: string;
	access: "allow" | "deny";
};

export type CopyLocation = {
	endpoint: CopyEndpoint;
	path: string;
	scopes?: readonly CopyScope[];
};

type EntryKind = "d" | "f" | "l" | "x" | "missing";
type PermissionRegion = { path: string; access: "allow" | "deny" };
type CopyOptions = { overwrite?: boolean };
type CopyResult = {
	sourcePath: string;
	destinationPath: string;
	sourceIsDirectory: boolean;
	skipped?: { regions: number };
};

type CopyPlan = {
	source: CopyLocation;
	destination: CopyLocation;
	sourceIsDirectory: boolean;
	manifest: string[];
	exclusions: string[];
	skippedRegions: number;
};

type RsyncTransfer = {
	source: CopyLocation;
	destination: CopyLocation;
	sourceArgument: string;
	destinationArgument: string;
	args: string[];
	scratchDirectory: string;
};

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const command = (args: string[]) => args.map(quote).join(" ");

function spawnShell(endpoint: CopyEndpoint, script: string, signal?: AbortSignal): ChildProcess {
	return endpoint.spawn(command(["/bin/bash", "--noprofile", "--norc", "-c", script]), signal);
}

function beneath(root: string, child: string): boolean {
	return root === child || child.startsWith(root === "/" ? "/" : `${root}/`);
}

function escapeGlob(value: string): string {
	const replacements: Record<string, string> = {
		"*": "[*]",
		"?": "[?]",
		"[": "[[]",
		"]": "[]]",
		"\\": "[\\\\]",
	};
	return value.replace(/[\\*?\[\]]/g, character => replacements[character]!);
}

function normalized(value: string): string {
	if (!value.startsWith("/") || value.includes("\0")) {
		throw new Error("Copy paths must be absolute and contain no NUL");
	}
	return path.resolve(value);
}

function normalizeLocation(location: CopyLocation): CopyLocation {
	return {
		...location,
		path: normalized(location.path),
		scopes: location.scopes?.map(scope => ({ ...scope, path: normalized(scope.path) })),
	};
}

function access(location: CopyLocation, target: string): "allow" | "deny" {
	let result: "allow" | "deny" = location.endpoint.local || location.scopes ? "deny" : "allow";
	let matchedLength = -1;
	for (const scope of location.scopes ?? []) {
		if (beneath(scope.path, target) && scope.path.length > matchedLength) {
			matchedLength = scope.path.length;
			result = scope.access;
		}
	}
	return result;
}

function permissionRegions(location: CopyLocation): PermissionRegion[] {
	const boundaries = new Set([location.path]);
	for (const scope of location.scopes ?? []) {
		if (beneath(location.path, scope.path)) boundaries.add(scope.path);
	}
	return [...boundaries]
		.map(regionPath => ({ path: regionPath, access: access(location, regionPath) }))
		.sort((left, right) => left.path.length - right.path.length);
}

function sandboxCommand(
	args: string[],
	reads: CopyLocation[],
	writes: CopyLocation[],
	scratchDirectory?: string,
): string {
	const parameters: string[] = [];
	const parameter = (value: string) => {
		const key = `P${parameters.length / 2}`;
		parameters.push("-D", `${key}=${value}`);
		return `(param "${key}")`;
	};
	const rules = [
		'(version 1)',
		'(deny default)',
		'(import "system.sb")',
		'(deny network*)',
		'(allow file-read-metadata file-test-existence)',
		'(allow process-fork)',
		'(allow signal (target same-sandbox))',
	];
	const executables = ["/usr/bin/rsync", "/bin/bash", "/bin/sh", "/bin/cat", "/usr/bin/perl"];
	for (const executable of executables) {
		const executablePath = `(literal ${parameter(executable)})`;
		rules.push(`(allow process-exec file-read-data file-map-executable ${executablePath})`);
	}

	const ancestors = new Set<string>();
	for (const location of [...reads, ...writes]) {
		const allowedRegions = permissionRegions(location).filter(region => region.access === "allow");
		for (const region of allowedRegions) {
			for (let parent = path.dirname(region.path);; parent = path.dirname(parent)) {
				ancestors.add(parent);
				if (parent === "/") break;
			}
		}
	}
	for (const ancestor of ancestors) {
		const directoryPath = `(require-all (literal ${parameter(ancestor)}) (vnode-type DIRECTORY))`;
		rules.push(`(allow file-read-data ${directoryPath})`);
	}

	const permissions = [
		{ locations: reads, operations: "file-read-data" },
		{ locations: writes, operations: "file-read-data file-write*" },
	];
	for (const { locations, operations } of permissions) {
		for (const location of locations) {
			const regions = permissionRegions(location);
			for (const region of regions) {
				if (region.access !== "allow") continue;
				const deniedDescendants = regions.filter(candidate =>
					candidate.access === "deny" && beneath(region.path, candidate.path),
				);
				const filters = [`(subpath ${parameter(region.path)})`];
				for (const denied of deniedDescendants) {
					filters.push(`(require-not (subpath ${parameter(denied.path)}))`);
				}
				const regionFilter = filters.length === 1 ? filters[0] : `(require-all ${filters.join(" ")})`;
				rules.push(`(allow ${operations} ${regionFilter})`);
			}
		}
	}
	if (scratchDirectory) {
		rules.push(`(allow file-read* file-write* (subpath ${parameter(scratchDirectory)}))`);
	}
	return command(["/usr/bin/sandbox-exec", "-p", rules.join("\n"), ...parameters, ...args]);
}

function rsyncCommand(
	endpoint: CopyEndpoint,
	args: string[],
	reads: CopyLocation[],
	writes: CopyLocation[],
	scratchDirectory?: string,
): string {
	const invocation = endpoint.local
		? sandboxCommand(["/usr/bin/rsync", ...args], reads, writes, scratchDirectory)
		: command(["/usr/bin/rsync", ...args]);
	return `RSYNC_OLD_ARGS=1 exec ${invocation}`;
}

function watchProcess(
	child: ChildProcess,
	onOutput?: (data: Buffer) => void,
	onStderr?: (data: Buffer, stderr: string) => void,
): Promise<void> {
	let stderr = "";
	child.stdin?.on("error", () => {});
	return new Promise((resolve, reject) => {
		child.stderr?.on("data", data => {
			stderr = (stderr + data.toString()).slice(-16384);
			try {
				onStderr?.(Buffer.from(data), stderr);
			} catch (error) {
				child.kill("SIGKILL");
				reject(error);
			}
		});
		child.stdout?.on("data", data => {
			try {
				onOutput?.(Buffer.from(data));
			} catch (error) {
				child.kill("SIGKILL");
				reject(error);
			}
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `Copy process exited ${code ?? signal}`));
		});
	});
}

async function runShell(endpoint: CopyEndpoint, script: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	let output = "";
	const child = spawnShell(endpoint, script, signal);
	const completion = watchProcess(child, data => {
		output += data.toString();
	});
	child.stdin?.end();
	await completion;
	return output;
}

async function inspectKinds(
	endpoint: CopyEndpoint,
	paths: string[],
	signal?: AbortSignal,
): Promise<EntryKind[]> {
	if (!paths.length) return [];
	signal?.throwIfAborted();
	const script = `while IFS= read -r -d '' entry; do
	if [ -L "$entry" ]; then
		printf 'l\\n'
	elif [ -d "$entry" ]; then
		printf 'd\\n'
	elif [ -f "$entry" ]; then
		printf 'f\\n'
	elif [ -e "$entry" ]; then
		printf 'x\\n'
	else
		printf 'missing\\n'
	fi
done`;
	const child = spawnShell(endpoint, script, signal);
	let output = "";
	const completion = watchProcess(child, data => {
		output += data.toString();
	});
	child.stdin!.end(paths.join("\0") + "\0");
	await completion;

	const result = output.trim().split("\n") as EntryKind[];
	const validKinds = ["d", "f", "l", "x", "missing"];
	if (result.length !== paths.length || result.some(kind => !validKinds.includes(kind))) {
		throw new Error("Invalid copy metadata response");
	}
	return result;
}

function writeListScript(name: string, entries: string[]): string {
	if (!entries.length) return `: > "$directory/${name}"`;
	return `printf '%s\\0' ${entries.map(quote).join(" ")} > "$directory/${name}"`;
}

function blockingScript(script: string): string {
	const perl = String.raw`for my $handle (\*STDIN, \*STDOUT) {
	my $flags = fcntl($handle, F_GETFL, 0);
	defined($flags) or die "fcntl get: $!";
	fcntl($handle, F_SETFL, $flags & ~O_NONBLOCK) or die "fcntl set: $!";
}
exec @ARGV;
die "exec: $!";`;
	return `if [ -e /usr/bin/sw_vers ]; then
	exec /usr/bin/perl -MFcntl=F_GETFL,F_SETFL,O_NONBLOCK -e ${quote(perl)} /bin/bash --noprofile --norc -c ${quote(script)}
else
	exec /bin/bash --noprofile --norc -c ${quote(script)}
fi
`;
}

function bridgeScript(directory: string): string {
	// Older uutils cat can deadlock when splicing a socket into a FIFO.
	const forwarding = `exec 3<&0
copier=/bin/cat
if [ -x /usr/bin/gnucat ]; then copier=/usr/bin/gnucat; fi
"$copier" <&3 > ${quote(`${directory}/tx`)} &
sender=$!
trap 'kill "$sender" 2>/dev/null || :' EXIT HUP INT TERM
/bin/cat ${quote(`${directory}/rx`)}
status=$?
kill "$sender" 2>/dev/null || :
wait "$sender" 2>/dev/null || :
exit "$status"`;
	return `#!/bin/bash
set -eu
shift
printf '%s\\0' "$#" "$@" > ${quote(`${directory}/request`)}
${blockingScript(forwarding)}`;
}

function relayScript(directory: string, direction: "tx" | "rx", remote: boolean): string {
	const pidFile = quote(`${directory}/relay-${direction}.pid`);
	const temporaryPidFile = quote(`${directory}/relay-${direction}.pid.tmp`);
	const removePidFiles = remote ? `/bin/rm -f -- ${pidFile} ${temporaryPidFile}` : ":";
	const publishPid = remote ? `printf '%s\\n' "$$" > ${temporaryPidFile}
/bin/mv -- ${temporaryPidFile} ${pidFile}
` : "";
	return `set -eu
exec 3<&0
cleanup() {
	trap - EXIT
	trap '' HUP INT TERM
	for child in $(jobs -pr); do
		kill "$child" 2>/dev/null || :
	done
	wait 2>/dev/null || :
	${removePidFiles}
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM
${publishPid}copier=/bin/cat
if [ -x /usr/bin/gnucat ]; then copier=/usr/bin/gnucat; fi
${direction === "tx" ? `"$copier" ${quote(`${directory}/request`)} &
header=$!
wait "$header"
"$copier" ${quote(`${directory}/tx`)} &` : `"$copier" <&3 > ${quote(`${directory}/rx`)} &`}
forwarder=$!
wait "$forwarder"`;
}

function remoteWorkerScript(nativeCommand: string): string {
	return `exec 3<&0
(
	${nativeCommand}
) </dev/null &
worker=$!
(
	/bin/cat <&3 >/dev/null &
	reader=$!
	trap '
		kill "$reader" 2>/dev/null || :
		exit 0
	' HUP INT TERM
	wait "$reader"
	kill -KILL "$worker" 2>/dev/null || :
) &
watcher=$!
trap '
	kill -KILL "$worker" 2>/dev/null || :
	kill "$watcher" 2>/dev/null || :
' EXIT HUP INT TERM
wait "$worker"
status=$?
kill "$watcher" 2>/dev/null || :
wait "$watcher" 2>/dev/null || :
trap - EXIT HUP INT TERM
exit "$status"`;
}

async function removeScratch(endpoint: CopyEndpoint, directory: string): Promise<void> {
	// Cleanup must run after cancellation, but must not wait indefinitely itself.
	const signal = AbortSignal.timeout(10_000);
	if (endpoint.local) {
		await runShell(endpoint, `/bin/rm -rf -- ${quote(directory)}`, signal);
		return;
	}
	const script = `set -eu
directory=${quote(directory)}
[ -d "$directory" ] || exit 0
umask 077
cleanup=$(/usr/bin/mktemp -d /tmp/pi-copy-cleanup.XXXXXXXXXX)
if /bin/mv -- "$directory" "$cleanup/work"; then
	for pidfile in "$cleanup/work/relay-tx.pid" "$cleanup/work/relay-rx.pid" "$cleanup/work/relay.pid"; do
		[ -f "$pidfile" ] || continue
		pid=
		IFS= read -r pid < "$pidfile" || :
		case "$pid" in
			''|*[!0-9]*) ;;
			*)
				if [ "$pid" -gt 1 ]; then
					kill -TERM "$pid" 2>/dev/null || :
				fi
				;;
		esac
	done
fi
/bin/rm -rf -- "$cleanup"`;
	await runShell(endpoint, script, signal);
}

async function createScratch(
	endpoint: CopyEndpoint,
	manifest: string[],
	exclusions: string[],
	signal?: AbortSignal,
): Promise<string> {
	const createDirectory = `set -eu
umask 077
directory=$(/usr/bin/mktemp -d /tmp/pi-copy.XXXXXXXXXX)
cd "$directory"
/bin/pwd -P`;
	const directory = (await runShell(endpoint, createDirectory, signal)).trim();
	if (!/^\/[^\r\n\0]+$/.test(directory)) {
		throw new Error("Invalid copy scratch directory");
	}
	try {
		const setup = `set -eu
directory=${quote(directory)}
${writeListScript("manifest", manifest)}
${writeListScript("exclude", exclusions)}
printf '%s' ${quote(bridgeScript(directory))} > "$directory/bridge"
/usr/bin/mkfifo "$directory/request" "$directory/tx" "$directory/rx"`;
		await runShell(endpoint, setup, signal);
		return directory;
	} catch (error) {
		await removeScratch(endpoint, directory).catch(() => {});
		throw error;
	}
}

function parseServerRequest(
	header: Buffer,
	sourceArgument: string,
): { args: string[]; protocolOffset: number } | undefined {
	if (header.length > 1024 * 1024) throw new Error("Oversized rsync bridge request");
	const countEnd = header.indexOf(0);
	if (countEnd === -1) return;

	const countText = header.subarray(0, countEnd).toString();
	if (!/^\d+$/.test(countText)) throw new Error("Invalid rsync bridge argument count");
	const count = Number(countText);
	if (count < 4 || count > 1024) throw new Error("Invalid rsync bridge argument count");

	const args: string[] = [];
	let offset = countEnd + 1;
	for (let index = 0; index < count; index++) {
		const end = header.indexOf(0, offset);
		if (end === -1) return;
		args.push(header.subarray(offset, end).toString());
		offset = end + 1;
	}
	const isSender = args[0] === "rsync" && args[1] === "--server" && args.includes("--sender");
	const matchesSource = args.at(-2) === "." && args.at(-1) === sourceArgument;
	if (!isSender || !matchesSource) {
		throw new Error("Unexpected rsync server request or source operand");
	}
	return { args, protocolOffset: offset };
}

async function transfer(
	request: RsyncTransfer,
	signal: AbortSignal | undefined,
	onOutput: (data: Buffer) => void,
): Promise<void> {
	const { source, destination, sourceArgument, destinationArgument, args, scratchDirectory } = request;
	const children: ChildProcess[] = [];
	const completions: Promise<void>[] = [];
	const closures: Promise<void>[] = [];
	const diagnostics: { role: string; stderr: string }[] = [];
	let rejectFailure!: (error: unknown) => void;
	const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
	failure.catch(() => {});
	const track = (child: ChildProcess, role: string, output?: (data: Buffer) => void) => {
		children.push(child);
		closures.push(new Promise<void>(resolve => { child.once("close", () => resolve()); }));
		const diagnostic = { role, stderr: "" };
		diagnostics.push(diagnostic);
		const completion = watchProcess(child, output, (data, stderr) => {
			diagnostic.stderr = stderr;
			onOutput(data);
		});
		// A failed leader can leave descendants holding its stdio open. Start
		// teardown on exit, rather than waiting for those descriptors to close.
		child.once("exit", (code, exitSignal) => {
			if (code !== 0) rejectFailure(new Error(`Copy ${role} exited ${code ?? exitSignal}`));
		});
		completion.catch(rejectFailure);
		completions.push(completion);
		return completion;
	};
	const controller = new AbortController();
	const abortChildren = () => {
		controller.abort(signal?.reason);
		for (const child of children) child.kill("SIGKILL");
	};
	const abort = () => {
		rejectFailure(signal?.reason ?? new Error("Copy aborted"));
		abortChildren();
	};
	signal?.throwIfAborted();
	signal?.addEventListener("abort", abort, { once: true });

	const run = async () => {
		if (source.endpoint.id === destination.endpoint.id) {
			const nativeCommand = rsyncCommand(
				destination.endpoint,
				[...args, "--", sourceArgument, destinationArgument],
				[source],
				[destination],
				scratchDirectory,
			);
			const script = destination.endpoint.local
				? nativeCommand
				: blockingScript(remoteWorkerScript(nativeCommand));
			const child = spawnShell(destination.endpoint, script, controller.signal);
			const completion = track(child, "rsync", onOutput);
			if (destination.endpoint.local) child.stdin?.end();
			await completion;
			return;
		}

		// Independent transports preserve half-close in both directions. A
		// combined relay cannot expose tx EOF while it is still waiting for rx;
		// Apple rsync then waits forever for its bridge child after an error.
		const relayIn = spawnShell(destination.endpoint,
			blockingScript(relayScript(scratchDirectory, "rx", !destination.endpoint.local)), controller.signal);
		const relayInCompletion = track(relayIn, "incoming relay");
		const relayOut = spawnShell(destination.endpoint,
			blockingScript(relayScript(scratchDirectory, "tx", !destination.endpoint.local)), controller.signal);
		let header = Buffer.alloc(0);
		let server: ChildProcess | undefined;
		let serverCompletion: Promise<void> | undefined;
		let resolveHandshake!: () => void;
		let rejectHandshake!: (error: unknown) => void;
		const handshake = new Promise<void>((resolve, reject) => {
			resolveHandshake = resolve;
			rejectHandshake = reject;
		});
		handshake.catch(() => {});

		const relayOutCompletion = track(relayOut, "outgoing relay", chunk => {
			if (server) return;
			try {
				header = Buffer.concat([header, chunk]);
				const requested = parseServerRequest(header, sourceArgument);
				if (!requested) return;

				const serverCommand = rsyncCommand(source.endpoint, requested.args.slice(1), [source], []);
				server = spawnShell(source.endpoint, serverCommand, controller.signal);
				serverCompletion = track(server, "sender");
				server.stdout!.pipe(relayIn.stdin!);
				relayOut.stdout!.pipe(server.stdin!);
				if (header.length > requested.protocolOffset) {
					server.stdin!.write(header.subarray(requested.protocolOffset));
				}
				header = Buffer.alloc(0);
				resolveHandshake();
			} catch (error) {
				rejectHandshake(error);
			}
		});
		relayOut.stdin?.end();
		relayOutCompletion.then(() => {
			if (!server) rejectHandshake(new Error("Rsync bridge closed without a server request"));
		}, rejectHandshake);

		const bridgeCommand = command(["/bin/bash", "--noprofile", "--norc", `${scratchDirectory}/bridge`]);
		const clientArgs = [
			...args,
			"--blocking-io",
			"-e", bridgeCommand,
			"--", `copy-source:${sourceArgument}`, destinationArgument,
		];
		const clientCommand = rsyncCommand(destination.endpoint, clientArgs, [], [destination], scratchDirectory);
		const client = spawnShell(destination.endpoint, clientCommand, controller.signal);
		const clientCompletion = track(client, "receiver", onOutput);
		client.once("exit", () => {
			if (!server) rejectHandshake(new Error("Rsync client exited without a server request"));
		});
		client.stdin?.end();

		await handshake;
		await Promise.all([clientCompletion, serverCompletion!, relayOutCompletion, relayInCompletion]);
	};

	let failed = false;
	let error: unknown;
	try {
		await Promise.race([run(), failure]);
	} catch (cause) {
		failed = true;
		error = cause;
	} finally {
		signal?.removeEventListener("abort", abort);
		abortChildren();
		await Promise.allSettled(completions);
		await Promise.all(closures);
	}
	if (failed) {
		if (signal?.aborted) throw error;
		// Reaping the peers can race a generic SIGPIPE/SSH exit against the
		// receiver's real error. Keep all diagnostics after stdio has drained.
		const messages = new Set([
			error instanceof Error ? error.message : String(error),
			...diagnostics.map(item => item.stderr.trim()).filter(Boolean),
		]);
		throw new Error([...messages].join("\n"), { cause: error });
	}
}

async function planCopy(
	source: CopyLocation,
	destination: CopyLocation,
	signal?: AbortSignal,
): Promise<CopyPlan> {
	const [[sourceKind], [destinationKind]] = await Promise.all([
		inspectKinds(source.endpoint, [source.path], signal),
		inspectKinds(destination.endpoint, [destination.path], signal),
	]);
	if (sourceKind === "missing") throw new Error(`source does not exist: ${source.path}`);
	if (sourceKind === "x") {
		throw new Error(`source is not a regular file, symlink, or directory: ${source.path}`);
	}
	const sourceIsDirectory = sourceKind === "d";
	if (!sourceIsDirectory && destinationKind === "d") {
		destination = { ...destination, path: path.join(destination.path, path.basename(source.path)) };
	}
	if (sourceIsDirectory && destinationKind !== "missing" && destinationKind !== "d") {
		throw new Error(`destination exists and is not a directory: ${destination.path}`);
	}
	const sameEndpoint = source.endpoint.id === destination.endpoint.id;
	const copiesIntoItself = source.path === destination.path || sourceIsDirectory && beneath(source.path, destination.path);
	if (sameEndpoint && copiesIntoItself) {
		throw new Error("cannot copy a path into itself or one of its descendants");
	}

	const boundaries = new Set<string>([""]);
	for (const location of [source, destination]) {
		for (const scope of location.scopes ?? []) {
			if (beneath(location.path, scope.path)) {
				boundaries.add(path.relative(location.path, scope.path));
			}
		}
	}
	const sortedBoundaries = [...boundaries].sort((left, right) => left.length - right.length);
	const intersections = sortedBoundaries.map(relative => {
		const sourceAllowed = access(source, path.join(source.path, relative)) === "allow";
		const destinationAllowed = access(destination, path.join(destination.path, relative)) === "allow";
		return { relative, allowed: sourceAllowed && destinationAllowed };
	});
	const hasPermittedRoot = intersections.some(region =>
		region.allowed && (sourceIsDirectory || region.relative === ""),
	);
	if (!hasPermittedRoot) {
		throw new Error("Copy has no permitted source/destination region intersection");
	}

	const transitions = intersections.filter(region => {
		if (!region.relative) return true;
		const regionPath = path.join("/", region.relative);
		const ancestors = intersections.filter(candidate =>
			candidate !== region && beneath(path.join("/", candidate.relative), regionPath),
		);
		ancestors.sort((left, right) => right.relative.length - left.relative.length);
		const parent = ancestors[0];
		return region.allowed !== parent?.allowed;
	});
	const transitionPaths = transitions.map(region => path.join(source.path, region.relative));
	const transitionKinds = await inspectKinds(source.endpoint, transitionPaths, signal);
	const existingRegions = transitions.map((region, index) => ({
		...region,
		kind: transitionKinds[index]!,
	}));
	const deniedRegions = existingRegions.filter(region => !region.allowed);
	const allowedRegions = existingRegions.filter(region => region.allowed && region.kind !== "missing");
	if (allowedRegions.some(region => region.kind === "x")) {
		throw new Error("Permitted copy root is not a regular file, symlink, or directory");
	}

	const exclusions: string[] = [];
	for (const region of deniedRegions) {
		if (!region.relative || region.kind === "missing") continue;
		const directorySuffix = region.kind === "d" ? "/" : "";
		exclusions.push(`/${escapeGlob(region.relative)}${directorySuffix}`);
	}
	let manifest: string[] = [];
	if (allowedRegions.length) {
		manifest = sourceIsDirectory
			? allowedRegions.map(region => region.relative || ".")
			: [path.basename(source.path)];
	}
	return { source, destination, sourceIsDirectory, manifest, exclusions, skippedRegions: deniedRegions.length };
}

export async function copyWithRsync(
	source: CopyLocation,
	destination: CopyLocation,
	options: CopyOptions,
	signal?: AbortSignal,
	onProgress?: (text: string) => void,
): Promise<CopyResult> {
	source = normalizeLocation(source);
	destination = normalizeLocation(destination);
	const plan = await planCopy(source, destination, signal);
	source = plan.source;
	destination = plan.destination;
	const result: CopyResult = {
		sourcePath: source.path,
		destinationPath: destination.path,
		sourceIsDirectory: plan.sourceIsDirectory,
		...(plan.skippedRegions ? { skipped: { regions: plan.skippedRegions } } : {}),
	};
	if (!plan.manifest.length) return result;

	const [destinationKind] = await inspectKinds(destination.endpoint, [destination.path], signal);
	if (destinationKind !== "missing" && !options.overwrite) {
		throw new Error(`destination exists (set overwrite=true to replace): ${destination.path}`);
	}
	if (plan.sourceIsDirectory && destinationKind !== "missing" && destinationKind !== "d") {
		throw new Error(`destination exists and is not a directory: ${destination.path}`);
	}
	if (!plan.sourceIsDirectory && destinationKind === "d") {
		throw new Error(`effective destination is a directory: ${destination.path}`);
	}

	const scratchDirectory = await createScratch(destination.endpoint, plan.manifest, plan.exclusions, signal);
	try {
		const args = ["--recursive", "--links", "--no-implied-dirs", "--ignore-times", "--inplace"];
		if (plan.sourceIsDirectory) {
			args.push(
				"--relative",
				"--from0",
				`--files-from=${scratchDirectory}/manifest`,
				`--exclude-from=${scratchDirectory}/exclude`,
			);
		}
		const scratchInsideSource = plan.sourceIsDirectory
			&& source.endpoint.id === destination.endpoint.id
			&& beneath(source.path, scratchDirectory);
		if (scratchInsideSource) {
			args.push(`--exclude=/${escapeGlob(path.relative(source.path, scratchDirectory))}/`);
		}

		const request: RsyncTransfer = {
			source,
			destination,
			sourceArgument: plan.sourceIsDirectory && source.path !== "/" ? `${source.path}/` : source.path,
			destinationArgument: destination.path,
			args,
			scratchDirectory,
		};
		onProgress?.("Copying with rsync");
		await transfer(request, signal, chunk => onProgress?.(chunk.toString()));
		return result;
	} finally {
		await removeScratch(destination.endpoint, scratchDirectory).catch(() => {});
	}
}
