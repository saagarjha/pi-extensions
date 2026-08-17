import { createHash } from "node:crypto";
export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| {
			[key: string]: Json;
	  };
export interface SessionDescriptor {
	id: string;
	parentId?: string;
	nativeIdentity: string;
	title?: string;
}
export interface SourceDeclaration {
	readonly path?: string;
}
export interface Observation {
	nativeIdentity: string;
	record: Json;
}
export interface SessionPort {
	descriptor(): SessionDescriptor;
	source(): SourceDeclaration;
	current(): Json;
	metadata?(): Json;
	/** Complete memory observations; does not imply either persisted or unpersisted. */
	observationCount?(): number;
	observations?(offset?: number, limit?: number): readonly Observation[];
}
export interface OwnerPort {
	readonly hostId: string;
	sessions(): readonly SessionPort[];
	domains(): Json;
	subscribe?(listener: () => void): () => void;
}
export const hash = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
export const EMPTY = hash("read-replica-v1");
export const chain = (a: string, b: string) => hash(a + ":" + b);
export function check(v: unknown, code: string): asserts v {
	if (!v) throw new Error(code);
}
export interface Range {
	generation: string;
	count: number;
	root: string;
}
export interface RecordRef {
	index: number;
	hash: string;
	bytes: number;
	root: string;
}
export interface Catalog {
	version: 1;
	hostId: string;
	ownerId: string;
	revision: number;
	domains: Json;
	sessions: SessionDescriptor[];
	next?: number;
}
export interface Snapshot {
	version: 1;
	hostId: string;
	ownerId: string;
	revision: number;
	cutId: string;
	descriptor: SessionDescriptor;
	current: Json;
	currentMetadata?: Json;
	/** Records are fetched separately, on demand, rather than bundled with metadata. */
	observations: readonly Observation[];
	observationCount: number;
	history?: Range;
	error?: string;
}
export interface ObservationPage {
	version: 1;
	ownerId: string;
	sessionId: string;
	start: number;
	end: number;
	total: number;
	observations: readonly Observation[];
}
export interface Page {
	cutId: string;
	sessionId: string;
	start: number;
	end: number;
	prefixRoot: string;
	endRoot: string;
	records: RecordRef[];
}
export interface BodyChunk {
	hash: string;
	offset: number;
	total: number;
	data: string;
}
/** Overlay reconciliation is by native entry identity, never body equality. A client
 * may call this with identities from the pages it has actually materialized. */
export function pendingObservations(
	view: Snapshot,
	knownEntryIds: ReadonlySet<string>,
): Observation[] {
	return view.observations.filter((o) => !knownEntryIds.has(o.nativeIdentity));
}
