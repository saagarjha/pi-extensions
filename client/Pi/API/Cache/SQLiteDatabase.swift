import Foundation
import SQLite3

nonisolated enum SQLiteValue: Sendable, Equatable {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)

    var string: String? {
        guard case .text(let value) = self else { return nil }
        return value
    }

    var int64: Int64? {
        guard case .integer(let value) = self else { return nil }
        return value
    }

    var data: Data? {
        guard case .blob(let value) = self else { return nil }
        return value
    }
}

nonisolated enum SQLiteError: Error, LocalizedError, Sendable {
    case failure(code: Int32, message: String)

    var errorDescription: String? {
        switch self {
        case .failure(let code, let message):
            return "SQLite error \(code): \(message)"
        }
    }
}

/// A synchronous connection owned exclusively by the cache actor. Not Sendable.
nonisolated final class SQLiteDatabase {
    private var handle: OpaquePointer?

    init(url: URL) throws {
        guard url.isFileURL, !url.path.utf8.contains(0) else {
            throw SQLiteError.failure(code: SQLITE_CANTOPEN, message: "Expected a valid file URL")
        }
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        var connection: OpaquePointer?
        let result = sqlite3_open_v2(
            url.path,
            &connection,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
            nil
        )
        guard result == SQLITE_OK, let connection else {
            let message = connection.map { String(cString: sqlite3_errmsg($0)) }
                ?? "Could not open database"
            if let connection { sqlite3_close_v2(connection) }
            throw SQLiteError.failure(code: result, message: message)
        }
        handle = connection
        do {
            try check(sqlite3_busy_timeout(connection, 3_000))
            try execute("PRAGMA foreign_keys = ON")
        } catch {
            sqlite3_close_v2(connection)
            handle = nil
            throw error
        }
    }

    deinit {
        if let handle { sqlite3_close_v2(handle) }
    }

    /// Call only after confirming this file belongs to the cache.
    func configureCacheJournaling() throws {
        try execute("PRAGMA journal_mode = WAL")
        try execute("PRAGMA synchronous = NORMAL")
    }

    /// Executes one SQL statement, consuming any rows it returns.
    func execute(_ sql: String, _ bindings: [SQLiteValue] = []) throws {
        try withStatement(sql, bindings) { statement in
            while true {
                let result = sqlite3_step(statement)
                if result == SQLITE_DONE { return }
                if result != SQLITE_ROW { throw databaseError(result) }
            }
        }
    }

    func query(_ sql: String, _ bindings: [SQLiteValue] = []) throws -> [[String: SQLiteValue]] {
        try withStatement(sql, bindings) { statement in
            var rows: [[String: SQLiteValue]] = []
            while true {
                let result = sqlite3_step(statement)
                if result == SQLITE_DONE { return rows }
                guard result == SQLITE_ROW else { throw databaseError(result) }
                var row: [String: SQLiteValue] = [:]
                for index in 0..<sqlite3_column_count(statement) {
                    guard let name = sqlite3_column_name(statement, index) else {
                        throw databaseError(SQLITE_NOMEM)
                    }
                    row[String(cString: name)] = try value(statement, index)
                }
                rows.append(row)
            }
        }
    }

    /// Transactions cannot be nested. A failed commit also rolls back.
    func transaction<T>(_ operation: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try operation()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    private func withStatement<T>(
        _ sql: String,
        _ bindings: [SQLiteValue],
        _ operation: (OpaquePointer) throws -> T
    ) throws -> T {
        guard let handle, !sql.utf8.contains(0) else {
            throw SQLiteError.failure(code: SQLITE_MISUSE, message: "Invalid connection or SQL text")
        }
        var prepared: OpaquePointer?
        let result = sqlite3_prepare_v2(handle, sql, -1, &prepared, nil)
        guard result == SQLITE_OK else {
            if let prepared { sqlite3_finalize(prepared) }
            throw databaseError(result)
        }
        guard let statement = prepared else {
            throw SQLiteError.failure(code: SQLITE_MISUSE, message: "Expected a SQL statement")
        }
        defer { sqlite3_finalize(statement) }
        guard Int(sqlite3_bind_parameter_count(statement)) == bindings.count else {
            throw SQLiteError.failure(code: SQLITE_RANGE, message: "SQL binding count does not match")
        }
        for (offset, binding) in bindings.enumerated() {
            try bind(binding, to: statement, at: Int32(offset + 1))
        }
        return try operation(statement)
    }

    private func bind(_ value: SQLiteValue, to statement: OpaquePointer, at index: Int32) throws {
        // SQLITE_TRANSIENT makes SQLite copy the bytes before the Swift buffer expires.
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        let result: Int32
        switch value {
        case .null:
            result = sqlite3_bind_null(statement, index)
        case .integer(let value):
            result = sqlite3_bind_int64(statement, index, value)
        case .real(let value):
            result = sqlite3_bind_double(statement, index, value)
        case .text(let value):
            guard let count = Int32(exactly: value.utf8.count) else {
                throw SQLiteError.failure(code: SQLITE_TOOBIG, message: "Text binding is too large")
            }
            result = value.withCString { bytes in
                sqlite3_bind_text(statement, index, bytes, count, transient)
            }
        case .blob(let value):
            guard let count = Int32(exactly: value.count) else {
                throw SQLiteError.failure(code: SQLITE_TOOBIG, message: "Blob binding is too large")
            }
            if value.isEmpty {
                result = sqlite3_bind_zeroblob(statement, index, 0)
            } else {
                result = value.withUnsafeBytes { bytes in
                    sqlite3_bind_blob(statement, index, bytes.baseAddress, count, transient)
                }
            }
        }
        try check(result)
    }

    private func value(_ statement: OpaquePointer, _ index: Int32) throws -> SQLiteValue {
        switch sqlite3_column_type(statement, index) {
        case SQLITE_NULL:
            return .null
        case SQLITE_INTEGER:
            return .integer(sqlite3_column_int64(statement, index))
        case SQLITE_FLOAT:
            return .real(sqlite3_column_double(statement, index))
        case SQLITE_TEXT:
            guard let bytes = sqlite3_column_text(statement, index) else {
                throw databaseError(SQLITE_NOMEM)
            }
            let count = Int(sqlite3_column_bytes(statement, index))
            return .text(String(decoding: UnsafeBufferPointer(start: bytes, count: count), as: UTF8.self))
        case SQLITE_BLOB:
            let bytes = sqlite3_column_blob(statement, index)
            let count = Int(sqlite3_column_bytes(statement, index))
            if count == 0 {
                if sqlite3_errcode(handle) == SQLITE_NOMEM { throw databaseError(SQLITE_NOMEM) }
                return .blob(Data())
            }
            guard let bytes else { throw databaseError(SQLITE_NOMEM) }
            return .blob(Data(bytes: bytes, count: count))
        default:
            throw SQLiteError.failure(code: SQLITE_MISMATCH, message: "Unsupported SQLite column type")
        }
    }

    private func check(_ result: Int32) throws {
        guard result == SQLITE_OK else { throw databaseError(result) }
    }

    private func databaseError(_ code: Int32) -> SQLiteError {
        let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "Database is closed"
        return .failure(code: code, message: message)
    }
}
