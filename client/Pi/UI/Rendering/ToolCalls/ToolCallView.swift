import SwiftUI

struct ToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    var execution: LinkToolExecution? = nil
    @Environment(\.subagentDisplayNames) private var subagentDisplayNames
    private var isInProgress: Bool {
        guard result == nil else { return false }
        guard let execution, execution.isConsistent,
              execution.start.toolCallId == call.id, execution.start.toolName == call.name else { return true }
        return execution.end == nil
    }
    private var shownCall: ToolCall { call }
    private var presentationResult: NativeMessage? {
        result ?? execution?.completedResult(for: call)
    }
    private var shownResult: NativeMessage? { presentationResult }

    private func displaySubagent(_ idOrName: String?, resultName: String?) -> String {
        if let resultName, !resultName.isEmpty { return resultName }
        guard let idOrName, !idOrName.isEmpty else { return "Subagent" }
        return subagentDisplayNames[idOrName] ?? idOrName
    }

    var body: some View {
        GroupBox {
            if call.name == "message_subagent" {
                MessageSubagentToolView(call: call, result: presentationResult, execution: execution)
                    .padding(8)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    // Known renderers own their complete presentation, including
                    // live output. Generic output belongs only to fallbackContent.
                    renderedContent
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
            }
        } label: {
            HStack(spacing: 6) {
                Text(call.name)
                if isInProgress {
                    ProgressView()
                        .controlSize(.mini)
                        .frame(width: 12, height: 12)
                        .accessibilityLabel(execution == nil ? "Preparing tool call" : "Running tool call")
                }
            }
        }
    }

    private var renderedContent: some View {
            Group {
                if shownCall.arguments?.isFallback == true || shownResult?.details?.isFallback == true {
                    fallbackContent
                } else if call.name == "read" {
                    ReadToolCallView(call: shownCall, result: shownResult)
                } else if call.name == "write" {
                    WriteToolCallView(call: shownCall, result: shownResult)
                } else if call.name == "edit" {
                    EditToolCallView(call: shownCall, result: shownResult)
                } else if call.name == "copy" {
                    VStack(alignment: .leading, spacing: 8) {
                        CopyToolCallView(call: shownCall, result: shownResult)
                        if shownResult?.content?.hasRichBlocks == true {
                            ToolResultContentView(content: shownResult?.content, error: shownResult?.errorMessage)
                        } else if let errorText {
                            Text(verbatim: errorText).foregroundStyle(.red).textSelection(.enabled)
                        } else if shownResult == nil, let content = execution?.update?.partialResult.content {
                            ToolResultContentView(content: content, emptyLabel: "")
                        }
                    }
                } else if call.name == "grep" {
                    GrepToolCallView(call: shownCall, result: shownResult)
                } else if call.name == "find" {
                    FindToolCallView(call: shownCall, result: shownResult)
                } else if call.name == "ls" {
                    LsToolCallView(call: shownCall, result: shownResult)
                } else if call.name == "list_subagents" {
                    ListSubagentsToolView(call: shownCall, result: shownResult)
                } else if call.name == "capabilities" {
                    CapabilitiesToolCallView(result: shownResult)
                } else if call.name == "bash" || call.name == "bg_start" {
                    let arguments = shownCall.arguments?.bashValue ?? shownCall.arguments?.bgStartValue
                    VStack(alignment: .leading, spacing: 8) {
                        BashToolCallView(arguments: arguments,
                                         result: call.name == "bg_start" || shownResult?.content?.hasRichBlocks == true ? nil : shownResult,
                                         execution: call.name == "bash" ? execution : nil)
                        if call.name == "bash", shownResult?.content?.hasRichBlocks == true {
                            ToolResultContentView(content: shownResult?.content, error: errorText,
                                                  emptyLabel: "No command output returned")
                        }
                        if call.name == "bg_start", let shownResult {
                            // Tool completion launches the job; it does not mean the job finished.
                            ToolResultContentView(content: shownResult.content, error: errorText,
                                                  emptyLabel: "No background job status returned")
                        }
                    }
                } else if call.name == "bg_list" {
                    BackgroundListToolView(call: shownCall, result: shownResult)
                } else if call.name == "vm_create" {
                    VStack(alignment: .leading, spacing: 8) {
                        VmCreateToolCallView(call: shownCall, result: shownResult)
                        if let shownResult {
                            ToolResultContentView(content: shownResult.content, error: errorText,
                                                  emptyLabel: "No VM result content")
                        } else if let content = execution?.update?.partialResult.content {
                            ToolResultContentView(content: content, emptyLabel: "")
                        }
                    }
                } else if call.name == "vm_start" {
                    VmStartToolCallView(call: shownCall, result: shownResult, errorText: errorText, execution: execution)
                } else if call.name == "vm_stop" {
                    VmStopToolCallView(call: shownCall, result: shownResult, errorText: errorText, execution: execution)
                } else if call.name == "vm_publish" {
                    VmPublishToolCallView(call: shownCall, result: shownResult, errorText: errorText, execution: execution)
                } else if call.name == "vm_destroy" {
                    VmDestroyToolCallView(call: shownCall, result: shownResult, errorText: errorText, execution: execution)
                } else if call.name == "dismiss_subagent" {
                    DismissSubagentToolView(call: shownCall, result: shownResult, errorText: errorText,
                        name: displaySubagent(shownCall.arguments?.dismissSubagentValue?.id,
                            resultName: shownResult?.details?.dismissSubagentValue?.name))
                } else if call.name == "inspect_subagent" {
                    InspectSubagentToolView(call: shownCall, result: shownResult, errorText: errorText,
                        name: displaySubagent(shownCall.arguments?.inspectSubagentValue?.id,
                            resultName: shownResult?.details?.inspectSubagentValue?.name))
                } else if call.name == "goal_report" {
                    GoalReportToolView(call: shownCall, result: shownResult, errorText: errorText)
                } else if call.name == "notify_parent" {
                    NotifyParentToolView(call: shownCall, result: shownResult, errorText: errorText)
                } else if call.name == "spawn_subagent" {
                    SpawnSubagentToolView(call: shownCall, result: shownResult, errorText: errorText)
                } else if call.name == "bg_status" {
                    BackgroundStatusToolView(call: shownCall, result: shownResult, errorText: errorText)
                } else if call.name == "bg_stop" {
                    BackgroundStopToolView(call: shownCall, result: shownResult, errorText: errorText)
                } else if call.name == "vm_list" {
                    VmListToolCallView(call: shownCall, result: shownResult, errorText: errorText)
                } else {
                    fallbackContent
                }
            }
    }

    private var fallbackContent: some View {
        let result = presentationResult
        let tool = NativeToolPresentation(call: call, result: result)
        return VStack(alignment: .leading, spacing: 8) {
            if case .fallback(_, let diagnostic) = call.arguments, let diagnostic {
                Text(verbatim: diagnostic).foregroundStyle(.secondary)
            }
            if case .fallback(_, let diagnostic) = result?.details, let diagnostic {
                Text(verbatim: diagnostic).foregroundStyle(.secondary)
            }
            if call.arguments?.isFallback == true || result == nil {
                Text(verbatim: tool.input)
            }
            if let output = tool.output { Text(verbatim: output) }
            else if let content = execution?.update?.partialResult.content {
                ToolResultContentView(content: content, emptyLabel: "")
            }
        }
        .font(.system(.body, design: .monospaced))
        .textSelection(.enabled)
    }
    private var errorText: String? {
        guard let result = presentationResult, result.isError == true || result.errorMessage?.isEmpty == false else { return nil }
        if let error = result.errorMessage, !error.isEmpty { return error }
        switch result.content {
        case .text(let text): return text
        case .blocks(let blocks):
            return blocks.compactMap { block in
                if case .text(let value) = block { return value.text }
                return nil
            }.joined(separator: "\n\n")
        case nil: return "Tool failed"
        }
    }
}

