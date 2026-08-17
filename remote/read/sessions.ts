import { randomUUID } from "node:crypto";
import { SessionFile } from "./session-file.ts";
import {
	check,
	type Catalog,
	type OwnerPort,
	type SessionPort,
	type Snapshot,
	type ObservationPage,
} from "./protocol.ts";

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Reads existing sessions. Current state stays inline; only history is paginated. */
export class SessionReader {
	readonly ownerId = randomUUID();
	private revision = 0;
	private sources = new Map<string, { identity: string; source: SessionFile }>();
	private snapshots = new Map<
		string,
		{ view: Pick<Snapshot, "descriptor" | "history">; source: SessionFile }
	>();

	constructor(private owner: OwnerPort) {}

	private session(id: string): SessionPort {
		const session = this.owner.sessions().find((session) => session.descriptor().id === id);
		check(session, "UNKNOWN_SESSION");
		return session;
	}

	private source(session: SessionPort): SessionFile {
		const descriptor = session.descriptor();
		const declaration = session.source();
		const identity = JSON.stringify([descriptor.nativeIdentity, declaration.path]);
		let entry = this.sources.get(descriptor.id);
		if (!entry || entry.identity !== identity) {
			entry?.source.invalidate();
			entry = { identity, source: new SessionFile(declaration) };
			this.sources.set(descriptor.id, entry);
		}
		return entry.source;
	}

	private capture(session: SessionPort): Snapshot {
		return clone({
			version: 1,
			hostId: this.owner.hostId,
			ownerId: this.ownerId,
			revision: ++this.revision,
			cutId: randomUUID(),
			descriptor: session.descriptor(),
			current: session.current(),
			currentMetadata: session.metadata?.() ?? null,
			observations: [],
			observationCount: session.observationCount?.() ?? 0,
		});
	}

	async currentAsync(id: string, signal?: AbortSignal): Promise<Snapshot> {
		signal?.throwIfAborted();
		return this.capture(this.session(id));
	}

	async observationsAsync(id: string, offset = 0, limit = 32, signal?: AbortSignal): Promise<ObservationPage> {
		signal?.throwIfAborted();
		const session = this.session(id);
		const observations = session.observations?.(offset, limit) ?? [];
		return clone({
			version: 1,
			ownerId: this.ownerId,
			sessionId: id,
			start: offset,
			end: offset + observations.length,
			total: session.observationCount?.() ?? 0,
			observations,
		});
	}

	async catalogAsync(offset = 0, limit = 64, signal?: AbortSignal): Promise<Catalog> {
		signal?.throwIfAborted();
		const sessions = this.owner.sessions();
		return clone({
			version: 1,
			hostId: this.owner.hostId,
			ownerId: this.ownerId,
			revision: ++this.revision,
			domains: this.owner.domains(),
			sessions: sessions.slice(offset, offset + limit).map((session) => session.descriptor()),
			...(offset + limit < sessions.length ? { next: offset + limit } : {}),
		});
	}

	async openAsync(id: string, signal?: AbortSignal): Promise<Snapshot> {
		signal?.throwIfAborted();
		const session = this.session(id);
		const view = this.capture(session);
		const source = this.source(session);
		try {
			view.history = source.refresh();
			// Process-local cuts live until the caller releases them or the reader closes.
			this.snapshots.set(view.cutId, {
				view: { descriptor: clone(view.descriptor), history: { ...view.history } },
				source,
			});
		} catch (error) {
			view.error =
				error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message)
					? error.message
					: "SOURCE_UNAVAILABLE";
		}
		return view;
	}

	private snapshot(id: string) {
		const snapshot = this.snapshots.get(id);
		check(snapshot?.view.history, "EXPIRED_OR_UNAVAILABLE_CUT");
		check(
			this.source(this.session(snapshot.view.descriptor.id)) === snapshot.source,
			"STALE_SOURCE",
		);
		return snapshot;
	}

	async pageAsync(id: string, before?: number, limit?: number, signal?: AbortSignal) {
		signal?.throwIfAborted();
		const { view, source } = this.snapshot(id);
		return {
			cutId: id,
			sessionId: view.descriptor.id,
			...source.page(view.history!, before, limit),
		};
	}

	async bodyAsync(
		id: string,
		index: number,
		offset?: number,
		length?: number,
		signal?: AbortSignal,
	) {
		signal?.throwIfAborted();
		const { view, source } = this.snapshot(id);
		return source.body(view.history!, index, offset, length);
	}

	release(id: string): boolean {
		return this.snapshots.delete(id);
	}

	close() {
		this.snapshots.clear();
		this.sources.clear();
	}
}
