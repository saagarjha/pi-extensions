#if os(macOS)
import AppKit

@MainActor protocol NativeMarkdownGeometry: AnyObject {
    var proseWidth: CGFloat { get }
    var codeCharacterRanges: [NSRange] { get }
    func documentPoint(fromVisual point: NSPoint) -> NSPoint
    func codeMouseDown(_ event: NSEvent)
    func paintCode(_ code: NativeMarkdownCodeView)
}

/// TextKit 1's Objective-C callback declarations are nonisolated. Callback state
/// is main-actor-owned separately from the non-Sendable framework superclass.
/// Background layout is disabled; callbacks assert, rather than dispatch, here.
@MainActor private final class NativeMarkdownLayoutState {
    nonisolated init() {}
    weak var geometry: (any NativeMarkdownGeometry)?
    var codeGlyphRanges: [NSRange] = []
    var mappingDepth = 0
    var visualHitDepth = 0
    var codeDrawingDepth = 0
    func beginMapping(_ point: NSPoint) -> NSPoint {
        let point = visualHitDepth > 0 && mappingDepth == 0 && codeDrawingDepth == 0
            ? geometry?.documentPoint(fromVisual: point) ?? point : point
        mappingDepth += 1
        return point
    }
    func drawingRanges(_ range: NSRange) -> [NSRange] {
        if codeDrawingDepth > 0 { return [range] }
        guard range.length > 0 else { return [] }
        var result: [NSRange] = [], cursor = range.location
        for code in codeGlyphRanges {
            let overlap = NSIntersectionRange(code, range)
            guard overlap.length > 0 else { continue }
            if cursor < overlap.location { result.append(NSRange(location: cursor, length: overlap.location - cursor)) }
            cursor = max(cursor, NSMaxRange(overlap))
        }
        if cursor < NSMaxRange(range) { result.append(NSRange(location: cursor, length: NSMaxRange(range) - cursor)) }
        return result
    }
}

/// Prose uses the current native proposal; code uses the same document and glyph
/// indexes, but is not line-wrapped. No code payload is replaced by an attachment.
nonisolated final class NativeMarkdownTextContainer: NSTextContainer {
    private nonisolated let state = NativeMarkdownLayoutState()
    @MainActor var geometry: (any NativeMarkdownGeometry)? {
        get { state.geometry }
        set { state.geometry = newValue }
    }
    override var isSimpleRectangularTextContainer: Bool { false }
    override func lineFragmentRect(forProposedRect rect: NSRect, at index: Int,
                                   writingDirection: NSWritingDirection,
                                   remaining: UnsafeMutablePointer<NSRect>?) -> NSRect {
        let state = state
        let width: CGFloat? = MainActor.assumeIsolated {
            guard let geometry = state.geometry,
                  !geometry.codeCharacterRanges.contains(where: { NSLocationInRange(index, $0) }) else { return nil }
            return geometry.proseWidth
        }
        var result = super.lineFragmentRect(forProposedRect: rect, at: index,
                                            writingDirection: writingDirection, remaining: remaining)
        if let width { result.size.width = max(0, min(result.width, width - result.minX)) }
        remaining?.pointee = .zero
        return result
    }
}

