#if os(macOS)
import AppKit
import SwiftUI

/// One read-only native text document owns prose AND literal code characters.
/// Code/table scrollers paint real character ranges of this document, not
/// screenshots or nested text views. Only images are attachments; prose, code and
/// tables retain native selection, clipboard and accessibility character indexes.
/// Experimental palette: app-semantic NSColors, not an arbitrary inherited
/// SwiftUI foreground ShapeStyle/tint bridge. Do not claim full style parity.
@MainActor final class NativeMarkdownTextView: NSTextView, NSTextViewDelegate, @preconcurrency NSLayoutManagerDelegate, NativeMarkdownGeometry {
    private struct Style: Equatable {
        let fonts: [Font.Resolved]
        let fontContext: Font.Context
        let displayScale: CGFloat
        let spacing: CGFloat
        let lineHeight: AttributedString.LineHeight?
        let locale: String
        let dark: Bool
        let contrast: Bool
        let rightToLeft: Bool
    }
    private struct TableLayout {
        let rows: [NSRange]
        let width: CGFloat
    }
    private struct Block {
        let value: MarkdownDocument.Block
        let attributed: NSAttributedString
        let separator: [NSAttributedString.Key: Any]
        let localCode: NSRange?
        var table: TableLayout? = nil
        var image: NativeMarkdownImageCell? = nil
        var range = NSRange(location: 0, length: 0)
        var frame = NSRect.zero
        var lastLineBottom:CGFloat=0
        var codeFrame=NSRect.null
        var hasLayout=false
    }
    let nativeLayout: NativeMarkdownLayoutManager
    let nativeContainer: NativeMarkdownTextContainer
    private var fontContext: Font.Context?
    private var fontSources: [Font] = []
    private var style: Style?
    private var blocks: [Block] = []
    private var codes: [Int: NativeMarkdownCodeView] = [:]
    private var updating = false
    private var emptyTextHeight:CGFloat=14
    private var lineMetrics: [NativeMarkdownFont.LineMetrics] = []
    private var fixedLineHeight: Bool { style?.lineHeight != nil && style?.lineHeight != .variable }
    private var previousSelection = NSRange(location: 0, length: 0)
    private(set) var source = ""
    private(set) var contentRevision: UInt64 = 0
    private(set) var measuredRevision: UInt64 = 0
    private(set) var measuredSize = NSSize(width: 1, height: 1)
    private(set) var proseWidth: CGFloat = 1
    var openLink: ((URL) -> Void)?
    var selectionChanged: ((NativeMarkdownTextView) -> Void)?
    var focusChanged: ((NativeMarkdownTextView, Bool) -> Void)?
    var codeCharacterRanges: [NSRange] {
        blocks.compactMap { block in
            block.localCode.map { NSRange(location: block.range.location + $0.location, length: $0.length) }
        }
    }

    /// Translate the find index's rendered block text to this document's actual
    /// characters. Bullets, code language labels, images and paragraph separators
    /// exist in TextKit but are deliberately not searchable message prose.
    func transcriptFindRange(_ range: NSRange) -> NSRange? {
        var offset = 0
        var first: Int?, last: Int?
        for block in blocks {
            guard let plain = TranscriptFindText.block(block.value) else { continue }
            let length = plain.utf16.count
            if let local = TranscriptFindText.local(range, offset: offset, length: length) {
                let prefix: Int
                switch block.value {
                case .bullet: prefix = 2
                case .code: prefix = block.localCode?.location ?? 0
                default: prefix = 0
                }
                let start = block.range.location + prefix + local.location
                first = first ?? start
                last = start + local.length
            }
            offset += length + 2
        }
        guard let first, let last else { return nil }
        return NSRange(location: first, length: last - first)
    }

