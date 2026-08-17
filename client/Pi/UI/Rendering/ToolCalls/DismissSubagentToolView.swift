import SwiftUI

struct DismissSubagentToolView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?
    let name: String

    var body: some View {
        let action = result == nil ? "Dismissing" : errorText == nil ? "Dismissed" : "Could not dismiss"
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: "\(action) \(name)")
            if result?.content?.hasRichBlocks == true {
                ToolResultContentView(content: result?.content, error: result?.errorMessage)
            } else if let errorText { Text(verbatim: errorText).foregroundStyle(.red) }
        }
        .textSelection(.enabled)
    }
}



#Preview("dismiss_subagent") {
    ToolStreamingPreview("dismiss_subagent") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
