import SwiftUI

struct BackgroundStatusToolView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let id = call.arguments?.bgStatusValue?.id {
                Text(verbatim: id).font(.headline)
            }
            if let tail = call.arguments?.bgStatusValue?.tailChars {
                LabeledContent("Output limit", value: "\(tail.formatted()) characters")
            }
            if let result {
                ToolResultContentView(content: result.content, error: errorText,
                                      emptyLabel: "No result content")
            }
        }
    }
}



#Preview("bg_status") {
    ToolStreamingPreview("bg_status") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
