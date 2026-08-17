/**
 * Asking the user about an operation.
 *
 * Deliberately NOT a permission channel. There is no way to express "grant me
 * read on /etc" through this interface, and nothing here can mutate scopes —
 * `confirm` returns a boolean and that is the entire vocabulary. Scopes change
 * only when the user says so directly.
 *
 * The distinction matters: an agent that can request authority will eventually
 * be talked into requesting it by something it read. An agent that can only
 * confirm an operation it was already able to attempt cannot escalate.
 */

export type AskRequest = {
	/** The operation, phrased for the person answering. */
	operation: string;
	/** Concrete specifics: what gets mounted, whether there is a network, etc. */
	detail?: string[];
	/** What happens if declined, when it is not obvious. */
	onDecline?: string;
};

export interface AskPort {
	confirm(req: AskRequest): Promise<boolean>;
}

/**
 * The headless default: decline everything, immediately.
 *
 * A blocked agent waiting on an absent human is the failure mode that turns
 * "runs as-is" into "hung overnight", so non-interactive runs decline rather
 * than wait. The agent sees a clear refusal and routes around it.
 */
export class AutoDenyAsk implements AskPort {
	readonly seen: AskRequest[] = [];

	async confirm(req: AskRequest): Promise<boolean> {
		this.seen.push(req);
		return false;
	}
}

/** Always agrees. For tests that are not about the ask itself. */
export class AutoAllowAsk implements AskPort {
	readonly seen: AskRequest[] = [];

	async confirm(req: AskRequest): Promise<boolean> {
		this.seen.push(req);
		return true;
	}
}

/** Answers a queued script of decisions, then declines. For tests. */
export class ScriptedAsk implements AskPort {
	readonly seen: AskRequest[] = [];
	private answers: boolean[];

	constructor(answers: boolean[]) {
		this.answers = [...answers];
	}

	async confirm(req: AskRequest): Promise<boolean> {
		this.seen.push(req);
		return this.answers.shift() ?? false;
	}
}
