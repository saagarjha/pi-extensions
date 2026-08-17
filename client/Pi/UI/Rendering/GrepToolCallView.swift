import SwiftUI

struct GrepToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    private var details: GrepDetails? { result?.details?.grepValue }

    private var arguments: GrepArguments? { call.arguments?.grepValue }

    private typealias Entry = GrepToolEntry

    private struct FileGroup {
        let name: String
        let path: String
        var entries: [Entry]
    }

    private func nonempty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    private var path: String {
        nonempty(details?.path)
            ?? nonempty(arguments?.path)
            ?? "Current directory"
    }

    private var target: String? {
        nonempty(details?.target)
            ?? nonempty(arguments?.target)
    }

    private var pattern: String {
        arguments?.pattern
            ?? details?.pattern
            ?? "[Pattern unavailable]"
    }

    private var groups: [FileGroup]? {
        // Only native records supply filenames and line numbers; never parse formatted output.
        guard let entries = details?.entries,
              entries.allSatisfy({ $0.line > 0 }) else { return nil }
        var groups: [FileGroup] = []
        for entry in entries {
            if groups.last?.path == entry.path {
                groups[groups.count - 1].entries.append(entry)
            } else {
                groups.append(FileGroup(name: entry.name, path: entry.path, entries: [entry]))
            }
        }
        return groups
    }

    private var truncated: Bool { details?.truncated == true }

    private var originalText: String {
        guard let result else { return "Pending…" }
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
        case nil: text = ""
        }
        if let error = nonempty(result.errorMessage), error != text {
            text += (text.isEmpty ? "" : "\n\n") + error
        }
        if text.isEmpty {
            return result.omitted.map { "[Result omitted: \($0.reason)]" }
                ?? "[Search results unavailable]"
        }
        return text
    }

    private var isDirectory: Bool? {
        details?.isDirectory
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(verbatim: "/\(pattern)/")
                Text("in").foregroundStyle(.secondary)
                PathView(path: path, target: target, isDirectory: isDirectory)
            }
            .textSelection(.enabled)

            if result == nil {
                Text("Pending…").foregroundStyle(.secondary)
            } else if result?.isError == true {
                Text("Search failed").foregroundStyle(.secondary)
                Text(originalText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
            } else if let groups {
                if groups.isEmpty {
                    Text(truncated ? "No matches returned" : "No matches")
                        .foregroundStyle(.secondary)
                } else {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(groups.indices, id: \.self) { index in
                            VStack(alignment: .leading, spacing: 6) {
                                PathView(path: groups[index].path, target: target, isDirectory: false)
                                CodeView(lines: groups[index].entries.map {
                                    .init(number: String($0.line), text: $0.text, change: .context)
                                })
                            }
                        }
                    }
                }
            } else {
                Text(originalText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
            }

            if truncated {
                Text("Search results truncated").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
