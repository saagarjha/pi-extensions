/** Resolved-path authorization shared by filesystem tool guards. */
export class DeniedError extends Error {
	constructor(readonly realPath: string) {
		super(`denied: ${realPath}`);
		this.name = "DeniedError";
	}
}

/** Predicate over the fully-resolved path. */
export type Allow = (realPath: string) => boolean;