    init() {
        let storage = NSTextStorage()
        nativeLayout = NativeMarkdownLayoutManager()
        nativeContainer = NativeMarkdownTextContainer(containerSize: NSSize(width: CGFloat.greatestFiniteMagnitude,
                                                                            height: CGFloat.greatestFiniteMagnitude))
        nativeContainer.lineFragmentPadding = 0
        storage.addLayoutManager(nativeLayout); nativeLayout.addTextContainer(nativeContainer)
        super.init(frame: .zero, textContainer: nativeContainer)
        nativeContainer.geometry = self; nativeLayout.geometry = self
        // This document is owned and laid out exclusively by its main-actor view.
        nativeLayout.usesFontLeading = false; nativeLayout.backgroundLayoutEnabled = false; nativeLayout.delegate = self
        nativeContainer.widthTracksTextView = false; nativeContainer.heightTracksTextView = false
        isEditable = false; isSelectable = true; isRichText = true; importsGraphics = true; allowsUndo = false
        isHorizontallyResizable = false; isVerticallyResizable = false
        drawsBackground = false; textContainerInset = .zero
        isContinuousSpellCheckingEnabled = false; isAutomaticLinkDetectionEnabled = false
        delegate = self
        linkTextAttributes = [.foregroundColor: NSColor.linkColor, .underlineStyle: 0]
        setAccessibilityLabel("Message text")
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ document: MarkdownDocument, environment: EnvironmentValues) {
        let fontSources: [Font] = [environment.font ?? .system(size:NSFont.systemFontSize), .title2.weight(.semibold),
                                  .title3.weight(.semibold), .headline.weight(.semibold),
                                  .caption, .system(.body, design: .monospaced)]
        let nextStyle = Style(fonts: fontSources.map { $0.resolve(in: environment.fontResolutionContext) },
                              fontContext: environment.fontResolutionContext, displayScale: environment.displayScale,
                              spacing: environment.lineSpacing, lineHeight: environment.lineHeight,
                              locale: environment.locale.identifier,
                              dark: environment.colorScheme == .dark,
                              contrast: environment.colorSchemeContrast == .increased,
                              rightToLeft: environment.layoutDirection == .rightToLeft)
        guard source != document.source || style != nextStyle else { return }
        let styleChanged = style != nextStyle
        self.fontContext = environment.fontResolutionContext; self.fontSources = fontSources; style = nextStyle
        if styleChanged {
            lineMetrics = fontSources.map { NativeMarkdownFont.firstLine($0, environment: environment) }
            emptyTextHeight = NSHostingView(rootView: Text("").environment(\.self, environment)).fittingSize.height
        }
        appearance = NSAppearance(named: nextStyle.contrast
                                  ? (nextStyle.dark ? .accessibilityHighContrastDarkAqua : .accessibilityHighContrastAqua)
                                  : (nextStyle.dark ? .darkAqua : .aqua))
        var prefix = 0
        if !styleChanged {
            while prefix < min(blocks.count, document.blocks.count), blocks[prefix].value == document.blocks[prefix] { prefix += 1 }
        }
        var next = Array(blocks.prefix(prefix))
        for value in document.blocks.dropFirst(prefix) { next.append(render(value)) }
        var offset = 0
        for index in next.indices {
            next[index].range = NSRange(location: offset, length: next[index].attributed.length)
            offset += next[index].attributed.length + (index + 1 < next.count ? 1 : 0)
        }
        guard let storage = textStorage else { return }
        let oldText = storage.string as NSString
        let selections = selectedRanges.map(\.rangeValue)
        let tail = NSMutableAttributedString(string: "")
        var editOffset = blocks.prefix(prefix).reduce(0) { $0 + $1.attributed.length } + max(0, prefix - 1)
        let edge = prefix > 0 && (prefix == blocks.count || prefix == next.count)
        if prefix > 0 && !edge { editOffset += 1 }
        if edge && prefix < next.count {
            tail.append(NSAttributedString(string: "\n", attributes: next[prefix - 1].separator))
        }
        for index in prefix..<next.count {
            if index > prefix { tail.append(NSAttributedString(string: "\n", attributes: next[index - 1].separator)) }
            tail.append(next[index].attributed)
        }
        // Compute an exact visible-text edit for selection mapping. Formatting-only
        // changes keep character positions, including paragraph -> heading/fence.
        let oldTail = oldText.substring(from: min(editOffset, oldText.length)) as NSString
        let newTail = tail.string as NSString
        var sameStart = 0
        while sameStart < min(oldTail.length, newTail.length), oldTail.character(at: sameStart) == newTail.character(at: sameStart) { sameStart += 1 }
        var sameEnd = 0
        while sameEnd < min(oldTail.length, newTail.length) - sameStart,
              oldTail.character(at: oldTail.length - sameEnd - 1) == newTail.character(at: newTail.length - sameEnd - 1) { sameEnd += 1 }
        // UTF-16 equality may stop inside a surrogate pair or combining cluster.
        // Expand the actual text edit before mapping native selection endpoints.
        for value in [oldTail, newTail] where sameStart > 0 && sameStart < value.length {
            sameStart = min(sameStart, value.rangeOfComposedCharacterSequence(at: sameStart).location)
        }
        for value in [oldTail, newTail] where sameEnd > 0 && sameEnd < value.length {
            let boundary = value.length - sameEnd
            let cluster = value.rangeOfComposedCharacterSequence(at: boundary)
            if cluster.location < boundary { sameEnd = min(sameEnd, value.length - NSMaxRange(cluster)) }
        }
        let oldEdit = NSRange(location: editOffset + sameStart, length: oldTail.length - sameStart - sameEnd)
        let inserted = newTail.length - sameStart - sameEnd
        updating = true
        blocks = next
        source = document.source; contentRevision &+= 1
        storage.beginEditing()
        storage.replaceCharacters(in: NSRange(location: editOffset, length: storage.length - editOffset), with: tail)
        storage.endEditing()
        selectedRanges = selections.map { NSValue(range: Self.mapSelection($0, edit: oldEdit, inserted: inserted, length: storage.length)) }
        updating = false
        previousSelection = selectedRange()
        for index in Array(codes.keys) where !blocks.indices.contains(index) || blocks[index].localCode == nil {
            codes.removeValue(forKey: index)?.removeFromSuperview()
        }
        nativeLayout.codeGlyphRanges = codeCharacterRanges.filter { $0.length > 0 }.map {
            nativeLayout.glyphRange(forCharacterRange: $0, actualCharacterRange: nil)
        }
        invalidateIntrinsicContentSize(); needsDisplay = true
        selectionChanged?(self)
    }

