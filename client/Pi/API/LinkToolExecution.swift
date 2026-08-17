import Foundation

/// Native owner observations, not transcript entries or invented tool results.
/// The SDK/TUI contract replaces partialResult; Bash supplies a cumulative,
/// possibly truncated OutputAccumulator snapshot rather than an append chunk.
nonisolated struct LinkToolExecution: Decodable, Equatable, Sendable {
    struct Start: Decodable, Equatable, Sendable {
        let toolCallId: String
        let toolName: String
        let args: LinkJSON?
    }
    struct Result: Decodable, Equatable, Sendable {
        let content: NativeMessageContent?
        let details: LinkJSON?
        var detailsText: String? {
            guard let details else { return nil }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            return (try? encoder.encode(details.presentationRedacted)).flatMap { String(data: $0, encoding: .utf8) }
        }
        var text: String {
            content?.presentationText ?? ""
        }
    }
    struct Update: Decodable, Equatable, Sendable {
        let toolCallId: String
        let toolName: String
        let args: LinkJSON?
        let partialResult: Result
    }
    struct End: Decodable, Equatable, Sendable {
        let toolCallId: String
        let toolName: String
        let result: Result
        let isError: Bool
    }
    let start: Start
    let update: Update?
    let end: End?
    var output: Result? { end?.result ?? update?.partialResult }
    var isConsistent: Bool {
        (update == nil || (update?.toolCallId == start.toolCallId && update?.toolName == start.toolName)) &&
        (end == nil || (end?.toolCallId == start.toolCallId && end?.toolName == start.toolName))
    }

    /// A render-only copy, not a message inserted into the conversation.
    /// Renderers receive the same typed result before and after recording.
    func completedResult(for call: ToolCall) -> NativeMessage? {
        guard isConsistent, start.toolCallId == call.id, start.toolName == call.name,
              let end else { return nil }
        var fields: [String: LinkJSON] = [
            "role": .string("toolResult"), "toolCallId": .string(call.id),
            "toolName": .string(call.name), "isError": .bool(end.isError)
        ]
        if let content = end.result.content {
            guard let data = try? JSONEncoder().encode(content),
                  let raw = try? JSONDecoder().decode(LinkJSON.self, from: data) else { return nil }
            fields["content"] = raw
        }
        fields["details"] = end.result.details
        guard let data = try? JSONEncoder().encode(LinkJSON.object(fields)) else { return nil }
        return try? JSONDecoder().decode(NativeMessage.self, from: data)
    }
}
