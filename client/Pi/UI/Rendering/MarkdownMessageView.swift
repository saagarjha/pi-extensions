import SwiftUI

/// Small native renderer for the common message blocks in our preview fixtures.
struct MarkdownMessageView: View {
    let source: String

    private enum Block: Equatable {
        case paragraph(String)
        case heading(String, Int)
        case bullet(String)
        case quote(String)
        case code(String, String)
    }

    private var blocks: [Block] {
        var result: [Block] = []
        var paragraph: [String] = []
        var code: [String] = []
        var language: String?

        func flushParagraph() {
            if !paragraph.isEmpty {
                result.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph.removeAll()
            }
        }

        for line in source.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                flushParagraph()
                if let currentLanguage = language {
                    result.append(.code(code.joined(separator: "\n"), currentLanguage))
                    code.removeAll()
                    language = nil
                } else {
                    language = String(line.dropFirst(3))
                }
            } else if language != nil {
                code.append(line)
            } else if line.isEmpty {
                flushParagraph()
            } else if line.hasPrefix("#") {
                let level = line.prefix(while: { $0 == "#" }).count
                if level <= 6, line.dropFirst(level).hasPrefix(" ") {
                    flushParagraph()
                    result.append(.heading(String(line.dropFirst(level + 1)), level))
                } else {
                    paragraph.append(line)
                }
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                flushParagraph()
                result.append(.bullet(String(line.dropFirst(2))))
            } else if line.hasPrefix("> ") {
                flushParagraph()
                result.append(.quote(String(line.dropFirst(2))))
            } else {
                paragraph.append(line)
            }
        }
        flushParagraph()
        if let language { result.append(.code(code.joined(separator: "\n"), language)) }
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block).equatable()
            }
        }
        .lineSpacing(4)
        .textSelection(.enabled)
    }

    private struct BlockView: View, Equatable {
        let block: Block

        var body: some View {
            switch block {
            case .paragraph(let text):
                inline(text)
            case .heading(let text, let level):
                inline(text)
                    .font(level == 1 ? .title2 : level == 2 ? .title3 : .headline)
                    .fontWeight(.semibold)
            case .bullet(let text):
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("•").foregroundStyle(.secondary)
                    inline(text)
                }
            case .quote(let text):
                HStack(spacing: 12) {
                    Rectangle().fill(.quaternary).frame(width: 3)
                    inline(text).foregroundStyle(.secondary)
                }
                .fixedSize(horizontal: false, vertical: true)
            case .code(let text, let language):
                VStack(alignment: .leading, spacing: 8) {
                    if !language.isEmpty {
                        Text(language).font(.caption).foregroundStyle(.secondary)
                    }
                    ScrollView(.horizontal) {
                        Text(text)
                            .font(.system(.body, design: .monospaced))
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
        }

        private func inline(_ text: String) -> Text {
            Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
        }
    }
}

#Preview("Markdown") {
    ScrollView {
        MarkdownMessageView(source: PreviewFixtures.markdown)
            .padding(24)
    }
}