    private static func mapSelection(_ selection: NSRange, edit: NSRange, inserted: Int, length: Int) -> NSRange {
        let delta = inserted - edit.length
        if edit.length == 0 {
            if selection.length == 0 {
                let position = selection.location > edit.location ? selection.location + inserted : selection.location
                return NSRange(location: min(length, position), length: 0)
            }
            let start = selection.location >= edit.location ? selection.location + inserted : selection.location
            let end = NSMaxRange(selection) > edit.location ? NSMaxRange(selection) + inserted : NSMaxRange(selection)
            return NSRange(location: min(length, start), length: max(0, min(length, end) - min(length, start)))
        }
        func map(_ index: Int, end: Bool) -> Int {
            if index < edit.location || (index == edit.location && !end) { return index }
            if index >= NSMaxRange(edit) { return index + delta }
            return edit.location + (end ? inserted : 0)
        }
        let start = min(length, max(0, map(selection.location, end: false)))
        if selection.length == 0 { return NSRange(location: start, length: 0) }
        let end = min(length, max(start, map(NSMaxRange(selection), end: true)))
        return NSRange(location: start, length: end - start)
    }

    private func paragraph() -> NSMutableParagraphStyle {
        let value = NSMutableParagraphStyle()
        value.lineSpacing = 0
        value.baseWritingDirection = style?.rightToLeft == true ? .rightToLeft : .leftToRight
        return value
    }
    private func font(_ index: Int, intent: InlinePresentationIntent = []) -> NSFont {
        var value = fontSources[index]
        if intent.contains(.code) { value = value.monospaced() }
        if intent.contains(.stronglyEmphasized) { value = value.bold() }
        if intent.contains(.emphasized) { value = value.italic() }
        return NativeMarkdownFont.resolve(value, context: fontContext!)
    }
    private func inline(_ source: String, font index: Int, color: NSColor) -> NSMutableAttributedString {
        let parsed = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
        let result = NSMutableAttributedString(string: "")
        for run in parsed.runs {
            let intent = run.inlinePresentationIntent ?? []
            var attributes: [NSAttributedString.Key: Any] = [.font: font(index, intent: intent),
                .foregroundColor: color, .paragraphStyle: paragraph()]
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link; attributes[.foregroundColor] = NSColor.linkColor }
            result.append(NSAttributedString(string: String(parsed[run.range].characters), attributes: attributes))
        }
        return result
    }
    private func render(_ value: MarkdownDocument.Block) -> Block {
        let text: NSMutableAttributedString
        var code: NSRange?
        var table: TableLayout?
        var imageCell: NativeMarkdownImageCell?
        var baseFont = 0
        switch value {
        case .paragraph(let source): text = inline(source, font: 0, color: .labelColor)
        case .heading(let source, let level):
            baseFont = level == 1 ? 1 : level == 2 ? 2 : 3
            text = inline(source, font: baseFont, color: .labelColor)
        case .bullet(let source):
            text = NSMutableAttributedString(string: "• ", attributes: [.font: font(0), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: paragraph()])
            let marker = NSAttributedString(string: "•", attributes: [.font: font(0)]).size().width
            let space = NSAttributedString(string: " ", attributes: [.font: font(0)]).size().width
            text.addAttribute(.kern, value: 10 - space, range: NSRange(location: 1, length: 1))
            text.append(inline(source, font: 0, color: .labelColor))
            let p = paragraph(); p.headIndent = marker + 10
            text.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: text.length))
        case .quote(let source):
            text = inline(source, font: 0, color: .secondaryLabelColor)
            let p = paragraph(); p.firstLineHeadIndent = 15; p.headIndent = 15
            if text.length > 0 { text.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: text.length)) }
        case .table(let value):
            (text, table) = renderTable(value)
            code = NSRange(location: 0, length: text.length)
        case .image(let value):
            switch value.isComplete ? MarkdownImages.resolve(destination: value.destination) : .unavailable("Incomplete image reference.") {
            case .image(let decoded):
                let cell = NativeMarkdownImageCell(decoded, width: proseWidth)
                imageCell = cell
                let wrapper = FileWrapper(regularFileWithContents: decoded.data)
                wrapper.preferredFilename = "image." + String(decoded.mimeType.split(separator: "/").last ?? "png")
                let attachment = NSTextAttachment(fileWrapper: wrapper)
                attachment.attachmentCell = cell
                text = NSMutableAttributedString(attributedString: NSAttributedString(attachment: attachment))
                text.addAttributes([.font: font(0), .paragraphStyle: paragraph(), .toolTip: value.title ?? value.alt,
                                    NSAttributedString.Key("PiMarkdownImageAlt"): value.alt.isEmpty ? "Image" : value.alt],
                                   range: NSRange(location: 0, length: text.length))
                if !value.alt.isEmpty {
                    text.append(NSAttributedString(string: "\n", attributes: [.font: font(0), .paragraphStyle: paragraph()]))
                    text.append(NSAttributedString(string: value.alt, attributes: [.font: font(4),
                        .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: paragraph()]))
                }
            case .unavailable(let reason):
                text = NSMutableAttributedString(string: value.alt.isEmpty ? "Image" : value.alt,
                    attributes: [.font: font(0), .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph()])
                text.append(NSAttributedString(string: "\n" + reason, attributes: [.font: font(4),
                    .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: paragraph()]))
                if let url = MarkdownImages.browserURL(value.destination) {
                    text.append(NSAttributedString(string: "\nOpen image in browser", attributes:
                        [.font: font(4), .foregroundColor: NSColor.linkColor, .link: url, .paragraphStyle: paragraph()]))
                }
            }
        case .code(let source, let language):
            baseFont = 5
            text = NSMutableAttributedString(string: "")
            if !language.isEmpty {
                let p = paragraph(); p.firstLineHeadIndent = 12; p.headIndent = 12
                p.tailIndent = -12; p.paragraphSpacing = 0
                text.append(NSAttributedString(string: language + "\n", attributes: [.font: font(4), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: p]))
            }
            code = NSRange(location: text.length, length: (source as NSString).length)
            let p = paragraph(); p.firstLineHeadIndent = 12; p.headIndent = 12
            text.append(NSAttributedString(string: source, attributes: [.font: font(5), .foregroundColor: NSColor.labelColor, .paragraphStyle: p]))
        }
        let last = paragraph()
        last.paragraphSpacing = 0
        if code != nil { last.firstLineHeadIndent = 12; last.headIndent = 12 }
        if case .quote = value { last.firstLineHeadIndent = 15; last.headIndent = 15 }
        if text.length > 0 {
            let string = text.string as NSString
            let range = string.paragraphRange(for: NSRange(location: max(0, string.length - 1), length: 0))
            let existing = text.attribute(.paragraphStyle, at: max(0, text.length - 1), effectiveRange: nil) as? NSParagraphStyle
            let p = (existing?.mutableCopy() as? NSMutableParagraphStyle) ?? last
            p.paragraphSpacing = last.paragraphSpacing
            text.addAttribute(.paragraphStyle, value: p, range: range)
        }
        return Block(value: value, attributed: text, separator: [.font: font(baseFont), .foregroundColor: NSColor.labelColor, .paragraphStyle: last],
                     localCode: code, table: table, image: imageCell)
    }

    /// Tabs are real selectable/copyable characters, not a table screenshot or
    /// nested text views. The existing horizontal-range machinery handles wide
    /// tables without sacrificing cross-prose/table/code selection.
    private func renderTable(_ table: MarkdownDocument.Table) -> (NSMutableAttributedString, TableLayout?) {
        let columns = table.columnCount
        let rows = table.allRows.enumerated().map { row, cells in
            (0..<columns).map { column -> NSMutableAttributedString in
                let cell = inline(column < cells.count ? cells[column] : "", font: 0, color: .labelColor)
                if row == 0 {
                    cell.enumerateAttribute(.font, in: NSRange(location: 0, length: cell.length)) { value, range, _ in
                        if let value = value as? NSFont {
                            cell.addAttribute(.font, value: NSFontManager.shared.convert(value, toHaveTrait: .boldFontMask), range: range)
                        }
                    }
                }
                return cell
            }
        }
        let widths = (0..<columns).map { column in max(24, rows.map { ceil($0[column].size().width) }.max() ?? 0) }
        var starts: [CGFloat] = [], cursor: CGFloat = 12
        for width in widths { starts.append(cursor); cursor += width + 20 }
        let text = NSMutableAttributedString(string: "")
        var ranges: [NSRange] = []
        for (rowIndex, cells) in rows.enumerated() {
            let start = text.length
            let p = paragraph()
            let firstWidth = cells.first?.size().width ?? 0
            let alignment = table.alignment(at: 0)
            p.firstLineHeadIndent = 12 + (alignment == .right ? widths[0] - firstWidth : alignment == .center ? (widths[0] - firstWidth) / 2 : 0)
            p.headIndent = 12
            p.tabStops = (1..<columns).map { column in
                let alignment = table.alignment(at: column)
                let type: NSTextAlignment = alignment == .right ? .right : alignment == .center ? .center : .left
                return NSTextTab(textAlignment: type,
                    location: starts[column] + (alignment == .right ? widths[column] : alignment == .center ? widths[column] / 2 : 0))
            }
            for (column, cell) in cells.enumerated() {
                if column > 0 { text.append(NSAttributedString(string: "\t", attributes: [.font: font(0)])) }
                text.append(cell)
            }
            ranges.append(NSRange(location: start, length: text.length - start))
            if rowIndex + 1 < rows.count { text.append(NSAttributedString(string: "\n", attributes: [.font: font(0)])) }
            text.addAttribute(.paragraphStyle, value: p, range: NSRange(location: start, length: text.length - start))
        }
        return (text, TableLayout(rows: ranges, width: max(0, cursor - 32)))
    }

    func measure(width: CGFloat) -> NSSize {
        guard width.isFinite, width > 0 else { return measuredSize }
        if proseWidth != width {
            proseWidth = width
            for index in blocks.indices {
                blocks[index].hasLayout=false; blocks[index].codeFrame = .null
                blocks[index].image?.resize(width: width)
            }
            nativeLayout.textContainerChangedGeometry(nativeContainer)
        }
        nativeLayout.ensureLayout(for: nativeContainer)
        for index in blocks.indices {
            let block=blocks[index]
            if !block.hasLayout {
                let y=index == 0 ? 0 : blocks[index-1].frame.maxY + 12
                let padding:CGFloat=block.localCode == nil ? 0:24
                blocks[index].frame=NSRect(x:0,y:y,width:width,height:emptyTextHeight+padding)
                blocks[index].lastLineBottom=y+emptyTextHeight+(padding/2)
                if padding > 0 {blocks[index].codeFrame=NSRect(x:12,y:y+12,width:0,height:emptyTextHeight)}
                nativeLayout.setExtraLineFragmentRect(NSRect(x:0,y:y+padding/2,width:width,height:emptyTextHeight),usedRect:NSRect(x:padding/2,y:y+padding/2,width:0,height:emptyTextHeight),textContainer:nativeContainer)
            } else if index == blocks.count-1, block.attributed.string.hasSuffix("\n") {
                let emptyCode=block.localCode?.length == 0
                let font=font(block.localCode == nil ? 0:5)
                let height = emptyCode ? emptyTextHeight : fixedLineHeight
                    ? lineMetrics[block.localCode == nil ? 0 : 5].height : font.ascender - font.descender
                let gap: CGFloat = emptyCode ? 8 : fixedLineHeight
                    ? (height > 0 ? (style?.spacing ?? 4) : 0) : max(style?.spacing ?? 4, font.leading)
                let y=block.lastLineBottom+gap
                let extra=NSRect(x:block.localCode == nil ? 0:12,y:y,width:0,height:height)
                blocks[index].frame.size.height=ceil(extra.maxY)+(block.localCode == nil ? 0:12)-block.frame.minY
                if block.localCode != nil {blocks[index].codeFrame=block.codeFrame.union(extra)}
                nativeLayout.setExtraLineFragmentRect(NSRect(x:0,y:y,width:width,height:height),usedRect:extra,textContainer:nativeContainer)
            }
            if let local=blocks[index].localCode {
                let range=NSRange(location:blocks[index].range.location+local.location,length:local.length)
                let glyphs=nativeLayout.glyphRange(forCharacterRange:range,actualCharacterRange:nil)
                if let table = blocks[index].table, !blocks[index].codeFrame.isNull {
                    blocks[index].codeFrame.size.width = max(blocks[index].codeFrame.width, table.width + 12 - blocks[index].codeFrame.minX)
                }
                let rect=blocks[index].codeFrame
                let view=codes[index] ?? NativeMarkdownCodeView(blockIndex:index)
                if codes[index] == nil {codes[index]=view;view.geometry=self;addSubview(view)}
                view.setAccessibilityLabel(blocks[index].table == nil ? "Code horizontal scroll" : "Table horizontal scroll")
                view.characterRange=range;view.glyphRange=glyphs
                view.update(frame:NSRect(x:12,y:rect.minY,width:max(0,width-24),height:ceil(rect.height)),glyphRect:rect,rightToLeft:style?.rightToLeft == true)
            }
        }
        measuredSize=NSSize(width:width,height:ceil(blocks.last?.frame.maxY ?? 0))
        measuredRevision=contentRevision
        return measuredSize
    }
    override var intrinsicContentSize:NSSize {NSSize(width:NSView.noIntrinsicMetric,height:measuredSize.height)}
    func layoutManager(_ layoutManager:NSLayoutManager,shouldSetLineFragmentRect rect:UnsafeMutablePointer<NSRect>,lineFragmentUsedRect used:UnsafeMutablePointer<NSRect>,baselineOffset:UnsafeMutablePointer<CGFloat>,in container:NSTextContainer,forGlyphRange glyphRange:NSRange)->Bool {
        let characters=layoutManager.characterRange(forGlyphRange:glyphRange,actualGlyphRange:nil)
        guard let index=blocks.lastIndex(where:{$0.range.location<=characters.location}) else{return false}
        let block=blocks[index]
        let first=characters.location==block.range.location
        let localCode=block.localCode
        let codeStart=localCode.map{block.range.location+$0.location}
        let inCode=codeStart.map{characters.location >= $0} ?? false
        let firstCode=codeStart==characters.location && localCode!.location>0
        var leading:CGFloat=0
        let hasAttachment = block.image != nil && characters.location == block.range.location
        textStorage?.enumerateAttribute(.font,in:characters){value,_,_ in if let f=value as? NSFont {leading=max(leading,f.leading)}}
        var slot = 0
        switch block.value {case .heading(_,let level):slot=level==1 ? 1:level==2 ? 2:3;case .code:slot=inCode ? 5:4;default:break}
        let spacing = fixedLineHeight ? (lineMetrics[slot].height > 0 || !inCode ? (style?.spacing ?? 4) : 0)
            : max(style?.spacing ?? 4, leading)
        // TextKit may restart inside an unchanged block when its trailing
        // separator changes. The block's saved bottom is the OLD final line,
        // not the predecessor of this callback. Read that actual cached line
        // without requesting recursive layout; never advance a mutable cursor.
        let previousBottom = glyphRange.location > 0
            ? layoutManager.lineFragmentUsedRect(forGlyphAt: glyphRange.location - 1,
                                                 effectiveRange: nil, withoutAdditionalLayout: true).maxY : 0
        var y=previousBottom+spacing
        if first {y=(index==0 ? 0:blocks[index-1].frame.maxY+12)+(localCode == nil ? 0:12)}
        else if firstCode {y=ceil(previousBottom)+8}
        let empty=block.range.length==0 || (inCode && localCode?.length==0)
        let hasFollowingLine = NSMaxRange(characters) < (textStorage?.length ?? 0) || string.hasSuffix("\n")
        var height=used.pointee.height - (hasFollowingLine ? leading : 0)
        if first || firstCode || fixedLineHeight {
            if fixedLineHeight && !hasAttachment {
                height = lineMetrics[slot].height
                baselineOffset.pointee = lineMetrics[slot].ascent
            } else { height = max(height, lineMetrics[slot].height) }
        }
        if empty {height=emptyTextHeight;baselineOffset.pointee=0}
        if case .bullet(let source)=block.value,source.isEmpty {height=max(height,baselineOffset.pointee+emptyTextHeight)}
        used.pointee.origin.y=y;used.pointee.size.height=height
        rect.pointee.origin.y=y;rect.pointee.size.height=height
        if first {
            blocks[index].frame=NSRect(x:0,y:y-(localCode == nil ? 0:12),width:proseWidth,height:0)
            blocks[index].codeFrame = .null
        }
        blocks[index].lastLineBottom=y+height
        blocks[index].frame.size.height=ceil(y+height)+(localCode == nil ? 0:12)-blocks[index].frame.minY
        if case .quote = block.value { blocks[index].frame.size.height = max(10, blocks[index].frame.height) }
        if case .bullet = block.value { blocks[index].frame.size.height = max(baselineOffset.pointee, blocks[index].frame.height) }
        blocks[index].hasLayout=true
        if inCode {blocks[index].codeFrame=blocks[index].codeFrame.union(used.pointee)}
        return true
    }

    override func draw(_ dirtyRect: NSRect) {
        for block in blocks where block.frame.intersects(dirtyRect) {
            switch block.value {
            case .code, .table:
                NSColor.quaternaryLabelColor.setFill()
                NSBezierPath(roundedRect: block.frame, xRadius: 8, yRadius: 8).fill()
            case .quote:
                NSColor.quaternaryLabelColor.setFill()
                NSRect(x: style?.rightToLeft == true ? proseWidth - 3 : 0, y: block.frame.minY, width: 3, height: block.frame.height).fill()
            default: break
            }
        }
        super.draw(dirtyRect)
    }
    func paintCode(_ code: NativeMarkdownCodeView) {
        if let table = blocks[code.blockIndex].table {
            let block = blocks[code.blockIndex]
            let x = code.leadingInset + 12 - code.documentGlyphRect.minX
            for (index, row) in table.rows.enumerated() where row.length > 0 {
                let character = block.range.location + row.location
                let glyph = nativeLayout.glyphIndexForCharacter(at: character)
                let rect = nativeLayout.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
                if index == 0 {
                    NSColor.quaternaryLabelColor.setFill()
                    NSRect(x: x, y: rect.minY - code.documentGlyphRect.minY, width: table.width, height: rect.height).fill()
                }
                if index + 1 < table.rows.count {
                    NSColor.separatorColor.setStroke()
                    let path = NSBezierPath()
                    let y = rect.maxY - code.documentGlyphRect.minY + 2
                    path.move(to: NSPoint(x: x, y: y)); path.line(to: NSPoint(x: x + table.width, y: y)); path.lineWidth = 0.5
                    path.stroke()
                }
            }
        }
        nativeLayout.drawCode(code.glyphRange, origin: NSPoint(x: code.leadingInset - code.documentGlyphRect.minX, y: -code.documentGlyphRect.minY))
    }
    func codeMouseDown(_ event: NSEvent) { window?.makeFirstResponder(self); mouseDown(with: event) }
    override func mouseDown(with event: NSEvent) {
        nativeLayout.withVisualHitTesting { super.mouseDown(with: event) }
    }
    override func characterIndexForInsertion(at point: NSPoint) -> Int {
        nativeLayout.withVisualHitTesting { super.characterIndexForInsertion(at: point) }
    }
    override func autoscroll(with event: NSEvent) -> Bool {
        let point = convert(event.locationInWindow, from: nil)
        if let code = codes.values.first(where: { $0.frame.minY <= point.y && point.y < $0.frame.maxY }),
           point.x < code.frame.minX || point.x > code.frame.maxX,
           code.documentView?.autoscroll(with: event) == true { return true }
        return super.autoscroll(with: event)
    }
    func documentPoint(fromVisual point: NSPoint) -> NSPoint {
        guard let code = codes.values.first(where: { $0.frame.minY <= point.y && point.y < $0.frame.maxY }) else { return point }
        return NSPoint(x: point.x + code.documentOffset, y: point.y)
    }
    private func glyphBounds(_ glyphs: NSRange) -> NSRect {
        var result = NSRect.null
        let text = string as NSString
        nativeLayout.enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, line, _ in
            var part = NSIntersectionRange(glyphs, line)
            // Newline control glyphs cover the remaining container width. That
            // is deliberately unbounded for code, not a visible text frame.
            while part.length > 0 {
                let index = self.nativeLayout.characterIndexForGlyph(at: NSMaxRange(part) - 1)
                let character = text.character(at: index)
                guard character == 10 || character == 13 else { break }
                part.length -= 1
            }
            let rect = part.length > 0
                ? self.nativeLayout.boundingRect(forGlyphRange: part, in: self.nativeContainer)
                : NSRect(x: used.minX, y: used.minY, width: 1, height: used.height)
            result = result.union(rect)
        }
        return result
    }
    private func visibleRect(for range: NSRange) -> NSRect {
        if range.length == 0, let x = insertionX(at: range.location), !string.isEmpty {
            let glyph = nativeLayout.glyphIndexForCharacter(at: min(range.location, (string as NSString).length - 1))
            let line = nativeLayout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            let code = codes.values.first { $0.characterRange.location <= range.location && range.location <= NSMaxRange($0.characterRange) }
            return NSRect(x: x - (code?.documentOffset ?? 0), y: line.minY, width: 1, height: line.height)
        }
        var result = NSRect.null
        var cursor = range.location
        for code in codes.values.sorted(by: { $0.characterRange.location < $1.characterRange.location }) {
            let overlap = NSIntersectionRange(range, code.characterRange)
            guard overlap.length > 0 else { continue }
            if cursor < overlap.location {
                let glyphs = nativeLayout.glyphRange(forCharacterRange: NSRange(location: cursor, length: overlap.location - cursor), actualCharacterRange: nil)
                result = result.union(glyphBounds(glyphs))
            }
            let glyphs = nativeLayout.glyphRange(forCharacterRange: overlap, actualCharacterRange: nil)
            var rect = glyphBounds(glyphs)
            rect.origin.x -= code.documentOffset
            result = result.union(rect); cursor = NSMaxRange(overlap)
        }
        if cursor < NSMaxRange(range) || range.length == 0 {
            let glyphs = nativeLayout.glyphRange(forCharacterRange: NSRange(location: cursor, length: NSMaxRange(range) - cursor), actualCharacterRange: nil)
            result = result.union(glyphBounds(glyphs))
        }
        return result.isNull ? .zero : result
    }
    override func accessibilityFrame(for range: NSRange) -> NSRect {
        guard let window else { return .zero }
        return window.convertToScreen(convert(visibleRect(for: range), to: nil))
    }
    override func accessibilityRange(for position: NSPoint) -> NSRange {
        guard let window else { return NSRange(location: 0, length: 0) }
        let point = convert(window.convertPoint(fromScreen: position), from: nil)
        let index = nativeLayout.withVisualHitTesting {
            nativeLayout.characterIndex(for: point, in: nativeContainer, fractionOfDistanceBetweenInsertionPoints: nil)
        }
        let value = string as NSString
        return index < value.length ? value.rangeOfComposedCharacterSequence(at: index) : NSRange(location: value.length, length: 0)
    }
    override func drawInsertionPoint(in rect: NSRect, color: NSColor, turnedOn flag: Bool) {
        var rect = rect
        if let code = codes.values.first(where: { $0.frame.minY <= rect.minY && rect.minY < $0.frame.maxY }) {
            rect.origin.x -= code.documentOffset
        }
        super.drawInsertionPoint(in: rect, color: color, turnedOn: flag)
    }
    override func writeSelection(to pasteboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        // NSTextView still advertises the legacy string type to its native Copy
        // action, while callers may use the modern UTI. Preserve both routes.
        guard type == .string || type.rawValue == "NSStringPboardType", let storage = textStorage else {
            return super.writeSelection(to: pasteboard, type: type)
        }
        var containsImage = false
        let values = selectedRanges.map { value -> String in
            let selected = storage.attributedSubstring(from: value.rangeValue)
            let result = NSMutableString(string: selected.string)
            selected.enumerateAttribute(NSAttributedString.Key("PiMarkdownImageAlt"),
                                        in: NSRange(location: 0, length: selected.length), options: .reverse) { value, range, _ in
                if let alt = value as? String {
                    containsImage = true; result.replaceCharacters(in: range, with: "[Image: \(alt)]")
                }
            }
            return result as String
        }
        return containsImage ? pasteboard.setString(values.joined(separator: "\n"), forType: type)
            : super.writeSelection(to: pasteboard, type: type)
    }
    func textViewDidChangeSelection(_ notification: Notification) {
        for code in codes.values { code.invalidateSelection() }
        guard !updating else { return }
        let range = selectedRange()
        let active = range.location != previousSelection.location && NSMaxRange(range) == NSMaxRange(previousSelection)
            ? range.location : NSMaxRange(range)
        previousSelection = range
        if let code = codes.values.first(where: { $0.characterRange.location <= active && active <= NSMaxRange($0.characterRange) }),
           let x = insertionX(at: active) { code.showDocumentX(x) }
        selectionChanged?(self)
    }
    private func insertionX(at index: Int) -> CGFloat? {
        let length = (string as NSString).length
        guard length > 0 else { return nil }
        let character = min(index, length - 1)
        let count = nativeLayout.getLineFragmentInsertionPoints(forCharacterAt: character, alternatePositions: false,
            inDisplayOrder: false, positions: nil, characterIndexes: nil)
        var positions = [CGFloat](repeating: 0, count: count), indexes = [Int](repeating: 0, count: count)
        nativeLayout.getLineFragmentInsertionPoints(forCharacterAt: character, alternatePositions: false,
            inDisplayOrder: false, positions: &positions, characterIndexes: &indexes)
        guard let match = indexes.firstIndex(of: index) else { return nil }
        let glyph = nativeLayout.glyphIndexForCharacter(at: character)
        return nativeLayout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minX + positions[match]
    }
    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        guard let url = link as? URL else { return false }
        openLink?(url); return true
    }
    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if result { focusChanged?(self, true) }
        return result
    }
    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result { focusChanged?(self, false) }
        return result
    }
}
#endif
