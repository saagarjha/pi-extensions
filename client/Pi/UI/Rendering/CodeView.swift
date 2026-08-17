import SwiftUI

/// A selectable code block with a fixed line-number gutter and horizontal scrolling.
struct CodeView: View {
    enum Change: Equatable { case context, removed, added }

    struct Line: Equatable {
        let number: String?
        let text: String
        var change: Change = .context
    }

    let lines: [Line]

    init(lines: [Line]) {
        self.lines = lines
    }

    init(text: String, startingLine: Int = 1, change: Change = .context) {
        lines = text.replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n").enumerated().map { index, text in
                let (number, overflow) = startingLine.addingReportingOverflow(index)
                return Line(number: overflow ? nil : String(number), text: text, change: change)
            }
    }

    private var code: AttributedString {
        var result = AttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 { result.append(AttributedString("\n")) }
            var text = AttributedString(line.text)
            switch line.change {
            case .context: break
            case .removed: text.foregroundColor = .red
            case .added: text.foregroundColor = .green
            }
            result.append(text)
        }
        return result
    }

    var body: some View {
        if !lines.isEmpty {
            HStack(alignment: .top, spacing: 0) {
                Text(verbatim: lines.map { $0.number ?? " " }.joined(separator: "\n"))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(.horizontal, 8)
                    .textSelection(.disabled)
                Divider()
                ScrollView(.horizontal) {
                    #if os(macOS)
                    NativeCodeLeaf(lines: lines)
                        .fixedSize(horizontal: true, vertical: true)
                        .padding(.horizontal, 8)
                    #else
                    Text(code).fixedSize(horizontal: true, vertical: true).textSelection(.enabled).padding(.horizontal, 8)
                    #endif
                }
            }
            .font(.system(.body, design: .monospaced))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

#Preview("Code") {
    CodeView(text: "import SwiftUI\n\nlet message = \"A long line stays on one line and scrolls horizontally instead of wrapping to the width of the window.\"\n", startingLine: 20)
}

#if os(macOS)
import AppKit
import CoreText

/// Experimental read-only code leaf. The existing SwiftUI gutter and horizontal scroll remain outside.
private struct NativeCodeLeaf: NSViewRepresentable {
    let lines: [CodeView.Line]
    func makeNSView(context: Context) -> NativeCodeTextView { NativeCodeTextView() }
    func updateNSView(_ view: NativeCodeTextView, context: Context) {
        let resolved = (context.environment.font ?? .body).resolve(in: context.environment.fontResolutionContext)
        let font = unsafeBitCast(resolved.ctFont, to: NSFont.self) // CTFont/NSFont are toll-free bridged.
        view.update(lines, font: font, spacing: context.environment.lineSpacing)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeCodeTextView, context: Context) -> CGSize? {
        nsView.measuredSize
    }
}

private final class NativeCodeTextView: NSTextView {
    private var previous: [CodeView.Line] = []
    private var previousFont: NSFont?
    private var previousSpacing: CGFloat?
    private(set) var measuredSize = CGSize(width: 1, height: 1)

    init() {
        let storage = NSTextStorage()
        let manager = NSLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(manager); manager.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        isEditable = false; isSelectable = true; isRichText = true
        drawsBackground = false; textContainerInset = .zero
        isHorizontallyResizable = true; isVerticallyResizable = false
        container.widthTracksTextView = false; container.heightTracksTextView = false; container.lineFragmentPadding = 0
        isContinuousSpellCheckingEnabled = false; isAutomaticLinkDetectionEnabled = false
        allowsUndo = false
        setAccessibilityLabel("Code")
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ lines: [CodeView.Line], font: NSFont, spacing: CGFloat) {
        guard let storage = textStorage, let manager = layoutManager, let container = textContainer else { return }
        let styleChanged = previousFont != font || previousSpacing != spacing
        var prefix = 0
        if !styleChanged {
            while prefix < min(previous.count, lines.count),
                  previous[prefix].text == lines[prefix].text,
                  previous[prefix].change == lines[prefix].change { prefix += 1 }
        }
        if prefix == previous.count, prefix == lines.count, !styleChanged { return }
        var offset = previous.prefix(prefix).reduce(0) { $0 + $1.text.utf16.count } + max(0, prefix - 1)
        let edge = prefix > 0 && (prefix == previous.count || prefix == lines.count)
        if prefix > 0 && !edge { offset += 1 }
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = spacing
        let base: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph, .foregroundColor: NSColor.labelColor]
        let tail = NSMutableAttributedString(string: "")
        if edge && prefix < lines.count { tail.append(NSAttributedString(string: "\n", attributes: base)) }
        for index in prefix..<lines.count {
            if index > prefix { tail.append(NSAttributedString(string: "\n", attributes: base)) }
            var attributes = base
            switch lines[index].change {
            case .context: break
            case .removed: attributes[.foregroundColor] = NSColor(Color.red)
            case .added: attributes[.foregroundColor] = NSColor(Color.green)
            }
            tail.append(NSAttributedString(string: lines[index].text, attributes: attributes))
        }
        let selection = selectedRanges
        storage.beginEditing()
        storage.replaceCharacters(in: NSRange(location: offset, length: storage.length - offset), with: tail)
        storage.endEditing()
        selectedRanges = selection.map {
            let range = $0.rangeValue; let location = min(range.location, storage.length)
            return NSValue(range: NSRange(location: location, length: min(range.length, storage.length - location)))
        }
        previous = lines; previousFont = font; previousSpacing = spacing
        manager.ensureLayout(for: container)
        let rect = manager.usedRect(for: container)
        let extra = manager.extraLineFragmentRect
        measuredSize = CGSize(width: max(1, ceil(rect.maxX)), height: max(1, ceil(max(rect.maxY, extra.maxY))))
        invalidateIntrinsicContentSize(); needsDisplay = true
    }
    override var intrinsicContentSize: NSSize { measuredSize }
}
#endif
