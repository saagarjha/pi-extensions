import SwiftUI

struct InspectSubagentToolView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?
    let name: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: "\(result == nil ? "Inspecting" : errorText == nil ? "Inspected" : "Could not inspect") \(name)")
            if let result {
                ToolResultContentView(content: result.content, error: errorText,
                                      emptyLabel: "No transcript returned")
            }
        }
        .textSelection(.enabled)
    }
}



#Preview("inspect_subagent") {
    ToolStreamingPreview("inspect_subagent") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
