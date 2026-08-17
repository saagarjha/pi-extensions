import SwiftUI

/// Small native renderer for the common message blocks in our preview fixtures.
struct MarkdownMessageView: View {
    let source: String
    @Environment(\.transcriptFindScope) private var findScope

    private typealias Block = MarkdownDocument.Block
    private var blocks: [Block] { MarkdownDocument(source).blocks }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                let range = matchRange(at: index)
                BlockView(block: block, findRange: range).equatable()
                    #if os(macOS)
                    .background {
                        if let range, let findScope {
                            TranscriptFindReveal(scope: .init(row: findScope.row, part: findScope.part, range: range, navigation: findScope.navigation))
                        }
                    }
                    #endif
            }
        }
        .lineSpacing(4)
        .textSelection(.enabled)
    }

    private func matchRange(at index: Int) -> NSRange? {
        guard let findScope, let text = TranscriptFindText.block(blocks[index]) else { return nil }
        let offset = blocks.prefix(index).compactMap(TranscriptFindText.block).reduce(0) { $0 + ($1 as NSString).length + 2 }
        return TranscriptFindText.local(findScope.range, offset: offset, length: (text as NSString).length)
    }

    private struct BlockView: View, Equatable {
        let block: Block
        let findRange: NSRange?

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
            case .image(let image):
                MessageImageView(destination: image.destination, alt: image.alt, isComplete: image.isComplete)
                    .help(image.title ?? image.alt)
            case .table(let table):
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 8) {
                        ForEach(Array(table.allRows.enumerated()), id: \.offset) { rowIndex, row in
                            GridRow {
                                ForEach(0..<table.columnCount, id: \.self) { column in
                                    inline(column < row.count ? row[column] : "", range: cellRange(table, row: rowIndex, column: column))
                                        .fontWeight(rowIndex == 0 ? .semibold : .regular)
                                        .fixedSize(horizontal: true, vertical: false)
                                        .gridColumnAlignment(table.alignment(at: column) == .right ? .trailing
                                            : table.alignment(at: column) == .center ? .center : .leading)
                                }
                            }
                            if rowIndex == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
                        }
                    }
                    .padding(12)
                }
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
            case .code(let text, let language):
                VStack(alignment: .leading, spacing: 8) {
                    if !language.isEmpty {
                        Text(language).font(.caption).foregroundStyle(.secondary)
                    }
                    ScrollView(.horizontal) {
                        Text(TranscriptFindText.highlight(AttributedString(text), range: findRange))
                            .font(.system(.body, design: .monospaced))
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
        }

        private func cellRange(_ table: MarkdownDocument.Table, row: Int, column: Int) -> NSRange? {
            guard findRange != nil, column < table.allRows[row].count else { return nil }
            let rows = table.allRows
            let precedingRows = rows.prefix(row).reduce(0) { total, cells in
                total + (0..<table.columnCount).map { TranscriptFindText.plain($0 < cells.count ? cells[$0] : "") }.joined(separator: "\t").utf16.count + 1
            }
            let precedingCells = rows[row].prefix(column).reduce(0) { $0 + TranscriptFindText.plain($1).utf16.count + 1 }
            return TranscriptFindText.local(findRange, offset: precedingRows + precedingCells,
                                            length: TranscriptFindText.plain(rows[row][column]).utf16.count)
        }
        private func inline(_ text: String) -> Text { inline(text, range: findRange) }
        private func inline(_ text: String, range: NSRange?) -> Text {
            Text(TranscriptFindText.highlight(TranscriptFindText.inline(text), range: range))
        }
    }
}

#Preview("Markdown") {
    ScrollView {
        MarkdownMessageView(source: PreviewFixtures.markdown)
            .padding(24)
    }
}
