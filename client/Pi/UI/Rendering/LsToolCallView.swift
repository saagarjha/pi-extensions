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
            ?? "Current directory"
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
                Text("Pending…").foregroundStyle(.secondary)
            } else if result?.isError == true {
                Text("Listing failed").foregroundStyle(.secondary)
                Text(originalText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
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
            } else {
                Text(originalText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
            }

            if truncated {
                Text("Listing truncated").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
