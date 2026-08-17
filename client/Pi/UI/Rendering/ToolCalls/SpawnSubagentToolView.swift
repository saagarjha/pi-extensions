import SwiftUI

struct SpawnSubagentToolView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?

    var body: some View {
        let message = call.arguments?.spawnSubagentValue?.instructions
        VStack(alignment: .leading, spacing: 8) {
            let agent = result?.details?.spawnSubagentValue
            Text(verbatim: agent?.name ?? call.arguments?.spawnSubagentValue?.name ?? "Subagent")
            if let id = agent?.id { Text(verbatim: id).font(.caption).foregroundStyle(.secondary) }
            if let model = agent?.model ?? call.arguments?.spawnSubagentValue?.model {
                LabeledContent("Model", value: model)
            }
            if let status = agent?.status { Text(verbatim: status.capitalized).foregroundStyle(.secondary) }
            if let message {
                if !message.isEmpty { Text(verbatim: message) }
            } else if result != nil { Text("Message unavailable").foregroundStyle(.secondary) }
            if result?.content?.hasRichBlocks == true {
                ToolResultContentView(content: result?.content, error: result?.errorMessage)
            } else if let errorText { Text(verbatim: errorText).foregroundStyle(.red) }
        }
        .textSelection(.enabled)
    }
}



#Preview("spawn_subagent") {
    ToolStreamingPreview("spawn_subagent") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
