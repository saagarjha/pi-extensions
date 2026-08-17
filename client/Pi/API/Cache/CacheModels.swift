import Foundation

public nonisolated enum CacheError: LocalizedError, Sendable {
    case foreignDatabase
    case invalid(String)
    case staleFetch
    case unknownConversation

    public var errorDescription: String? {
        switch self {
        case .foreignDatabase: "The selected database is not a Pi cache."
        case .invalid(let reason): reason
        case .staleFetch: "This cache fetch is no longer current."
        case .unknownConversation: "Refresh the conversation catalog before fetching its history."
        }
    }
}

/// A verified contiguous suffix of one server history. Missing earlier records are not implied.
public nonisolated struct CachedHistory: Sendable {
    public let recordCount: Int
    public let root: String
    public let start: Int
    public let prefixRoot: String
    public let verifiedOwnerId: String
    public var isComplete: Bool { start == 0 }
}

/// Issue before requesting the first catalog page. A newer request supersedes this one.
public nonisolated struct CatalogFetch: Sendable {
    let server: String
    let token: UUID
}

/// Issue before opening server history, so a late snapshot cannot replace a newer one.
public nonisolated struct HistoryRequest: Sendable {
    public let sessionID: String
    let server: String
    let ownerID: String
    let token: UUID
}

/// Process-local authority to populate a cache entry from a particular server cut.
/// Neither this ticket nor server cut/generation tokens are written to SQLite.
public nonisolated struct HistoryFetch: Sendable {
    public let sessionID: String
    public let cutID: String
    public let recordCount: Int
    public let root: String
    let server: String
    let ownerID: String
    let token: UUID
}

public nonisolated struct HistoryFetchPosition: Sendable {
    public let before: Int
    public let expectedEndRoot: String
    public var isComplete: Bool { before == 0 }
}

/// Only requested bodies are materialized. Metadata queries never load these bytes.
public nonisolated struct CachedRecord: Sendable {
    public let reference: RecordReference
    public let data: Data
    /// Decoded by the cache actor, not by a view's body or a main-actor getter.
    public let value: NativeRecord
}
