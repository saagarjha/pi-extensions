import type { BackgroundTaskDetail, BackgroundTaskMetadata, BackgroundTaskPort } from "./control-plane.ts";

/** A view of existing owner records, never an executor or a second job registry. */
export function createBackgroundTaskPort<T extends Omit<BackgroundTaskDetail, "revision">>(source: {
	check(): void;
	revision(): number;
	list(): T[];
	get(id: string): T | undefined;
	subscribe(listener: () => void): () => void;
	stop(job: T): Promise<void>;
}): BackgroundTaskPort {
	const metadata = (job: T): BackgroundTaskMetadata => ({
		revision: source.revision(),
		id: job.id, target: job.target, command: job.command, cwd: job.cwd,
		status: job.status, timeoutMs: job.timeoutMs, exitCode: job.exitCode,
		error: job.error, startedAt: job.startedAt, updatedAt: job.updatedAt,
	});
	const detail = (job: T): BackgroundTaskDetail => ({ ...metadata(job), output: job.output });
	const get = (id: string) => {
		source.check();
		const job = source.get(id);
		if (!job) throw new Error(`Unknown background command: ${id}`);
		return job;
	};
	return {
		list() { source.check(); return source.list().map(metadata); },
		status(id) { return detail(get(id)); },
		subscribe(listener) {
			source.check();
			return source.subscribe(() => {
				// A withdrawn observer must never break the authoritative execution path.
				try { source.check(); listener(); } catch { /* observer isolation */ }
			});
		},
		async stop(id) {
			const job = get(id);
			await source.stop(job);
			source.check();
			return detail(job);
		},
	};
}

export function backgroundOutput(
	job: Pick<BackgroundTaskDetail, "output" | "error">,
	tailChars = 8000,
) {
	const output =
		job.output.length > tailChars
			? `[output truncated: showing last ${tailChars} chars]\n${job.output.slice(-tailChars)}`
			: job.output;
	return `${output || "(no output yet)"}${job.error ? "\n\nerror: " + job.error : ""}`;
}
