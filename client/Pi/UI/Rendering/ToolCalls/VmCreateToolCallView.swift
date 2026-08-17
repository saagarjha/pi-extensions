import SwiftUI

struct VmCreateToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    private var details: VMCreateDetails? { result?.details?.vmCreateValue }

    private var arguments: VMCreateArguments? { call.arguments?.vmCreateValue }

    private var parameters: VMCreateArguments? {
        details?.parameters ?? arguments
    }

    private var name: String {
        details?.vm?.id
            ?? arguments?.name
            ?? "VM"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: name)
            VStack(alignment: .leading, spacing: 6) {
                if let os = parameters?.os {
                    LabeledContent("Operating system", value: os)
                }
                if let name = parameters?.name {
                    LabeledContent("Name", value: name)
                }
                if let base = parameters?.base {
                    LabeledContent("Base", value: base)
                }
                if let network = parameters?.network {
                    LabeledContent("Network", value: network ? "Enabled" : "Disabled")
                }
                if let count = parameters?.options?.cpuCount {
                    LabeledContent("Requested CPUs", value: String(count))
                }
                if let ram = parameters?.options?.ramMiB {
                    LabeledContent("Requested RAM", value: "\(ram) MiB")
                }
            }
        }
        .textSelection(.enabled)
    }
}



#Preview("vm_create") {
    ToolStreamingPreview("vm_create") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
