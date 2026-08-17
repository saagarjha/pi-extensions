import Foundation

/// Error admission and payload decoding share the original Foundation decoder.
nonisolated struct LinkHTTPValue<Value: Decodable & Sendable>: Decodable, Sendable {
    let value: Value
    private enum Keys: String, CodingKey { case error, code }
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if let error = try c.decodeIfPresent(String.self, forKey: .error) {
            throw LinkFailure(error, code: try c.decodeIfPresent(String.self, forKey: .code))
        }
        value = try Value(from: decoder)
    }
}
nonisolated struct LinkRPCReply<Result: Decodable & Sendable>: Decodable, Sendable {
    let replyTo: Int?
    let result: Result
}
nonisolated struct LinkHello: Decodable, Sendable {
    struct Capabilities: Decodable, Sendable {
        let conditionalAttach: Bool?
        let sessionActivity: Bool?
    }
    let `protocol`: Int
    let clientId: String
    let instanceId: String
    let capabilities: Capabilities?
}
nonisolated struct LinkProfileRegistration: Decodable, Sendable { let profileId: String }
nonisolated struct LinkAttachmentAck: Decodable, Sendable { let sessionId: String; let seq: Int }
nonisolated struct LinkOperationAcceptance: Decodable, Sendable { let operationId: String }
/// Commands whose result is deliberately not consumed still avoid a JSON tree.
nonisolated struct LinkAcknowledgment: Decodable, Sendable {}
nonisolated struct LinkCreatedSession: Decodable, Sendable {
    let sessionId: String?
    let id: String?
}
nonisolated struct LinkChildInspection: Decodable, Sendable {
    let leafId: String?
    let child: ChildSummary
    let sourceFile: String?
    let available: Bool
    let error: String?
    let header: NativeRecord?
    let entryCount: Int
    let entries: [NativeRecord]
}
nonisolated enum LinkServiceValue: Sendable {
    case backgroundTask(LinkBackgroundTaskDetail)
    case childView(LinkChildView)
    case childInspection(LinkChildInspection)
    case permissions(PermissionState)
    case children([ChildSummary])
    case backgroundTasks([LinkBackgroundTask])
    case fallback(LinkJSON)
}
