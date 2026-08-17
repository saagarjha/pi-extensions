import SwiftUI
#if os(macOS)
import AppKit
import UniformTypeIdentifiers
#endif

struct LsToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    private var details: LsDetails? { result?.details?.lsValue }

    private var arguments: LsArguments? { call.arguments?.lsValue }

    private typealias Entry = FileToolEntry

    private var path: String {
        nonempty(details?.path)
            ?? nonempty(arguments?.path)
            ?? ""
    }

    private var target: String? {
        nonempty(details?.target)
            ?? nonempty(arguments?.target)
    }

    private var entries: [Entry]? {
        // Only structured entries describe a listing. Legacy text is never split into names.
        return details?.entries
    }

    private var truncated: Bool { details?.truncated == true }

    private func nonempty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    private var originalText: String {
        guard let result else { return "" }
        var text = result.content?.presentationText ?? ""
        if let error = nonempty(result.errorMessage), error != text {
            text += (text.isEmpty ? "" : "\n\n") + error
        }
        if text.isEmpty {
            return result.omitted.map { "[Result omitted: \($0.reason)]" }
                ?? "[Listing unavailable]"
        }
        return text
    }

    private var directoryIcon: some View {
        #if os(macOS)
        Image(nsImage: NSWorkspace.shared.icon(for: .folder))
            .resizable().scaledToFit().frame(width: 16, height: 16)
        #else
        Image(systemName: "folder")
        #endif
    }

    @ViewBuilder
    private func entryIcon(_ entry: Entry) -> some View {
        #if os(macOS)
        if entry.kind == "file" {
            // Type-based lookup only; never inspect the entry's filesystem path.
            let type = UTType(filenameExtension: (entry.name as NSString).pathExtension) ?? .data
            Image(nsImage: NSWorkspace.shared.icon(for: type))
                .resizable().scaledToFit().frame(width: 16, height: 16)
        } else if entry.kind == "directory" {
            directoryIcon
        } else {
            Image(systemName: entry.symbol)
        }
        #else
        Image(systemName: entry.symbol)
        #endif
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PathView(path: path, target: target, isDirectory: true)
            .textSelection(.enabled)

            if result == nil {
                EmptyView()
            } else if result?.isError == true || result?.errorMessage?.isEmpty == false {
                Text("Listing failed").foregroundStyle(.secondary)
                if result?.content?.hasRichBlocks == true {
                    ToolResultContentView(content: result?.content, error: result?.errorMessage)
                } else {
                    Text(originalText).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                }
            } else if let entries {
                if entries.isEmpty {
                    Text(truncated ? "No entries returned" : "Empty directory")
                        .foregroundStyle(.secondary)
                } else {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(entries.indices, id: \.self) { index in
                            HStack {
                                entryIcon(entries[index])
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
                                      emptyLabel: "No listing output returned")
            } else {
                Text(originalText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
            }
            if entries != nil, result?.content?.hasRichBlocks == true {
                ToolResultContentView(content: result?.content, error: result?.errorMessage)
            }

            if truncated {
                Text("Listing truncated").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}



#Preview("ls") {
    ToolStreamingPreview("ls") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
