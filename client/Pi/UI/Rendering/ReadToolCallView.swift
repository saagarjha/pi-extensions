import SwiftUI

struct ReadToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    private var details: ReadDetails? { result?.details?.readValue }

    private var arguments: ReadArguments? {
        if case .read(let value) = call.arguments { value } else { nil }
    }
    var path: String { arguments?.path ?? "" }
    var target: String? { arguments?.target }

    var returnedText: String {
        guard let result else { return "" }
        var text: String
        switch result.content {
        case .text(let value): text = value
        case .blocks(let blocks):
            text = blocks.map { block in
                switch block {
                case .text(let value): value.text
                case .image(let value): "[Image: \(value.mimeType)]"
                case .unsupported(let type): "[Unsupported content: \(type)]"
                case .thinking(let value): value.redacted == true ? "[Redacted thinking]" : value.thinking
                case .toolCall(let value): "[Tool call: \(value.name)]"
                }
            }.joined(separator: "\n\n")
        case nil:
            text = result.omitted.map { "[Result omitted: \($0.reason)]" }
                ?? (result.errorMessage?.isEmpty == false ? "" : "[Result content unavailable]")
        }
        if let error = result.errorMessage, !error.isEmpty, error != text {
            text += (text.isEmpty ? "" : "\n\n") + error
        }
        return text
    }

    var startingLine: Int {
        let offset = arguments?.offset ?? 1
        return offset > 0 ? offset : 1
    }

    /// Only a successful, exclusively textual SDK result can contain file lines.
    /// SDK metadata and requested bounds separate continuation notices, never their wording.
    var displayedContent: (code: String?, notice: String) {
        guard let result, result.isError != true, result.omitted == nil,
              result.errorMessage?.isEmpty != false else { return (nil, returnedText) }
        let text: String
        switch result.content {
        case .text(let value): text = value
        case .blocks(let blocks):
            guard blocks.count == 1, case .text(let value) = blocks[0] else {
                return (nil, returnedText)
            }
            text = value.text
        case nil: return (nil, returnedText)
        }
        if let truncation = details?.truncation {
            if truncation.firstLineExceedsLimit == true { return (nil, text) }
            if truncation.truncated == true {
                guard let code = truncation.content else { return (nil, text) }
                let prefix = code + "\n\n"
                guard text.hasPrefix(prefix) else { return (nil, text) }
                return (code, String(text.dropFirst(prefix.count)))
            }
        }
        if let limit = arguments?.limit, limit > 0 {
            // The SDK splits on LF, retaining empty lines and CR in CRLF input.
            let lines = text.components(separatedBy: "\n")
            if lines.count > limit {
                return (lines.prefix(limit).joined(separator: "\n"),
                        lines.dropFirst(limit + 1).joined(separator: "\n"))
            }
        }
        return (text, "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PathView(path: path, target: target, isDirectory: false)
            let content = displayedContent
            if let code = content.code {
                CodeView(text: code, startingLine: startingLine)
            }
            if content.code == nil, !content.notice.isEmpty {
                Text(content.notice)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

}

#Preview("Read") {
    ToolCallView(call: PreviewFixtures.remoteReadCall, result: PreviewFixtures.remoteReadResult)
}
