import SwiftUI

struct GoalReportToolView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?

    var body: some View {
        let message = call.arguments?.goalReportValue?.report ?? result?.details?.goalReportValue?.report
        VStack(alignment: .leading, spacing: 8) {
            if result != nil, errorText == nil {
                Text("Submitted for evaluation")
                    .font(.caption).foregroundStyle(.secondary)
            }
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



#Preview("goal_report") {
    ToolStreamingPreview("goal_report") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
