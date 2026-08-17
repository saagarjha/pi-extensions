import Foundation

/// This is disposable data, not a user document. Bump the format to discard it, never migrate it.
nonisolated enum CacheSchema {
    static let version = 1
    static let applicationID = 0x50494348 // PICH

    static func prepare(_ database: SQLiteDatabase) throws {
        let application = try database.query("PRAGMA application_id").first?["application_id"]?.int64 ?? 0
        let format = try database.query("PRAGMA user_version").first?["user_version"]?.int64 ?? 0
        let tables = try database.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        guard application == applicationID || (application == 0 && format == 0 && tables.isEmpty) else {
            throw CacheError.foreignDatabase
        }
        if application == applicationID && format == version { return }
        // Foreign keys must be switched outside the transaction when discarding an older format.
        try database.execute("PRAGMA foreign_keys = OFF")
        do {
            try database.transaction {
                for table in tables {
                    guard let name = table["name"]?.string else { throw CacheError.invalid("Invalid cache schema") }
                    let quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
                    try database.execute("DROP TABLE \"\(quoted)\"")
                }
                for statement in statements { try database.execute(statement) }
                try database.execute("PRAGMA application_id = \(applicationID)")
                try database.execute("PRAGMA user_version = \(version)")
            }
        } catch {
            try? database.execute("PRAGMA foreign_keys = ON")
            throw error
        }
        try database.execute("PRAGMA foreign_keys = ON")
    }

    private static let statements = [
        """
        CREATE TABLE servers (
            endpoint TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            host_id TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE conversations (
            server TEXT NOT NULL REFERENCES servers(endpoint) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            native_id TEXT NOT NULL,
            descriptor BLOB NOT NULL,
            ordinal INTEGER NOT NULL,
            PRIMARY KEY (server, session_id)
        )
        """,
        """
        CREATE TABLE records (
            hash TEXT PRIMARY KEY,
            body BLOB NOT NULL,
            native_id TEXT,
            parent_id TEXT,
            kind TEXT
        )
        """,
        """
        CREATE TABLE history_entries (
            server TEXT NOT NULL,
            session_id TEXT NOT NULL,
            position INTEGER NOT NULL CHECK (position >= 0),
            record_hash TEXT NOT NULL REFERENCES records(hash),
            chain_root TEXT NOT NULL,
            PRIMARY KEY (server, session_id, position),
            FOREIGN KEY (server, session_id) REFERENCES conversations(server, session_id) ON DELETE CASCADE
        )
        """,
        "CREATE INDEX history_record_hash ON history_entries(record_hash)",
        """
        CREATE TABLE history_state (
            server TEXT NOT NULL,
            session_id TEXT NOT NULL,
            record_count INTEGER NOT NULL CHECK (record_count >= 0),
            root TEXT NOT NULL,
            start INTEGER NOT NULL CHECK (start >= 0 AND start <= record_count),
            prefix_root TEXT NOT NULL,
            verified_owner TEXT NOT NULL,
            PRIMARY KEY (server, session_id),
            FOREIGN KEY (server, session_id) REFERENCES conversations(server, session_id) ON DELETE CASCADE
        )
        """
    ]
}
