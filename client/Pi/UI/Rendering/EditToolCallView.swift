import SwiftUI

struct EditToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    private var details: EditDetails? { result?.details?.editValue }

    private var arguments: EditArguments? { call.arguments?.editValue }

    enum Change: Equatable { case context, removed, added }
    struct Line: Equatable {
        let text: String
        let change: Change
    }

    var path: String { arguments?.path ?? arguments?.file_path ?? "" }
    var target: String? { arguments?.target }
    var returnedDiff: String? { details?.diff }

    var lines: [Line] {
        if let returnedDiff {
            return Self.splitLines(returnedDiff).map { text in
                let change: Change
                if text.hasPrefix("--- ") || text.hasPrefix("+++ ") || text.hasPrefix("@@") { change = .context }
                else if text.hasPrefix("-") { change = .removed }
                else if text.hasPrefix("+") { change = .added }
                else { change = .context }
                // Keep the SDK's signed, padded line numbers/context exactly as returned.
                return Line(text: text, change: change)
            }
        }
        let edits: [EditReplacement]
        if let batch = arguments?.edits { edits = batch }
        else if let args = arguments, args.oldText != nil || args.newText != nil {
            edits = [EditReplacement(oldText: args.oldText, newText: args.newText)]
        } else { edits = [] }
        guard !edits.isEmpty else { return [Line(text: "[Requested edit unavailable]", change: .context)] }
        var lines: [Line] = []
        for (index, edit) in edits.enumerated() {
            if edits.count > 1 { lines.append(Line(text: "Change \(index + 1)", change: .context)) }
            guard let old = edit.oldText, let new = edit.newText else {
                lines.append(Line(text: "[Requested edit unavailable]", change: .context))
                continue
            }
            // Requested snippets only: no filesystem read, fabricated context, or file line numbers.
            lines += Self.requestedLines(old: old, new: new)
        }
        return lines
    }

    /// Only native details.diff uses the SDK's signed, padded number format.
    /// Requested snippets have unknown file positions and keep their signs in text.
    static func codeLine(_ line: Line, returned: Bool) -> CodeView.Line {
        let change: CodeView.Change
        switch line.change {
        case .context: change = .context
        case .removed: change = .removed
        case .added: change = .added
        }
        guard returned,
              let match = numberedDiffLine.firstMatch(in: line.text, range: NSRange(line.text.startIndex..., in: line.text)),
              let signRange = Range(match.range(at: 1), in: line.text),
              let numberRange = Range(match.range(at: 2), in: line.text),
              let textRange = Range(match.range(at: 3), in: line.text) else {
            return CodeView.Line(number: nil, text: line.text, change: change)
        }
        let sign = String(line.text[signRange])
        return CodeView.Line(number: (sign == " " ? "" : sign) + line.text[numberRange],
                             text: String(line.text[textRange]), change: change)
    }

    // Consume exactly one separator space after the number, preserving code indentation.
    // Headers, ellipses and all other formats remain untouched.
    private static let numberedDiffLine = try! NSRegularExpression(pattern: #"^([ +\-]) *([0-9]+) (.*)$"#)

    var resultText: String {
        guard let result else { return "" }
        var text: String
        switch result.content {
        case .text(let value): text = value
        case .blocks(let blocks):
            text = blocks.map { block in
                switch block {
                case .text(let value): value.text
                case .thinking(let value): value.redacted == true ? "[Redacted thinking]" : value.thinking
                case .image(let value): "[Image: \(value.mimeType)]"
                case .toolCall(let value): "[Tool call: \(value.name)]"
                case .unsupported(let type): "[Unsupported content: \(type)]"
                }
            }.joined(separator: "\n\n")
        case nil: text = result.omitted.map { "[Result omitted: \($0.reason)]" }
            ?? (result.errorMessage?.isEmpty == false ? "" : "[Result content unavailable]")
        }
        if let error = result.errorMessage, !error.isEmpty, error != text {
            text += (text.isEmpty ? "" : "\n\n") + error
        }
        return text
    }

    /// Only align small requested snippets. Large replacements remain a valid remove/add
    /// diff, without quadratic work or invented file positions/context.
    static func requestedLines(old: String, new: String) -> [Line] {
        let before = splitLines(old), after = splitLines(new)
        guard before.count <= 500, after.count <= 500 else {
            return before.map { Line(text: "-" + $0, change: .removed) }
                + after.map { Line(text: "+" + $0, change: .added) }
        }
        let width = after.count + 1
        var lengths = [Int](repeating: 0, count: (before.count + 1) * width)
        for i in before.indices.reversed() {
            for j in after.indices.reversed() {
                lengths[i * width + j] = before[i] == after[j]
                    ? 1 + lengths[(i + 1) * width + j + 1]
                    : max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
            }
        }
        var lines: [Line] = []
        var i = 0, j = 0
        while i < before.count || j < after.count {
            if i < before.count, j < after.count, before[i] == after[j] {
                lines.append(Line(text: " " + before[i], change: .context))
                i += 1; j += 1
            } else if i < before.count,
                      j == after.count || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1] {
                lines.append(Line(text: "-" + before[i], change: .removed))
                i += 1
            } else {
                lines.append(Line(text: "+" + after[j], change: .added))
                j += 1
            }
        }
        // Snippets may differ only in their terminating newline; don't silently
        // present such a request as identical. This is not a file EOF assertion.
        if old.hasSuffix("\n") != new.hasSuffix("\n") {
            lines.append(Line(text: "[Requested snippet trailing newline changed]", change: .context))
        }
        return lines
    }

    private static func splitLines(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        return lines
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PathView(path: path, target: target, isDirectory: false)
            if (result?.isError == true || result?.errorMessage?.isEmpty == false), !resultText.isEmpty {
                Text(verbatim: resultText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
            }
            if result?.isError == true {
                Text("Edit failed").foregroundStyle(.red)
            }
            if returnedDiff == nil {
                Text("Requested changes (no returned diff)")
                    .font(.caption).foregroundStyle(.secondary)
            } else if returnedDiff?.isEmpty == true {
                Text("No changes in returned diff")
                    .font(.caption).foregroundStyle(.secondary)
            }
            CodeView(lines: lines.map { Self.codeLine($0, returned: returnedDiff != nil) })
        }
    }

}

#Preview("Edit: multiple changes") {
    ToolCallView(call: PreviewFixtures.editMultipleCall, result: PreviewFixtures.editMultipleResult)
}
