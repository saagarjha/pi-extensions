import SwiftUI

struct BashToolCallView: View {
    let arguments: BashArguments?
    let result: NativeMessage?

    private var output: String? {
        guard let result else { return nil }
        var text: String
        switch result.content {
        case .text(let value): text = value
        case .blocks(let blocks):
            text = blocks.map { block in
                switch block {
                case .text(let value): return value.text
                case .thinking(let value): return value.redacted == true ? "[Redacted thinking]" : value.thinking
                case .image(let value): return "[Image: \(value.mimeType)]"
                case .toolCall(let value): return "[Tool call: \(value.name)]"
                case .unsupported(let type): return "[Unsupported content: \(type)]"
                }
            }.joined(separator: "\n\n")
        case nil: text = result.omitted.map { "[Result omitted: \($0.reason)]" } ?? ""
        }
        if let error = result.errorMessage, !error.isEmpty, !text.contains(error) {
            text += (text.isEmpty ? "" : "\n\n") + error
        }
        return text
    }

    var body: some View {
        CommandOutputView(target: arguments?.target, command: arguments?.command ?? "",
                          timeoutMs: arguments?.timeoutMs, output: output)
    }
}

#Preview("Bash") {
    ToolCallView(call: PreviewFixtures.nativeToolCalls[1], result: PreviewFixtures.nativeToolResults[1])
}
