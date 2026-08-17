import SwiftUI

struct BackgroundStopToolView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let id = call.arguments?.bgStopValue?.id {
                Text(verbatim: id).font(.headline)
            }
            if let result {
                ToolResultContentView(content: result.content, error: errorText,
                                      emptyLabel: "No result content")
            }
        }
    }
}



#Preview("bg_stop") {
    ToolStreamingPreview("bg_stop") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
