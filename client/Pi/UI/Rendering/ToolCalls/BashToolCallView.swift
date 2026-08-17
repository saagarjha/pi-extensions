import SwiftUI

struct BashToolCallView: View {
    let arguments: BashArguments?
    let result: NativeMessage?
    var execution: LinkToolExecution? = nil

    private var output: String? {
        guard let result else { return execution?.output?.text }
        var text = result.content?.presentationText
            ?? result.omitted.map { "[Result omitted: \($0.reason)]" } ?? ""
        if let error = result.errorMessage, !error.isEmpty, !text.contains(error) {
            text += (text.isEmpty ? "" : "\n\n") + error
        }
        return text
    }

    var body: some View {
        ScrollView(.horizontal) {
            CommandOutputView(target: arguments?.target, command: arguments?.command ?? "",
                              timeoutMs: arguments?.timeoutMs, output: output)
                .fixedSize(horizontal: true, vertical: false)
        }
        // Parent controls can supply animations; keep streaming text from shifting
        // while the scroll view measures a new output height.
        .transaction { $0.animation = nil }
    }
}

#Preview("bash") {
    ToolStreamingPreview("bash") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}

#Preview("bg_start") {
    ToolStreamingPreview("bg_start") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}

