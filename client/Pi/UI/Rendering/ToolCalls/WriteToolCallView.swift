import SwiftUI

struct WriteToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?

    private var arguments: WriteArguments? { call.arguments?.writeValue }

    private var path: String { arguments?.path ?? "" }
    private var target: String? { arguments?.target }
    private var content: String { arguments?.content ?? arguments?.contents ?? "" }

    private var errorText: String? {
        guard let result else { return nil }
        let error = result.errorMessage ?? ""
        guard result.isError == true || !error.isEmpty else { return nil }
        var text = ""
        if result.isError == true {
            switch result.content {
            case .text(let value): text = value
            case .blocks(let blocks):
                text = blocks.compactMap { block in
                    if case .text(let value) = block { return value.text }
                    return nil
                }.joined(separator: "\n\n")
            case nil: break
            }
        }
        if !error.isEmpty, error != text {
            text += (text.isEmpty ? "" : "\n\n") + error
        }
        return text.isEmpty ? "Write failed" : text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PathView(path: path, target: target, isDirectory: false)
            CodeView(text: content, change: .added)
            if let errorText {
                if result?.content?.hasRichBlocks == true {
                    ToolResultContentView(content: result?.content, error: result?.errorMessage)
                        .foregroundStyle(.red)
                } else {
                    Text(errorText)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }
        }
    }

}




#Preview("write") {
    ToolStreamingPreview("write") { frame in
        // The shared header owns progress; only write errors add result content.
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
