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

    private var network: String {
        switch parameters?.network {
        case true: "Enabled"
        case false: "Disabled"
        default: "Default"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: name)
            VStack(alignment: .leading, spacing: 6) {
                LabeledContent("Operating system", value: parameters?.os ?? "Default")
                if let name = parameters?.name {
                    LabeledContent("Name", value: name)
                }
                LabeledContent("Base", value: parameters?.base ?? "Default")
                LabeledContent("Network", value: network)
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
