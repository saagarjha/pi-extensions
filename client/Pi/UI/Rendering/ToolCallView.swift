import SwiftUI

struct ToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?

    var body: some View {
        GroupBox {
            renderedContent
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
        } label: {
            Text(call.name)
        }
    }

    private var renderedContent: some View {
            Group {
                if call.arguments?.isFallback == true || result?.details?.isFallback == true || hasUnsupportedContent {
                    fallbackContent
                } else if call.name == "read" {
                    ReadToolCallView(call: call, result: result)
                } else if call.name == "write" {
                    WriteToolCallView(call: call, result: result)
                } else if call.name == "edit" {
                    EditToolCallView(call: call, result: result)
                } else if call.name == "copy" {
                    VStack(alignment: .leading, spacing: 8) {
                        CopyToolCallView(call: call, result: result)
                        if let errorText { Text(verbatim: errorText).foregroundStyle(.red).textSelection(.enabled) }
                    }
                } else if call.name == "grep" {
                    GrepToolCallView(call: call, result: result)
                } else if call.name == "find" {
                    FindToolCallView(call: call, result: result)
                } else if call.name == "ls" {
                    LsToolCallView(call: call, result: result)
                } else if call.name == "capabilities" {
                    CapabilitiesToolCallView(result: result)
                } else if call.name == "bash" || call.name == "bg_start" {
                    let arguments = call.arguments?.bashValue ?? call.arguments?.bgStartValue
                    VStack(alignment: .leading, spacing: 8) {
                        BashToolCallView(arguments: arguments, result: call.name == "bg_start" ? nil : result)
                        if call.name == "bg_start", let errorText {
                            Text(verbatim: errorText).foregroundStyle(.red).textSelection(.enabled)
                        }
                    }
                } else if call.name == "vm_create" {
                    VStack(alignment: .leading, spacing: 8) {
                        VmCreateToolCallView(call: call, result: result)
                        if let errorText { Text(verbatim: errorText).foregroundStyle(.red) }
                    }
                } else if ["vm_start", "vm_stop", "vm_publish", "vm_destroy"].contains(call.name) {
                    let vmID = call.arguments?.vmStartValue?.vmId ?? call.arguments?.vmDestroyValue?.vmId ?? call.arguments?.vmStopValue?.target ?? call.arguments?.vmPublishValue?.target
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(verbatim: vmID ?? "VM")
                            if call.name == "vm_publish", let name = call.arguments?.vmPublishValue?.name {
                                Text("→").foregroundStyle(.secondary)
                                Text(verbatim: name)
                            }
                        }
                        if let errorText { Text(verbatim: errorText).foregroundStyle(.red) }
                    }
                    .textSelection(.enabled)
                } else if call.name == "dismiss_subagent" {
                    let name = result?.details?.dismissSubagentValue?.name ?? call.arguments?.dismissSubagentValue?.id ?? "Subagent"
                    let action = result == nil ? "Dismissing" : errorText == nil ? "Dismissed" : "Could not dismiss"
                    VStack(alignment: .leading, spacing: 8) {
                        Text(verbatim: "\(action) \(name)")
                        if let errorText { Text(verbatim: errorText).foregroundStyle(.red) }
                    }
                    .textSelection(.enabled)
                } else if ["goal_report", "notify_parent", "message_subagent", "spawn_subagent"].contains(call.name) {
                    let message = call.arguments?.goalReportValue?.report ?? call.arguments?.spawnSubagentValue?.instructions ?? call.arguments?.messageSubagentValue?.message ?? call.arguments?.notifyParentValue?.message ?? result?.details?.goalReportValue?.report ?? result?.details?.messageSubagentValue?.message ?? result?.details?.notifyParentValue?.message
                    VStack(alignment: .leading, spacing: 8) {
                        if call.name == "spawn_subagent" {
                            Text(verbatim: result?.details?.spawnSubagentValue?.name ?? call.arguments?.spawnSubagentValue?.name ?? "Subagent")
                        }
                        if call.name == "message_subagent" {
                            HStack {
                                Text(verbatim: call.arguments?.messageSubagentValue?.id ?? result?.details?.messageSubagentValue?.id ?? "")
                                Text(verbatim: result?.details?.messageSubagentValue?.delivery ?? call.arguments?.messageSubagentValue?.delivery ?? "auto")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Text(verbatim: message ?? "")
                        if let errorText { Text(verbatim: errorText).foregroundStyle(.red) }
                    }
                    .textSelection(.enabled)
                } else {
                    fallbackContent
                }
            }
    }
    private var hasUnsupportedContent: Bool {
        guard case .blocks(let blocks) = result?.content else { return false }
        return blocks.contains { if case .unsupported = $0 { true } else { false } }
    }

    private var fallbackContent: some View {
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
            Text(verbatim: tool.output ?? "Pending…")
        }
        .font(.system(.body, design: .monospaced))
        .textSelection(.enabled)
    }
    private var errorText: String? {
        guard let result, result.isError == true || result.errorMessage?.isEmpty == false else { return nil }
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

/// Raw native result fallback for tools without a custom renderer.
nonisolated struct NativeToolPresentation: Identifiable {
    let call: ToolCall
    let result: NativeMessage?
    var id: String { call.id }
    var name: String { call.name }
    var input: String { Self.json(call.arguments) }
    var output: String? { result.map(Self.json) }

    private static func json<T: Encodable>(_ value: T) -> String {
        let encoder = JSONEncoder()
        encoder.userInfo[.toolPresentation] = true
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return "[JSON unavailable]" }
        return String(decoding: data, as: UTF8.self)
    }

}

#Preview("read") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "read" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("write") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "write" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("edit") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "edit" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("ls") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "ls" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("find") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "find" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("grep") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "grep" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("copy") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "copy" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("bash") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "bash" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("bg_start") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "bg_start" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("bg_list") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "bg_list" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("bg_status") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "bg_status" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("bg_stop") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "bg_stop" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("vm_create") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "vm_create" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("vm_start") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "vm_start" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("vm_list") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "vm_list" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("vm_stop") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "vm_stop" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("vm_publish") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "vm_publish" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("vm_destroy") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "vm_destroy" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("spawn_subagent") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "spawn_subagent" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("list_subagents") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "list_subagents" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("inspect_subagent") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "inspect_subagent" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("message_subagent") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "message_subagent" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("dismiss_subagent") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "dismiss_subagent" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("notify_parent") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "notify_parent" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("capabilities") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "capabilities" }!
    ToolCallView(call: tool.call, result: tool.result)
}

#Preview("goal_report") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "goal_report" }!
    ToolCallView(call: tool.call, result: tool.result)
}

