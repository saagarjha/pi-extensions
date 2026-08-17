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
            ?? ""
    }

    private var target: String? {
        nonempty(details?.target)
            ?? nonempty(arguments?.target)
    }

    private var pattern: String {
        arguments?.pattern
            ?? details?.pattern
            ?? ""
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
        guard let result else { return "" }
        var text = result.content?.presentationText ?? ""
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
            ViewThatFits(in: .horizontal) {
                HStack {
                    Text(verbatim: "/\(pattern)/")
                    Text("in").foregroundStyle(.secondary)
                    PathView(path: path, target: target, isDirectory: isDirectory)
                }
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(verbatim: "/\(pattern)/")
                        Text("in").foregroundStyle(.secondary)
                    }
                    PathView(path: path, target: target, isDirectory: isDirectory)
                }
            }
            .textSelection(.enabled)

            if result == nil {
                EmptyView()
            } else if result?.isError == true || result?.errorMessage?.isEmpty == false {
                Text("Search failed").foregroundStyle(.secondary)
                if result?.content?.hasRichBlocks == true {
                    ToolResultContentView(content: result?.content, error: result?.errorMessage)
                } else {
                    Text(originalText).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                }
            } else if let groups {
                if groups.isEmpty {
                    Text(truncated ? "No matches returned" : "No matches")
                        .foregroundStyle(.secondary)
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(groups.indices, id: \.self) { index in
                            VStack(alignment: .leading, spacing: 6) {
								HStack {
									
									PathView(path: groups[index].path, target: target, isDirectory: false)
								}
                                CodeView(lines: groups[index].entries.map {
                                    .init(number: String($0.line), text: $0.text, change: .context)
                                })
								if index != groups.indices.last {
									Spacer()
									Divider()
									Spacer()
								}
                            }
                        }
                    }
                }
            } else if result?.content?.hasRichBlocks == true {
                ToolResultContentView(content: result?.content, error: result?.errorMessage,
                                      emptyLabel: "No search output returned")
            } else {
                Text(originalText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
            }
            if groups != nil, result?.content?.hasRichBlocks == true {
                ToolResultContentView(content: result?.content, error: result?.errorMessage)
            }

            if truncated {
                Text("Search results truncated").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}



#Preview("grep") {
    ToolStreamingPreview("grep") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
