import Foundation

// Paged-history values retained for cache integration; this is not an alternate transport.
public nonisolated struct HistoryRecord: Sendable {
    public let reference: RecordReference
    /// Original native JSON bytes, retained for the cache without re-encoding the model.
    public let data: Data
    public let value: NativeRecord
}

extension Snapshot {
    public func pendingObservations(knownEntryIDs: Set<String>) -> [Observation] {
        observations.filter { !knownEntryIDs.contains($0.nativeIdentity) }
    }
}

