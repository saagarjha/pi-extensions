import SwiftUI

/// One presentation owner for arguments and native observations, including
/// missing/extended metadata. No successful result is rendered as whole-message JSON.
struct MessageSubagentToolView: View {
    let call: ToolCall
    let result: NativeMessage?
    let execution: LinkToolExecution?
    @Environment(\.subagentDisplayNames) private var names

    @ViewBuilder private func block(_ block: NativeContent, index: Int, data: MessageSubagentToolData) -> some View {
        switch block {
        case .text(let value):
            Text(verbatim: data.outputText(value.text, index: index))
                .foregroundStyle(data.isError ? Color.red : Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
        case .image(let image):
            MessageImageView(base64: image.data, mimeType: image.mimeType)
        case .thinking(let value):
            Text(verbatim: value.presentationText).italic()
        case .toolCall(let value):
            Text(verbatim: MessageSubagentToolData.json(value)).font(.system(.body, design: .monospaced))
        case .unsupported(let value):
            Text(verbatim: MessageSubagentToolData.json(value.payload)).font(.system(.body, design: .monospaced))
        }
    }

    var body: some View {
        let data = MessageSubagentToolData(call: call, result: result, execution: execution)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(verbatim: data.name ?? data.target.flatMap { names[$0] } ?? data.target ?? "Subagent")
                    .font(.headline)
                if let delivery = data.delivery { Text(verbatim: delivery).font(.caption).foregroundStyle(.secondary) }
            }
            if let input = data.input {
                if !input.isEmpty { Text(verbatim: input) }
            } else if result != nil || execution?.end != nil {
                Text("Message unavailable").foregroundStyle(.secondary)
                if result != nil || execution?.end != nil, let payload = data.unavailablePayload {
                    DisclosureGroup("Unrecognized message input") {
                        Text(verbatim: MessageSubagentToolData.json(payload))
                            .font(.system(.caption, design: .monospaced))
                    }
                }
            }
            switch data.content {
            case .text(let text):
                if data.hasEmptyContent, data.errorMessage?.isEmpty != false {
                    if !data.pendingStatus.isEmpty {
                        Text(verbatim: data.pendingStatus).font(.caption).foregroundStyle(data.isError ? Color.red : Color.secondary)
                    }
                } else {
                    Text(verbatim: data.outputText(text, index: 0))
                        .foregroundStyle(data.isError ? Color.red : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            case .blocks(let blocks):
                if data.hasEmptyContent, data.errorMessage?.isEmpty != false, !data.pendingStatus.isEmpty {
                    Text(verbatim: data.pendingStatus).font(.caption).foregroundStyle(data.isError ? Color.red : Color.secondary)
                }
                ForEach(blocks.indices, id: \.self) { index in block(blocks[index], index: index, data: data) }
            case nil:
                if data.errorMessage?.isEmpty != false, !data.pendingStatus.isEmpty { Text(verbatim: data.pendingStatus).font(.caption).foregroundStyle(data.isError ? Color.red : Color.secondary) }
            }
            if let error = data.supplementalError { Text(verbatim: error).foregroundStyle(.red) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}

/// Echo projection is independent of delivery/status/metadata schema. IDs pair
/// the native observation to the call, not a query name to its resolved agent ID.
nonisolated struct MessageSubagentToolData {
    let arguments: LinkJSON?
    let details: LinkJSON?
    let content: NativeMessageContent?
    let isError: Bool
    let errorMessage: String?
    let paired: Bool
    let pendingStatus: String
    let input: String?
    let echoIndex: Int?

    init(call: ToolCall, result: NativeMessage?, execution: LinkToolExecution?) {
        arguments = Self.value(call.arguments)
        if let result {
            paired = result.toolCallId == call.id && (result.toolName == call.name || result.toolName == nil)
            details = Self.value(result.details); content = result.content
            isError = result.isError == true || result.errorMessage?.isEmpty == false
            errorMessage = result.errorMessage
            pendingStatus = isError ? "Tool failed" : "Tool result contains no content"
        } else if let execution {
            paired = execution.isConsistent && execution.start.toolCallId == call.id && execution.start.toolName == call.name
            details = execution.output?.details; content = execution.output?.content
            isError = execution.end?.isError == true; errorMessage = nil
            pendingStatus = execution.end == nil ? "" : isError ? "Tool failed" : "Tool result contains no content"
        } else {
            paired = false; details = nil; content = nil; isError = false; errorMessage = nil
            pendingStatus = ""
        }
        input = Self.string(arguments, "message") ?? (paired ? Self.string(details, "message") : nil)
        switch content {
        case .text: echoIndex = 0
        case .blocks(let blocks): echoIndex = blocks.indices.last { if case .text = blocks[$0] { return true }; return false }
        case nil: echoIndex = nil
        }
    }

    var target: String? { Self.string(arguments, "id") ?? (paired ? Self.string(details, "id") : nil) }
    var name: String? { paired ? Self.string(details, "name") : nil }
    var delivery: String? { (paired ? Self.string(details, "delivery") : nil) ?? Self.string(arguments, "delivery") }
    var hasEmptyContent: Bool {
        switch content {
        case .text(let text): return text.isEmpty
        case .blocks(let blocks): return blocks.allSatisfy { if case .text(let value) = $0 { return value.text.isEmpty }; return false }
        case nil: return true
        }
    }
    var supplementalError: String? {
        guard let errorMessage, !errorMessage.isEmpty else { return nil }
        switch content {
        case .text(let text): if text.utf8.elementsEqual(errorMessage.utf8) { return nil }
        case .blocks(let blocks):
            if blocks.contains(where: { if case .text(let value) = $0 { return value.text.utf8.elementsEqual(errorMessage.utf8) }; return false }) { return nil }
        case nil: break
        }
        return errorMessage
    }
    var unavailablePayload: LinkJSON? {
        guard input == nil else { return nil }
        for payload in [arguments, hasEmptyContent ? details : nil] {
            switch payload {
            case nil, .null: continue
            case .object(let fields) where fields.isEmpty: continue
            case .array(let values) where values.isEmpty: continue
            case .string(let text) where text.isEmpty: continue
            default: return payload
            }
        }
        return nil
    }

    func outputText(_ text: String, index: Int) -> String {
        guard paired, !isError, index == echoIndex, let input else { return text }
        // These are the tool's two authored final echo delimiters, not a search
        // for message text elsewhere in output. All preceding output is retained.
        for delimiter in ["\n\nMessage:\n", "\n\nMessage: "] {
            let suffix = delimiter + input
            if text.utf8.suffix(suffix.utf8.count).elementsEqual(suffix.utf8) {
                return String(text.dropLast(suffix.count))
            }
        }
        return text
    }

    private static func string(_ value: LinkJSON?, _ key: String) -> String? {
        guard case .object(let fields) = value, case .string(let text) = fields[key] else { return nil }
        return text
    }
    private static func value<T: Encodable>(_ value: T?) -> LinkJSON? {
        guard let value else { return nil }
        let encoder = JSONEncoder(); encoder.userInfo[.toolPresentation] = true
        guard let data = try? encoder.encode(value) else { return nil }
        return try? JSONDecoder().decode(LinkJSON.self, from: data)
    }
    static func json<T: Encodable>(_ value: T) -> String {
        let encoder = JSONEncoder(); encoder.userInfo[.toolPresentation] = true
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let raw = Self.value(value), let data = try? encoder.encode(raw.presentationRedacted) else { return "[JSON unavailable]" }
        return String(decoding: data, as: UTF8.self)
    }
}



#Preview("message_subagent") {
    ToolStreamingPreview("message_subagent") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
