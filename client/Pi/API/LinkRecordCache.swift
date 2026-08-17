import Foundation
import CryptoKit

/// Disposable native-content replica, never session/control authority. Application Support
/// (not OS-purgeable Caches), excluded from backup, private permissions / iOS protection.
/// Every canonical commit is durable before delivery; no termination callback is needed.
/// No automatic disk eviction. Explicit credential forget/purge removes that namespace.
/// Decoded memory may be released independently: disk-resident content is still advertised.
actor LinkRecordCache {
    static let shared = LinkRecordCache()
    nonisolated let fileURL: URL
    private var connection: SQLiteDatabase?
    private var decoded: [String: [String: NativeRecord]] = [:]
    private var inventories: [String: Set<String>] = [:]
    private var dataVersion: Int64?
    private struct Cut { var keys: [String]; var root: String }
    private struct StreamCut { let authority: String; let session: String; var count: Int; var root: String }
    private var cuts: [String: Cut] = [:]
    private var streams: [String: StreamCut] = [:]
    private var retiredStreams = Set<String>()
    private(set) var receivedPayloadBytes = 0

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Pi/ImmutableTranscript/content.sqlite")
    }
    private static func hex(_ digest: SHA256.Digest) -> String {
        // Inventory validation visits many small records; avoid 32 Foundation format
        // allocations per digest on every mobile/app relaunch.
        var bytes: [UInt8] = []; bytes.reserveCapacity(64)
        for byte in digest {
            let high = byte >> 4, low = byte & 15
            bytes.append(high < 10 ? high + 48 : high + 87)
            bytes.append(low < 10 ? low + 48 : low + 87)
        }
        return String(decoding: bytes, as: UTF8.self)
    }
    private static func hash(_ data: Data) -> String { hex(SHA256.hash(data: data)) }
    static func namespace(_ authority: String) -> String { hash(Data(authority.utf8)) }
    static func remoteAuthority(origin: String, credential: String, certificate: Data) -> String {
        origin + ":" + hash(Data(credential.utf8) + certificate)
    }
    private static let emptyRoot = hash(Data("pi-immutable-manifest-v1".utf8))
    private static func extended(_ root: String, _ key: String) -> String { hash(Data((root + key).utf8)) }
    private static func validKey(_ key: String) -> Bool {
        key.hasPrefix("json-sha256-v1:") && key.utf8.count == 79
            && key.dropFirst(15).utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private static func integrity(_ authority: String, _ key: String, _ body: Data) -> String {
        var hash = SHA256()
        hash.update(data: Data((authority + "\0" + key + "\0").utf8)); hash.update(data: body)
        return hex(hash.finalize())
    }
    private static func headChecksum(_ authority: String, _ session: String, _ count: Int, _ root: String) -> String {
        hash(Data((authority + "\0" + session + "\0" + String(count) + "\0" + root).utf8))
    }
    private func database() throws -> SQLiteDatabase {
        if let connection { return connection }
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        var protectedDirectory = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try protectedDirectory.setResourceValues(values)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        #endif
        let db = try SQLiteDatabase(url: fileURL)
        let application = try db.query("PRAGMA application_id").first?["application_id"]?.int64 ?? 0
        let version = try db.query("PRAGMA user_version").first?["user_version"]?.int64 ?? 0
        let tables = try db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        if application == 0 && version == 0 && tables.isEmpty {
            try db.transaction {
                try db.execute("CREATE TABLE immutable_records (authority TEXT NOT NULL, key TEXT NOT NULL, body BLOB NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(authority,key))")
                try db.execute("CREATE TABLE manifest_heads (authority TEXT NOT NULL, session TEXT NOT NULL, count INTEGER NOT NULL, root TEXT NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(authority,session))")
                try db.execute("CREATE TABLE manifest_entries (authority TEXT NOT NULL, session TEXT NOT NULL, position INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY(authority,session,position))")
                try db.execute("PRAGMA application_id = 1346980163") // PIIC
                try db.execute("PRAGMA user_version = 1")
            }
        } else if application != 1346980163 || version != 1 {
            // Never discard an unknown format and silently redownload known history.
            throw LinkFailure("Unsupported or foreign immutable cache database")
        }
        // Group labels are hashed endpoint identities, never credentials. They let an
        // explicit Forget remove old credential incarnations at this same endpoint too.
        try db.execute("CREATE TABLE IF NOT EXISTS authority_groups (authority TEXT PRIMARY KEY, group_key TEXT NOT NULL)")
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        try db.configureCacheJournaling()
        try db.execute("PRAGMA synchronous = FULL")
        connection = db
        return db
    }
    private func refreshExternalChanges(_ db: SQLiteDatabase) throws {
        let version = try db.query("PRAGMA data_version").first?["data_version"]?.int64
        if let dataVersion, dataVersion != version {
            inventories.removeAll(); cuts.removeAll(); decoded.removeAll()
        }
        dataVersion = version
    }
    /// Only integrity-checked, actually present disk rows are offered to an authenticated owner.
    /// Stream rows rather than loading a transcript-sized collection of raw blobs.
    func known(in authority: String, prefetchSession: String? = nil) throws -> [String] {
        let scope = Self.namespace(authority), db = try database()
        try refreshExternalChanges(db)
        if let known = inventories[scope] { return Array(known) }
        let prefetch: Set<String>
        if let prefetchSession { prefetch = Set(try loadCut(scope: scope, session: prefetchSession, db: db)?.keys ?? []) }
        else { prefetch = [] }
        var good = Set<String>(), bad: [String] = []
        try db.forEachRow("SELECT key,body,checksum FROM immutable_records WHERE authority = ?", [.text(scope)]) { row in
            guard let key = row["key"]?.string else { throw LinkFailure("Invalid immutable cache key row") }
            if Self.validKey(key), let body = row["body"]?.data,
               row["checksum"]?.string == Self.integrity(scope, key, body) {
                // The persisted verified cut lets a relaunched client decode its likely
                // session during the integrity pass, without rereading every raw body.
                if prefetch.contains(key) {
                    do { decoded[scope, default: [:]][key] = try JSONDecoder().decode(NativeRecord.self, from: body) }
                    catch {
                        // An app schema change is not evidence that immutable wire bytes
                        // changed. Preserve checksum-valid content instead of refetching it.
                        throw LinkFailure("Cached native JSON is incompatible with this client; bytes preserved. Update the client rather than redownloading known content.")
                    }
                }
                good.insert(key)
            } else { bad.append(key) }
        }
        if !bad.isEmpty {
            try db.transaction {
                for key in bad {
                    try db.execute("DELETE FROM immutable_records WHERE authority = ? AND key = ?", [.text(scope), .text(key)])
                    decoded[scope]?.removeValue(forKey: key)
                }
            }
        }
        inventories[scope] = good
        return Array(good)
    }
    func count(in authority: String) throws -> Int { try known(in: authority).count }
    /// Memory pressure is not disk eviction and must not cause a history download.
    func releaseDecodedMemory() { decoded.removeAll() }
    func endStream(_ id: String) { retiredStreams.insert(id); streams.removeValue(forKey: id) }

    /// Caller must close this authority's streams before explicitly forgetting credentials.
    /// Disconnect/backgrounding does NOT purge content; only an explicit forget does.
    func register(authority: String, group: String) throws {
        try database().execute("INSERT OR IGNORE INTO authority_groups(authority,group_key) VALUES (?,?)",
                               [.text(Self.namespace(authority)), .text(Self.namespace(group))])
    }
    func purge(group: String) throws {
        let scopes = try database().query("SELECT authority FROM authority_groups WHERE group_key = ?", [.text(Self.namespace(group))])
        for row in scopes { if let scope = row["authority"]?.string { try purgeScope(scope) } }
        // A previous purge may have committed its deletes but found a busy WAL reader.
        // Retrying after credentials/group rows are gone must still finish the checkpoint.
        if scopes.isEmpty { try checkpointAfterPurge(try database()) }
    }
    func purge(authority: String) throws { try purgeScope(Self.namespace(authority)) }
    private func purgeScope(_ scope: String) throws {
        let db = try database()
        try db.execute("PRAGMA secure_delete = ON")
        try db.transaction {
            for table in ["immutable_records", "manifest_heads", "manifest_entries", "authority_groups"] {
                try db.execute("DELETE FROM \(table) WHERE authority = ?", [.text(scope)])
            }
        }
        decoded.removeValue(forKey: scope); inventories.removeValue(forKey: scope)
        cuts = cuts.filter { !$0.key.hasPrefix(scope + "\0") }
        for (id, cut) in streams where cut.authority == scope { retiredStreams.insert(id) }
        streams = streams.filter { $0.value.authority != scope }
        try checkpointAfterPurge(db)
    }
    private func checkpointAfterPurge(_ db: SQLiteDatabase) throws {
        // Clear obsolete WAL copies as well. A still-active reader must close before Forget.
        let checkpoint = try db.query("PRAGMA wal_checkpoint(TRUNCATE)").first
        if checkpoint?["busy"]?.int64 != 0 { throw LinkFailure("Close other cache readers before forgetting this endpoint") }
    }
    private func loadRecord(_ key: String, scope: String, db: SQLiteDatabase) throws -> NativeRecord {
        if let record = decoded[scope]?[key] { return record }
        if let row = try db.query("SELECT body,checksum FROM immutable_records WHERE authority = ? AND key = ?", [.text(scope), .text(key)]).first,
           let body = row["body"]?.data, row["checksum"]?.string == Self.integrity(scope, key, body) {
            do {
                let record = try JSONDecoder().decode(NativeRecord.self, from: body)
                decoded[scope, default: [:]][key] = record
                return record
            } catch {
                throw LinkFailure("Cached native JSON is incompatible with this client; verified raw bytes were retained")
            }
        }
        // A row can disappear/corrupt between advertisement and delivery. Invalidate only
        // that row; the next explicit reconnect advertises all the other healthy records.
        try db.execute("DELETE FROM immutable_records WHERE authority = ? AND key = ?", [.text(scope), .text(key)])
        inventories[scope]?.remove(key)
        throw LinkFailure("Immutable cache item missing or damaged; reconnect to fetch only missing records")
    }
    private func loadCut(scope: String, session: String, db: SQLiteDatabase) throws -> Cut? {
        let identity = scope + "\0" + session
        if let cut = cuts[identity] { return cut }
        guard let head = try db.query("SELECT count,root,checksum FROM manifest_heads WHERE authority = ? AND session = ?", [.text(scope), .text(session)]).first,
              let rawCount = head["count"]?.int64, let count = Int(exactly: rawCount), count >= 0,
              let root = head["root"]?.string,
              head["checksum"]?.string == Self.headChecksum(scope, session, count, root) else { return nil }
        var keys: [String] = [], checkedRoot = Self.emptyRoot, valid = true
        try db.forEachRow("SELECT position,key FROM manifest_entries WHERE authority = ? AND session = ? ORDER BY position", [.text(scope), .text(session)]) { row in
            guard row["position"]?.int64 == Int64(keys.count), let key = row["key"]?.string, Self.validKey(key) else { valid = false; return }
            keys.append(key); checkedRoot = Self.extended(checkedRoot, key)
        }
        guard valid, keys.count == count, checkedRoot == root else { return nil }
        let cut = Cut(keys: keys, root: root); cuts[identity] = cut; return cut
    }
    /// Historical verified metadata only, never a current leaf/lease/connection assertion.
    func verifiedManifest(authority: String, session: String) throws -> [String]? {
        let healthy = Set(try known(in: authority)), db = try database()
        guard let keys = try loadCut(scope: Self.namespace(authority), session: session, db: db)?.keys,
              keys.allSatisfy(healthy.contains) else { return nil }
        return keys
    }
    private func writeHead(scope: String, session: String, count: Int, root: String, db: SQLiteDatabase) throws {
        try db.execute("INSERT OR REPLACE INTO manifest_heads(authority,session,count,root,checksum) VALUES (?,?,?,?,?)",
                       [.text(scope), .text(session), .integer(Int64(count)), .text(root), .text(Self.headChecksum(scope, session, count, root))])
    }
    /// One storage implementation for roots, live children, and dormant archives.
    private func resolveCut(entries: [NativeRecord], cut: LinkSnapshot.ImmutableCut, sessionID: String,
                            authority: String, rawEntries: [String]) throws -> (entries: [NativeRecord], root: String) {
        guard cut.missingKeys.count == entries.count,
              cut.entryKeys.allSatisfy(Self.validKey), cut.missingKeys.allSatisfy(Self.validKey),
              Set(cut.missingKeys).count == cut.missingKeys.count,
              Set(cut.missingKeys).isSubset(of: Set(cut.entryKeys)) else { throw LinkFailure("Invalid immutable transcript cut") }
        guard rawEntries.count == cut.missingKeys.count else { throw LinkFailure("Immutable wire record count mismatch") }
        let db = try database(), scope = Self.namespace(authority)
        try refreshExternalChanges(db)
        let prior = try loadCut(scope: scope, session: sessionID, db: db)
        var root = Self.emptyRoot
        for key in cut.entryKeys { root = Self.extended(root, key) }
        // Resolve cached values before committing a new cut; an advertised missing row
        // must not make a partial cut durable. Supplied values remain transaction-local.
        let supplied = Dictionary(uniqueKeysWithValues: zip(cut.missingKeys, entries))
        let resolved = try cut.entryKeys.map { key in
            if let value = supplied[key] { return value }
            return try loadRecord(key, scope: scope, db: db)
        }
        // Publish possession only after the entire cut is durable. One atomic
        // transaction preserves the manifest and body boundary without repeating
        // a FULL synchronization for every small group of immutable records.
        try Task.checkCancellation()
        try db.transaction {
            for index in cut.missingKeys.indices {
                try Task.checkCancellation()
                let key = cut.missingKeys[index], body = Data(rawEntries[index].utf8)
                try db.execute("INSERT OR REPLACE INTO immutable_records(authority,key,body,checksum) VALUES (?,?,?,?)",
                               [.text(scope), .text(key), .blob(body), .text(Self.integrity(scope, key, body))])
            }
            try Task.checkCancellation()
            if prior?.keys != cut.entryKeys {
                if prior == nil {
                    // Unverified metadata may contain holes or invalid positions.
                    // Replace only that manifest, never the reusable record bodies.
                    try db.execute("DELETE FROM manifest_entries WHERE authority = ? AND session = ?",
                                   [.text(scope), .text(sessionID)])
                }
                for (position, key) in cut.entryKeys.enumerated() where prior?.keys.indices.contains(position) != true || prior?.keys[position] != key {
                    try Task.checkCancellation()
                    try db.execute("INSERT OR REPLACE INTO manifest_entries(authority,session,position,key) VALUES (?,?,?,?)",
                                   [.text(scope), .text(sessionID), .integer(Int64(position)), .text(key)])
                }
                try db.execute("DELETE FROM manifest_entries WHERE authority = ? AND session = ? AND position >= ?",
                               [.text(scope), .text(sessionID), .integer(Int64(cut.entryKeys.count))])
                try writeHead(scope: scope, session: sessionID, count: cut.entryKeys.count, root: root, db: db)
            }
        }
        for index in cut.missingKeys.indices {
            let key = cut.missingKeys[index]
            decoded[scope, default: [:]][key] = entries[index]; inventories[scope]?.insert(key)
        }
        cuts[scope + "\0" + sessionID] = Cut(keys: cut.entryKeys, root: root)
        return (resolved, root)
    }
    func resolveChildView(_ incoming: LinkChildView, authority: String, payload: Data, streamID: String) throws -> LinkChildView {
        guard !retiredStreams.contains(streamID) else { throw LinkFailure("Child read connection retired before cache commit") }
        receivedPayloadBytes += payload.count
        var view = incoming
        if var snapshot = view.snapshot, let cut = snapshot.immutable {
            snapshot.entries = try resolveCut(entries: snapshot.entries, cut: cut, sessionID: snapshot.sessionId,
                                              authority: authority, rawEntries: snapshot.entryJSON).entries
            snapshot.entryJSON = []
            view.snapshot = snapshot
        } else if var archive = view.archive, let cut = archive.immutable, let id = archive.header?.id {
            archive.entries = try resolveCut(entries: archive.entries, cut: cut, sessionID: id,
                                             authority: authority, rawEntries: archive.entryJSON).entries
            archive.entryJSON = []
            view.archive = archive
        } else { throw LinkFailure("Missing child immutable transcript cut", code: "CHILD_IMMUTABLE_SYNC_UNSUPPORTED") }
        return view
    }
    func resolve(_ incoming: LinkIncomingFrame, authority: String, payload: Data, streamID: String, path: [String] = [], trackStream: Bool = true) throws -> LinkIncomingFrame {
        guard !retiredStreams.contains(streamID) else { throw LinkFailure("Connection retired before cache commit") }
        if path.isEmpty { receivedPayloadBytes += payload.count }
        var frame = incoming
        // Mutable live/control/services/events are not persisted or treated as reusable authority.
        switch frame.payload {
        case .snapshot(var snapshot):
            guard let cut = snapshot.immutable else { throw LinkFailure("Missing immutable transcript cut") }
            let resolved = try resolveCut(entries: snapshot.entries, cut: cut, sessionID: snapshot.sessionId,
                                          authority: authority, rawEntries: snapshot.entryJSON)
            if trackStream {
                streams[streamID] = StreamCut(authority: Self.namespace(authority), session: snapshot.sessionId,
                                              count: cut.entryKeys.count, root: resolved.root)
            }
            snapshot.entries = resolved.entries; snapshot.entryJSON = []; frame.payload = .snapshot(snapshot)
        case .childFrame(var event):
            event.frame = try resolve(event.frame, authority: authority, payload: payload, streamID: streamID,
                                      path: path + ["event", "frame"], trackStream: false)
            frame.payload = .childFrame(event)
        case .append:
            throw LinkFailure("Unresolved immutable append")
        case .immutableAppend(let key, let supplied):
            guard Self.validKey(key) else { throw LinkFailure("Invalid immutable record key") }
            let db = try database(), scope = Self.namespace(authority)
            try refreshExternalChanges(db)
            let tracked = trackStream ? streams[streamID] : nil
            if trackStream && (tracked?.authority != scope || tracked?.session != frame.sessionId) {
                throw LinkFailure("Immutable append without a verified stream cut")
            }
            let body = supplied.map { Data($0.utf8) }
            let record = try body.map { try JSONDecoder().decode(NativeRecord.self, from: $0) }
                ?? loadRecord(key, scope: scope, db: db)
            let nextRoot = tracked.map { Self.extended($0.root, key) }
            var extendsHead = false
            try db.transaction {
                if let body {
                    try db.execute("INSERT OR REPLACE INTO immutable_records(authority,key,body,checksum) VALUES (?,?,?,?)",
                                   [.text(scope), .text(key), .blob(body), .text(Self.integrity(scope, key, body))])
                }
                if let stream = tracked, let nextRoot {
                let head = try db.query("SELECT count,root,checksum FROM manifest_heads WHERE authority = ? AND session = ?", [.text(scope), .text(stream.session)]).first
                // Two connections may receive the same append at different times. Never
                // append it twice or mix a retired/replaced cut into another stream's head.
                extendsHead = head?["count"]?.int64 == Int64(stream.count) && head?["root"]?.string == stream.root
                    && head?["checksum"]?.string == Self.headChecksum(scope, stream.session, stream.count, stream.root)
                if extendsHead {
                    try db.execute("INSERT OR REPLACE INTO manifest_entries(authority,session,position,key) VALUES (?,?,?,?)",
                                   [.text(scope), .text(stream.session), .integer(Int64(stream.count)), .text(key)])
                    try writeHead(scope: scope, session: stream.session, count: stream.count + 1, root: nextRoot, db: db)
                }
                }
            }
            decoded[scope, default: [:]][key] = record; inventories[scope]?.insert(key)
            if var stream = tracked, let nextRoot {
            let identity = scope + "\0" + stream.session
            if extendsHead, cuts[identity]?.root == stream.root { cuts[identity]?.keys.append(key); cuts[identity]?.root = nextRoot }
            else { cuts.removeValue(forKey: identity) }
            stream.count += 1; stream.root = nextRoot; streams[streamID] = stream
            }
            // HTTP and SSE may cross. Unbased child bodies are durable immediately;
            // only complete authenticated cuts establish their durable ordering.
            frame.payload = .append(record)
        default: break
        }
        return frame
    }
}