/// One rich native-result owner for the tools whose producer returns readable
/// prose/logs, and for live cumulative execution observations. JSON authored as
/// file/code/log output stays literal; only unknown native blocks disclose raw data.
struct ToolResultContentView: View {
    let content: NativeMessageContent?
    var error: String? = nil
    var emptyLabel = "No output returned"

    @ViewBuilder private func part(_ block: NativeContent) -> some View {
        switch block {
        case .text: Text(verbatim: block.presentationText).fixedSize(horizontal: false, vertical: true)
        case .image(let value): MessageImageView(base64: value.data, mimeType: value.mimeType)
        case .thinking: Text(verbatim: block.presentationText).italic()
        case .toolCall(let value):
            Text(verbatim: NativeToolPresentation.json(value))
                .font(.system(.caption, design: .monospaced))
        case .unsupported(let value):
            Text(verbatim: NativeToolPresentation.json(value.payload.presentationRedacted))
                .font(.system(.caption, design: .monospaced))
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch content {
            case .text(let text) where !text.isEmpty:
                Text(verbatim: text).fixedSize(horizontal: false, vertical: true)
            case .blocks(let blocks) where !blocks.isEmpty:
                ForEach(blocks.indices, id: \.self) { index in part(blocks[index]) }
            default:
                if error == nil, !emptyLabel.isEmpty { Text(verbatim: emptyLabel).foregroundStyle(.secondary) }
            }
            if let error, !error.isEmpty, content?.presentationText != error {
                Text(verbatim: error).foregroundStyle(.red)
            } else if error != nil, content?.presentationText == error {
                // The native error body is authoritative; do not repeat it.
                EmptyView()
            }
        }
        .textSelection(.enabled)
    }
}

nonisolated extension NativeMessageContent {
    var hasRichBlocks: Bool {
        guard case .blocks(let blocks) = self else { return false }
        return blocks.contains { block in
            if case .text = block { return false }
            return true
        }
    }
}

/// Raw native result fallback for tools without a custom renderer.
nonisolated struct NativeToolPresentation: Identifiable {
    let call: ToolCall
    let result: NativeMessage?
    var id: String { call.id }
    var name: String { call.name }
    var input: String { Self.json(call.arguments) }
    var output: String? { result.map(Self.json) }

    static func json<T: Encodable>(_ value: T) -> String {
        let encoder = JSONEncoder()
        encoder.userInfo[.toolPresentation] = true
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return "[JSON unavailable]" }
        return String(decoding: data, as: UTF8.self)
    }

}




#Preview("custom_unknown") {
    ToolStreamingPreview("custom_unknown") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
