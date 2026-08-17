import Foundation

/// Wire bodies are ordinary JSON strings, decoded only by Foundation. Callers
/// retain their original UTF-8 until durable commit; display values are never re-encoded.
nonisolated enum LinkWireRecords {
    static func decode(_ records: [String]) throws -> [NativeRecord] {
        let decoder = JSONDecoder()
        return try records.map { try decoder.decode(NativeRecord.self, from: Data($0.utf8)) }
    }
}
