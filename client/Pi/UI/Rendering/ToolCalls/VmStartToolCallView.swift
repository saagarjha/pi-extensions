import SwiftUI

struct VmStartToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    let errorText: String?
    var execution: LinkToolExecution? = nil

    var body: some View {
        let vmID = call.arguments?.vmStartValue?.vmId
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(verbatim: vmID ?? "VM")
            }
            if let start = call.arguments?.vmStartValue {
                if let network = start.network { LabeledContent("Network", value: network ? "Requested" : "Off") }
                if let sip = start.sip { LabeledContent("SIP", value: sip) }
                if let cpus = start.options?.cpuCount { LabeledContent("Requested CPUs", value: String(cpus)) }
                if let ram = start.options?.ramMiB { LabeledContent("Requested RAM", value: "\(ram) MiB") }
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



#Preview("vm_start") {
    ToolStreamingPreview("vm_start") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
