import SwiftUI

struct VmPublishToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?
    var execution: LinkToolExecution? = nil

    var body: some View {
        let vmID = call.arguments?.vmPublishValue?.target
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(verbatim: vmID ?? "VM")
                if let name = call.arguments?.vmPublishValue?.name {
                    Text("→").foregroundStyle(.secondary)
                    Text(verbatim: name)
                }
            }
            if let result {
                ToolResultContentView(content: result.content, error: errorText,
                                      emptyLabel: "No VM result content")
            } else if let content = execution?.update?.partialResult.content {
                ToolResultContentView(content: content, emptyLabel: "")
            }
        }
        .textSelection(.enabled)
    }
}



#Preview("vm_publish") {
    ToolStreamingPreview("vm_publish") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
