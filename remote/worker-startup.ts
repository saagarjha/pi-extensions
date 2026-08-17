export const WORKER_STARTUP_ERROR_CODE = "WORKER_STARTUP_FAILED";
const MAX_STARTUP_STDERR = 16 * 1024;

/** Retain a bounded startup tail; the caller keeps draining stderr after clear(). */
export class WorkerStartupDiagnostics {
	private tail = "";
	private retaining = true;
	private truncated = false;
	append(text: string) {
		if (!this.retaining) return;
		this.tail += text;
		if (this.tail.length > MAX_STARTUP_STDERR) {
			this.tail = this.tail.slice(-MAX_STARTUP_STDERR);
			this.truncated = true;
		}
	}
	describe() {
		return this.tail ? `\nWorker startup stderr${this.truncated ? " (tail)" : ""}:\n${this.tail}` : "";
	}
	clear() {
		this.retaining = false;
		this.tail = "";
	}
}