/// NSTextView's native mouse handling uses these layout-manager primitives, not
/// its characterIndexForInsertion(at:) helper. Keep every hit test in the real
/// document's character space, including text in horizontally scrolled code.
nonisolated final class NativeMarkdownLayoutManager: NSLayoutManager {
    private nonisolated let state = NativeMarkdownLayoutState()
    @MainActor var geometry: (any NativeMarkdownGeometry)? {
        get { state.geometry }
        set { state.geometry = newValue }
    }
    @MainActor var codeGlyphRanges: [NSRange] {
        get { state.codeGlyphRanges }
        set { state.codeGlyphRanges = newValue }
    }
    @MainActor func withVisualHitTesting<T>(_ body: @MainActor () -> T) -> T {
        state.visualHitDepth += 1; defer { state.visualHitDepth -= 1 }
        return body()
    }
    override func characterIndex(for point: NSPoint, in container: NSTextContainer,
                                 fractionOfDistanceBetweenInsertionPoints fraction: UnsafeMutablePointer<CGFloat>?) -> Int {
        let state = state
        let point = MainActor.assumeIsolated { state.beginMapping(point) }
        defer { MainActor.assumeIsolated { state.mappingDepth -= 1 } }
        return super.characterIndex(for: point, in: container, fractionOfDistanceBetweenInsertionPoints: fraction)
    }
    override func glyphIndex(for point: NSPoint, in container: NSTextContainer,
                             fractionOfDistanceThroughGlyph fraction: UnsafeMutablePointer<CGFloat>?) -> Int {
        let state = state
        let point = MainActor.assumeIsolated { state.beginMapping(point) }
        defer { MainActor.assumeIsolated { state.mappingDepth -= 1 } }
        return super.glyphIndex(for: point, in: container, fractionOfDistanceThroughGlyph: fraction)
    }
    override func glyphIndex(for point: NSPoint, in container: NSTextContainer) -> Int {
        let state = state
        let point = MainActor.assumeIsolated { state.beginMapping(point) }
        defer { MainActor.assumeIsolated { state.mappingDepth -= 1 } }
        return super.glyphIndex(for: point, in: container)
    }
    override func drawBackground(forGlyphRange range: NSRange, at origin: NSPoint) {
        let state = state
        let ranges = MainActor.assumeIsolated { state.drawingRanges(range) }
        for range in ranges { super.drawBackground(forGlyphRange: range, at: origin) }
    }
    override func drawGlyphs(forGlyphRange range: NSRange, at origin: NSPoint) {
        let state = state
        let ranges = MainActor.assumeIsolated { state.drawingRanges(range) }
        for range in ranges { super.drawGlyphs(forGlyphRange: range, at: origin) }
    }
    @MainActor func drawCode(_ range: NSRange, origin: NSPoint) {
        state.codeDrawingDepth += 1; defer { state.codeDrawingDepth -= 1 }
        drawBackground(forGlyphRange: range, at: origin)
        drawGlyphs(forGlyphRange: range, at: origin)
    }
}

@MainActor final class NativeMarkdownCodeView: NSScrollView {
    private final class Canvas: NSView {
        weak var code: NativeMarkdownCodeView?
        override var isFlipped: Bool { true }
        override func draw(_ dirtyRect: NSRect) {
            guard let code else { return }
            code.geometry?.paintCode(code)
        }
        override func mouseDown(with event: NSEvent) { code?.geometry?.codeMouseDown(event) }
        override func resetCursorRects() { addCursorRect(bounds, cursor: .iBeam) }
        override func isAccessibilityElement() -> Bool { false }
        override func accessibilityChildren() -> [Any]? { [] }
    }
    weak var geometry: (any NativeMarkdownGeometry)?
    let blockIndex: Int
    var characterRange = NSRange(location: 0, length: 0)
    var glyphRange = NSRange(location: 0, length: 0)
    var documentGlyphRect = NSRect.zero
    private let canvas = Canvas()
    private var initialPosition = true
    private(set) var leadingInset: CGFloat = 0

    init(blockIndex: Int) {
        self.blockIndex = blockIndex
        super.init(frame: .zero)
        drawsBackground = false
        hasHorizontalScroller = true; hasVerticalScroller = false
        scrollerStyle = .overlay
        automaticallyAdjustsContentInsets = false
        canvas.code = self
        documentView = canvas
        setAccessibilityLabel("Code horizontal scroll")
    }
    required init?(coder: NSCoder) { fatalError("not used") }
    func update(frame: NSRect, glyphRect: NSRect, rightToLeft: Bool) {
        let old = contentView.bounds.minX
        self.frame = frame
        documentGlyphRect = glyphRect
        canvas.frame = NSRect(x: 0, y: 0, width: max(frame.width, ceil(glyphRect.width)), height: max(0, ceil(glyphRect.height)))
        leadingInset = rightToLeft ? max(0, canvas.frame.width - glyphRect.width) : 0
        let maximum = max(0, canvas.frame.width - contentView.bounds.width)
        let offset = initialPosition && rightToLeft ? maximum : min(maximum, max(0, old))
        initialPosition = false
        contentView.scroll(to: NSPoint(x: offset, y: 0))
        reflectScrolledClipView(contentView)
        canvas.needsDisplay = true
    }
    var horizontalOffset: CGFloat { contentView.bounds.minX }
    var documentOffset: CGFloat { documentGlyphRect.minX - frame.minX + horizontalOffset - leadingInset }
    func showDocumentX(_ x: CGFloat) {
        let x = x - documentGlyphRect.minX + leadingInset
        let bounds = contentView.bounds
        var offset = bounds.minX
        if x < bounds.minX { offset = x }
        else if x > bounds.maxX - 2 { offset = x - bounds.width + 2 }
        offset = min(max(0, canvas.frame.width - bounds.width), max(0, offset))
        contentView.scroll(to: NSPoint(x: offset, y: 0))
        reflectScrolledClipView(contentView)
    }
    func invalidateSelection() { canvas.needsDisplay = true }
}
#endif
