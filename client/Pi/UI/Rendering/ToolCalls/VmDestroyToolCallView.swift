import SwiftUI

struct VmDestroyToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?
    var execution: LinkToolExecution? = nil

    var body: some View {
        let vmID = call.arguments?.vmDestroyValue?.vmId
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(verbatim: vmID ?? "VM")
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



#Preview("vm_destroy") {
    ToolStreamingPreview("vm_destroy") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
