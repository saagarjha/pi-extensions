import Foundation

/// Paged-history cache machinery retained for integration; the current live store does not use it.
/// A disposable replica. SQLite access, hashing and decoding run on this actor, never the UI actor.
/// Fetch scheduling belongs to the caller; one ticket per conversation enforces ordered page commits.
public actor ConversationCache {
    public nonisolated let fileURL: URL
    private var connection: SQLiteDatabase?
    private var tickets: [Key: UUID] = [:]
    private var catalogTickets: [String: UUID] = [:]
    private var historyRequests: [Key: UUID] = [:]

    private nonisolated struct Key: Hashable {
        let server: String
        let session: String
    }

    /// Does no I/O. `prepare()` or the first cache operation opens the database on this actor.
    public init(fileURL: URL) { self.fileURL = fileURL }

    public func prepare() throws { _ = try database() }

    private func database() throws -> SQLiteDatabase {
        if let connection { return connection }
        let opened = try SQLiteDatabase(url: fileURL)
        try CacheSchema.prepare(opened)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        try opened.configureCacheJournaling()
        connection = opened
        return opened
    }

    /// Begin before network I/O, not after receiving a response.
    public func beginCatalog(serverURL: URL) throws -> CatalogFetch {
        let server = try origin(serverURL)
        let token = UUID()
        catalogTickets[server] = token
        return CatalogFetch(server: server, token: token)
    }

    public func endCatalog(_ fetch: CatalogFetch) {
        if catalogTickets[fetch.server] == fetch.token { catalogTickets.removeValue(forKey: fetch.server) }
    }

    /// Call only with a complete, ordered catalog traversal (first page through next == nil).
    /// A partial traversal must never delete conversations absent from that partial result.
    /// The current server catalog is not a snapshot across pages; a later refresh reconciles changes.
    public func replaceCatalog(_ fetch: CatalogFetch, pages: [Catalog]) throws {
        let server = fetch.server
        guard catalogTickets[server] == fetch.token else { throw CacheError.staleFetch }
        guard let first = pages.first, pages.last?.next == nil else {
            throw CacheError.invalid("A complete catalog traversal is required")
        }
        var descriptors: [SessionDescriptor] = []
        var seen = Set<String>()
        for (index, page) in pages.enumerated() {
            guard page.version == 1, page.ownerId == first.ownerId, page.hostId == first.hostId else {
                throw CacheError.invalid("Catalog changed owners while fetching")
            }
            for descriptor in page.sessions {
                guard seen.insert(descriptor.id).inserted else {
                    throw CacheError.invalid("Catalog changed while paging; refresh before replacing it")
                }
                descriptors.append(descriptor)
            }
            if index < pages.count - 1 {
                guard page.next == descriptors.count, !page.sessions.isEmpty else {
                    throw CacheError.invalid("Catalog pages are out of order")
                }
            }
        }
        let database = try database()
        var ownerChanged = false
        var invalidated = Set<String>()
        try database.transaction {
            let oldOwner = try database.query("SELECT owner_id FROM servers WHERE endpoint = ?", [.text(server)]).first?["owner_id"]?.string
            ownerChanged = oldOwner != first.ownerId
            try database.execute("""
                INSERT INTO servers(endpoint, owner_id, host_id) VALUES (?, ?, ?)
                ON CONFLICT(endpoint) DO UPDATE SET owner_id = excluded.owner_id, host_id = excluded.host_id
                """, [.text(server), .text(first.ownerId), .text(first.hostId)])
            let rows = try database.query("SELECT session_id, native_id FROM conversations WHERE server = ?", [.text(server)])
            var previous: [String: String] = [:]
            for row in rows {
                guard let id = row["session_id"]?.string, let nativeID = row["native_id"]?.string else {
                    throw CacheError.invalid("Invalid conversation row")
                }
                previous[id] = nativeID
                if !seen.contains(id) {
                    invalidated.insert(id)
                    try database.execute("DELETE FROM conversations WHERE server = ? AND session_id = ?", [.text(server), .text(id)])
                }
            }
            for (ordinal, descriptor) in descriptors.enumerated() {
                // Never merge copies of a native session based on nativeIdentity alone.
                if let nativeID = previous[descriptor.id], nativeID != descriptor.nativeIdentity {
                    invalidated.insert(descriptor.id)
                    try database.execute("DELETE FROM conversations WHERE server = ? AND session_id = ?", [.text(server), .text(descriptor.id)])
                }
                try database.execute("""
                    INSERT INTO conversations(server, session_id, native_id, descriptor, ordinal) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(server, session_id) DO UPDATE SET descriptor = excluded.descriptor, ordinal = excluded.ordinal
                    """, [.text(server), .text(descriptor.id), .text(descriptor.nativeIdentity),
                          .blob(try JSONEncoder().encode(descriptor)), .integer(Int64(ordinal))])
            }
        }
        catalogTickets.removeValue(forKey: server)
        // Metadata-only refreshes must not interrupt an ordered history fetch.
        tickets = tickets.filter {
            $0.key.server != server || (!ownerChanged && !invalidated.contains($0.key.session))
        }
        historyRequests = historyRequests.filter {
            $0.key.server != server || (!ownerChanged && !invalidated.contains($0.key.session))
        }
    }

    public func conversations(serverURL: URL) throws -> [SessionDescriptor] {
        let rows = try database().query("SELECT descriptor FROM conversations WHERE server = ? ORDER BY ordinal", [.text(try origin(serverURL))])
        return try rows.map { row in
            guard let data = row["descriptor"]?.data else { throw CacheError.invalid("Invalid conversation metadata") }
            return try JSONDecoder().decode(SessionDescriptor.self, from: data)
        }
    }

    /// Reserve the conversation before loading archived history. The latest request wins.
    public func beginHistoryRequest(serverURL: URL, sessionID: String) throws -> HistoryRequest {
        let server = try origin(serverURL)
        let row = try database().query("""
            SELECT s.owner_id FROM conversations c JOIN servers s ON c.server = s.endpoint
            WHERE c.server = ? AND c.session_id = ?
            """, [.text(server), .text(sessionID)]).first
        guard let owner = row?["owner_id"]?.string else { throw CacheError.unknownConversation }
        let token = UUID()
        let key = Key(server: server, session: sessionID)
        tickets.removeValue(forKey: key)
        historyRequests[key] = token
        return HistoryRequest(sessionID: sessionID, server: server, ownerID: owner, token: token)
    }

    public func endHistoryRequest(_ request: HistoryRequest) {
        let key = Key(server: request.server, session: request.sessionID)
        if historyRequests[key] == request.token { historyRequests.removeValue(forKey: key) }
    }

    /// Accepts the response to a still-current request. No temporary server identifiers are persisted.
    /// A matching count/root verifies an existing cached suffix, even after server restart.
    public func beginHistory(_ request: HistoryRequest, snapshot: Snapshot) throws -> HistoryFetch {
        let server = request.server
        guard historyRequests[Key(server: server, session: request.sessionID)] == request.token,
              snapshot.ownerId == request.ownerID, snapshot.descriptor.id == request.sessionID else {
            throw CacheError.staleFetch
        }
        guard let history = snapshot.history else {
            throw CacheError.invalid(snapshot.error ?? "History is unavailable")
        }
        let database = try database()
        try database.transaction {
            let row = try database.query("""
                SELECT c.native_id, s.owner_id FROM conversations c JOIN servers s ON c.server = s.endpoint
                WHERE c.server = ? AND c.session_id = ?
                """, [.text(server), .text(snapshot.descriptor.id)]).first
            guard let row else { throw CacheError.unknownConversation }
            guard row["owner_id"]?.string == snapshot.ownerId,
                  row["native_id"]?.string == snapshot.descriptor.nativeIdentity else { throw CacheError.staleFetch }
            if history.count == 0 {
                try invalidate(database, server: server, session: snapshot.descriptor.id)
                try putState(database, server: server, session: snapshot.descriptor.id, count: 0,
                             root: history.root, start: 0, prefix: history.root, owner: snapshot.ownerId)
            } else if let cached = try state(database, server: server, session: snapshot.descriptor.id),
                      cached.recordCount == history.count, cached.root == history.root {
                try putState(database, server: server, session: snapshot.descriptor.id, count: cached.recordCount,
                             root: cached.root, start: cached.start, prefix: cached.prefixRoot, owner: snapshot.ownerId)
            }
            // If the head changed, keep old cached content available until a verified new page arrives.
        }
        let fetch = HistoryFetch(sessionID: snapshot.descriptor.id, cutID: snapshot.cutId,
                                 recordCount: history.count, root: history.root, server: server,
                                 ownerID: snapshot.ownerId, token: request.token)
        let key = Key(server: server, session: fetch.sessionID)
        historyRequests.removeValue(forKey: key)
        tickets[key] = fetch.token
        return fetch
    }

    public func fetchPosition(for fetch: HistoryFetch) throws -> HistoryFetchPosition {
        let database = try database()
        try check(fetch, database: database)
        return try position(fetch, database: database)
    }

    /// Ending a fetch does not delete its cache. Server cut release remains the API caller's responsibility.
    public func endHistory(_ fetch: HistoryFetch) {
        let key = Key(server: fetch.server, session: fetch.sessionID)
        if tickets[key] == fetch.token { tickets.removeValue(forKey: key) }
    }

    /// Atomically commits one complete page and advances its contiguous verified suffix.
    /// Pages must arrive newest-first, then immediately preceding the current suffix. No holes.
    public func store(page: HistoryPage, records: [HistoryRecord], for fetch: HistoryFetch) throws {
        assert(page.cutId == fetch.cutID && page.sessionId == fetch.sessionID)
        assert(records.count == page.records.count)
        // These are already decoded API records. Store their bytes and typed index fields directly.
        let database = try database()
        try database.transaction {
            try check(fetch, database: database)
            let expected = try position(fetch, database: database)
            guard page.end == expected.before, page.endRoot == expected.expectedEndRoot else {
                throw CacheError.invalid("History pages must be committed in order")
            }
            let old = try state(database, server: fetch.server, session: fetch.sessionID)
            let sameHead = old?.root == fetch.root && old?.recordCount == fetch.recordCount
            var start = page.start
            var prefix = page.prefixRoot
            if !sameHead {
                // Common append case: reuse the cached prefix only after proving the join by its chain root.
                if let old, old.start <= page.start, page.start <= old.recordCount {
                    let boundary: String?
                    if page.start == old.start { boundary = old.prefixRoot }
                    else {
                        boundary = try database.query("SELECT chain_root FROM history_entries WHERE server = ? AND session_id = ? AND position = ?",
                            [.text(fetch.server), .text(fetch.sessionID), .integer(Int64(page.start - 1))]).first?["chain_root"]?.string
                    }
                    if boundary == page.prefixRoot { start = old.start; prefix = old.prefixRoot }
                }
                if start == page.start {
                    try invalidate(database, server: fetch.server, session: fetch.sessionID)
                } else {
                    try database.execute("DELETE FROM history_entries WHERE server = ? AND session_id = ? AND position >= ?",
                        [.text(fetch.server), .text(fetch.sessionID), .integer(Int64(page.start))])
                }
            }
            for record in records {
                try database.execute("""
                    INSERT INTO records(hash, body, native_id, parent_id, kind) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(hash) DO NOTHING
                    """, [.text(record.reference.hash), .blob(record.data), sqlText(record.value.id),
                          sqlText(record.value.parentId), .text(record.value.type)])
                try database.execute("INSERT INTO history_entries(server, session_id, position, record_hash, chain_root) VALUES (?, ?, ?, ?, ?)",
                    [.text(fetch.server), .text(fetch.sessionID), .integer(Int64(record.reference.index)),
                     .text(record.reference.hash), .text(record.reference.root)])
            }
            try putState(database, server: fetch.server, session: fetch.sessionID, count: fetch.recordCount,
                         root: fetch.root, start: start, prefix: prefix, owner: fetch.ownerID)
        }
    }

    public func history(serverURL: URL, sessionID: String) throws -> CachedHistory? {
        try state(database(), server: origin(serverURL), session: sessionID)
    }

    /// Only the cached suffix is returned. Its status is available separately via history().
    public func records(serverURL: URL, sessionID: String, before: Int? = nil, limit: Int = 32) throws -> [CachedRecord] {
        precondition(limit > 0 && (before == nil || before! >= 0))
        let rows = try database().query("""
            SELECT e.position, e.record_hash, e.chain_root, r.body
            FROM history_entries e JOIN records r ON r.hash = e.record_hash
            WHERE e.server = ? AND e.session_id = ? AND (? IS NULL OR e.position < ?)
            ORDER BY e.position DESC LIMIT ?
            """, [.text(try origin(serverURL)), .text(sessionID), before.map { .integer(Int64($0)) } ?? .null,
                  before.map { .integer(Int64($0)) } ?? .null, .integer(Int64(limit))])
        return try rows.reversed().map { row in
            guard let index = row["position"]?.int64, let hash = row["record_hash"]?.string,
                  let root = row["chain_root"]?.string, let data = row["body"]?.data else {
                throw CacheError.invalid("Invalid cached record")
            }
            return CachedRecord(reference: RecordReference(index: Int(index), hash: hash, bytes: data.count, root: root),
                                data: data, value: try JSONDecoder().decode(NativeRecord.self, from: data))
        }
    }

    /// Reuse a verified immutable body when another cut references the same hash.
    public func record(matching reference: RecordReference) throws -> HistoryRecord? {
        guard let data = try database().query("SELECT body FROM records WHERE hash = ?", [.text(reference.hash)]).first?["body"]?.data else { return nil }
        return HistoryRecord(reference: reference, data: data, value: try JSONDecoder().decode(NativeRecord.self, from: data))
    }

    /// Discard one source's cached ordering without removing its sidebar metadata.
    public func clearHistory(serverURL: URL, sessionID: String) throws {
        let server = try origin(serverURL)
        let database = try database()
        try database.transaction { try invalidate(database, server: server, session: sessionID) }
        let key = Key(server: server, session: sessionID)
        tickets.removeValue(forKey: key)
        historyRequests.removeValue(forKey: key)
    }

    public func clear(serverURL: URL) throws {
        let server = try origin(serverURL)
        try database().execute("DELETE FROM servers WHERE endpoint = ?", [.text(server)])
        catalogTickets.removeValue(forKey: server)
        tickets = tickets.filter { $0.key.server != server }
        historyRequests = historyRequests.filter { $0.key.server != server }
    }

    /// Bounded garbage collection, suitable for idle time; never part of a foreground fetch.
    public func pruneUnreferencedRecords(limit: Int = 1_000) throws {
        precondition(limit > 0)
        try database().execute("""
            DELETE FROM records WHERE hash IN (
                SELECT r.hash FROM records r WHERE NOT EXISTS (
                    SELECT 1 FROM history_entries e WHERE e.record_hash = r.hash
                ) LIMIT ?
            )
            """, [.integer(Int64(limit))])
    }

    private func check(_ fetch: HistoryFetch, database: SQLiteDatabase) throws {
        guard tickets[Key(server: fetch.server, session: fetch.sessionID)] == fetch.token,
              try database.query("SELECT owner_id FROM servers WHERE endpoint = ?", [.text(fetch.server)]).first?["owner_id"]?.string == fetch.ownerID else {
            throw CacheError.staleFetch
        }
    }

    private func position(_ fetch: HistoryFetch, database: SQLiteDatabase) throws -> HistoryFetchPosition {
        if let cached = try state(database, server: fetch.server, session: fetch.sessionID),
           cached.recordCount == fetch.recordCount, cached.root == fetch.root {
            return HistoryFetchPosition(before: cached.start, expectedEndRoot: cached.prefixRoot)
        }
        return HistoryFetchPosition(before: fetch.recordCount, expectedEndRoot: fetch.root)
    }

    private func state(_ database: SQLiteDatabase, server: String, session: String) throws -> CachedHistory? {
        guard let row = try database.query("SELECT * FROM history_state WHERE server = ? AND session_id = ?", [.text(server), .text(session)]).first else { return nil }
        guard let count = row["record_count"]?.int64, let root = row["root"]?.string,
              let start = row["start"]?.int64, let prefix = row["prefix_root"]?.string,
              let owner = row["verified_owner"]?.string else { throw CacheError.invalid("Invalid cache history state") }
        return CachedHistory(recordCount: Int(count), root: root, start: Int(start), prefixRoot: prefix, verifiedOwnerId: owner)
    }

    private func putState(_ database: SQLiteDatabase, server: String, session: String, count: Int, root: String, start: Int, prefix: String, owner: String) throws {
        try database.execute("""
            INSERT INTO history_state(server, session_id, record_count, root, start, prefix_root, verified_owner)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(server, session_id) DO UPDATE SET record_count = excluded.record_count,
                root = excluded.root, start = excluded.start, prefix_root = excluded.prefix_root, verified_owner = excluded.verified_owner
            """, [.text(server), .text(session), .integer(Int64(count)), .text(root), .integer(Int64(start)), .text(prefix), .text(owner)])
    }

    private func invalidate(_ database: SQLiteDatabase, server: String, session: String) throws {
        let bindings: [SQLiteValue] = [.text(server), .text(session)]
        try database.execute("DELETE FROM history_entries WHERE server = ? AND session_id = ?", bindings)
        try database.execute("DELETE FROM history_state WHERE server = ? AND session_id = ?", bindings)
    }

    private func sqlText(_ value: String?) -> SQLiteValue { value.map(SQLiteValue.text) ?? .null }

    private func origin(_ url: URL) throws -> String {
        guard var value = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = value.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = value.host?.lowercased(), !host.isEmpty, value.user == nil, value.password == nil,
              value.query == nil, value.fragment == nil, value.path.isEmpty || value.path == "/" else {
            throw CacheError.invalid("Expected a server origin")
        }
        value.scheme = scheme
        value.host = host
        value.path = ""
        if value.port == (scheme == "http" ? 80 : 443) { value.port = nil }
        guard let result = value.string else { throw CacheError.invalid("Invalid server origin") }
        return result
    }
}
