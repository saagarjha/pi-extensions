import SwiftUI

struct FindToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    private var details: FindDetails? { result?.details?.findValue }

    private var arguments: FindArguments? { call.arguments?.findValue }

    private typealias Entry = FileToolEntry

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

    private var entries: [Entry]? {
        // Native records only: formatted output cannot safely delimit filenames.
        return details?.entries
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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(pattern)
                Text("in").foregroundStyle(.secondary)
                PathView(path: path, target: target, isDirectory: true)
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
            } else if let entries {
                if entries.isEmpty {
                    Text(truncated ? "No matches returned" : "No matches")
                        .foregroundStyle(.secondary)
                } else {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(entries.indices, id: \.self) { index in
                            HStack {
                                // The find producer reports unknown kind; an extension is not proof of a file.
                                Image(systemName: "questionmark.square")
                                    .frame(width: 18)
                                    .foregroundStyle(.secondary)
                                Text(entries[index].name)
                                    .textSelection(.enabled)
                            }
                            .help(entries[index].path)
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
            if entries != nil, result?.content?.hasRichBlocks == true {
                ToolResultContentView(content: result?.content, error: result?.errorMessage)
            }

            if truncated {
                Text("Search results truncated").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}



#Preview("find") {
    ToolStreamingPreview("find") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
