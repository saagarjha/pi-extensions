import SwiftUI

struct VmListToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Managed VMs").font(.headline)
            if let result {
                ToolResultContentView(content: result.content, error: errorText,
                                      emptyLabel: "No result content")
            }
        }
    }
}



#Preview("vm_list") {
    ToolStreamingPreview("vm_list") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
