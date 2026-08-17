import SwiftUI

struct NotifyParentToolView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?

    var body: some View {
        let message = call.arguments?.notifyParentValue?.message ?? result?.details?.notifyParentValue?.message
        VStack(alignment: .leading, spacing: 8) {
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



#Preview("notify_parent") {
    ToolStreamingPreview("notify_parent") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
