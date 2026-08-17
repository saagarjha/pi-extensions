import SwiftUI

@MainActor final class TranscriptFindNavigation: NSObject {
    private var consumed = false
    func claim() -> Bool {
        guard !consumed else { return false }
        consumed = true; return true
    }
    func cancel() { consumed = true }
}
struct TranscriptFindScope: Equatable {
    let row: String
    let part: Int
    let range: NSRange
    var navigation: TranscriptFindNavigation? = nil
}
private struct TranscriptFindScopeKey: EnvironmentKey {
    static let defaultValue: TranscriptFindScope? = nil
}
extension EnvironmentValues {
    var transcriptFindScope: TranscriptFindScope? {
        get { self[TranscriptFindScopeKey.self] }
        set { self[TranscriptFindScopeKey.self] = newValue }
    }
}

/// Shared only by search and match presentation; uses the existing Markdown grammar.
nonisolated enum TranscriptFindText {
    static func inline(_ source: String) -> AttributedString {
        (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
    }
    static func plain(_ source: String) -> String { String(inline(source).characters) }
    static func block(_ block: MarkdownDocument.Block) -> String? {
        switch block {
        case .paragraph(let text), .heading(let text, _), .bullet(let text), .quote(let text): return plain(text)
        case .code(let text, _): return text
        case .table(let table): return table.allRows.map { row in
            (0..<table.columnCount).map { plain($0 < row.count ? row[$0] : "") }.joined(separator: "\t")
        }.joined(separator: "\n")
        case .image: return nil
        }
    }
    static func part(_ part: SessionMessage.Part) -> String? {
        switch part {
        case .text(let text), .thinking(let text): return MarkdownDocument(text).blocks.compactMap(block).joined(separator: "\n\n")
        case .image, .toolCall: return nil
        }
    }
    static func message(_ message: SessionMessage) -> String {
        if !message.isUser && !message.isAssistant { return message.text }
        return message.parts.compactMap(part).joined(separator: "\n\n")
    }
    static func local(_ range: NSRange?, offset: Int, length: Int) -> NSRange? {
        guard let range else { return nil }
        let overlap = NSIntersectionRange(range, NSRange(location: offset, length: length))
        return overlap.length > 0 ? NSRange(location: overlap.location - offset, length: overlap.length) : nil
    }
    static func highlight(_ value: AttributedString, range: NSRange?) -> AttributedString {
        let plain = String(value.characters)
        guard let range, let indices = Range(range, in: plain),
              let lower = AttributedString.Index(indices.lowerBound, within: value),
              let upper = AttributedString.Index(indices.upperBound, within: value) else { return value }
        var result = value
        result[lower..<upper].backgroundColor = .yellow
        result[lower..<upper].foregroundColor = .black
        return result
    }
}

#if os(macOS)
import AppKit
import os

/// A presentation index, not history. NSTextFinder owns the search and its native bar.
/// Message boundaries prevent matches across unrelated rows. Scope is rendered
/// Markdown prose, thinking, code and table cells. Tool panels (which may truncate
/// or collapse), image payloads/hidden alt text and transient status UI are excluded.
@MainActor final class TranscriptFind: NSObject, NSTextFinderClient {
    /// Route native menu/button actions through the same readiness gate as keys.
    private final class ActionFinder: NSTextFinder {
        var admit: ((Action) -> Bool)?
        var pendingValidation: ((Action) -> Bool?)?
        override func performAction(_ action: Action) {
            guard admit?(action) != false else { return }
            super.performAction(action)
        }
        override func validateAction(_ action: Action) -> Bool {
            pendingValidation?(action) ?? super.validateAction(action)
        }
    }
    let finder: NSTextFinder = ActionFinder()
    private weak var scroll: NSScrollView?
    private var monitor: Any?
    private var visibility: NSKeyValueObservation?
    private nonisolated struct Segment: Sendable {
        let id: String
        let text: String
        let range: NSRange
    }
    private nonisolated struct Index: Sendable {
        let prefix: [Segment]
        let tail: [Segment]
        var length: Int { (tail.last ?? prefix.last).map { NSMaxRange($0.range) } ?? 0 }
        func segment(at index: Int) -> Segment? {
            guard index >= 0, index < length else { return nil }
            let values = index < (prefix.last.map { NSMaxRange($0.range) } ?? 0) ? prefix : tail
            var low = 0, high = values.count
            while low < high {
                let mid = (low + high) / 2
                if NSMaxRange(values[mid].range) <= index { low = mid + 1 } else { high = mid }
            }
            return low < values.count ? values[low] : nil
        }
    }
    private nonisolated struct Prefix: Sendable {
        let committed: SessionMessage.CommittedContent
        let text: [(id: String, text: String)]
        let segments: [Segment]
    }
    private nonisolated let searchIndex = OSAllocatedUnfairLock(initialState: Index(prefix: [], tail: []))
    private var prepared: Prefix?
    private var desired: SessionMessage.Transcript?
    private var published: SessionMessage.Transcript?
    private var target: String?
    private var presented = true
    private var ready = false
    private var selection = NSRange(location: 0, length: 0)
    private var lifetime: UInt64 = 0
    private var scope: UInt64 = 0
    private var prefixRevision: UInt64 = 0
    private var tailRevision: UInt64 = 0
    private var prefixInput: SessionMessage.CommittedContent?
    private var prefixWorker: Task<Prefix, Error>?
    private var prefixCompletion: Task<Void, Never>?
    private var tailInput: SessionMessage.Transcript?
    private var tailWorker: Task<[Segment], Error>?
    private var tailCompletion: Task<Void, Never>?
    private var updateWork: DispatchWorkItem?
    private var needsClear = false
    private var suspendingInterface = false
    private var resumeInterface = false
    private var actions: [NSTextFinder.Action] = []
    var reveal: ((String, NSRange) -> Void)?
    var clear: (() -> Void)?

    override init() {
        super.init()
        finder.client = self
        finder.isIncrementalSearchingEnabled = true
        finder.incrementalSearchingShouldDimContentView = false
        let gated = finder as! ActionFinder
        gated.admit = { [weak self] in self?.admit($0) ?? false }
        gated.pendingValidation = { [weak self] action in
            guard let self, !self.isCurrent else { return nil }
            return self.presented && self.desired != nil &&
                (action == .showFindInterface || action == .nextMatch || action == .previousMatch)
        }
    }
    private var isCurrent: Bool { ready && desired == published }

    func setPresented(_ value: Bool) {
        presented = value
        scroll?.isHidden = !value
        if !value {
            actions.removeAll(); resumeInterface = false
            if let scroll, let window = scroll.window,
               let responder = window.firstResponder as? NSView, responder.isDescendant(of: scroll) {
                window.makeFirstResponder(nil)
            }
        }
    }
    func attach(_ scroll: NSScrollView) {
        guard self.scroll !== scroll else { return }
        let wasPresented = presented, input = desired, inputTarget = target
        stop()
        presented = wasPresented
        self.scroll = scroll
        setPresented(presented)
        finder.findBarContainer = scroll
        scroll.findBarPosition = .aboveContent
        visibility = scroll.observe(\.isFindBarVisible, options: [.new]) { [weak self] scroll, _ in
            MainActor.assumeIsolated {
                guard let self, !scroll.isFindBarVisible, !self.suspendingInterface else { return }
                self.actions.removeAll(); self.resumeInterface = false
                self.clear?()
            }
        }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let consumed = MainActor.assumeIsolated {
                guard let self, self.presented, let window = self.scroll?.window,
                      event.window === window, window.isKeyWindow else { return false }
                let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                let key = event.charactersIgnoringModifiers?.lowercased()
                if flags == .command, key == "f" {
                    self.finder.performAction(.showFindInterface); return true
                }
                if (flags == .command || flags == [.command, .shift]), key == "g" {
                    self.finder.performAction(flags.contains(.shift) ? .previousMatch : .nextMatch)
                    return true
                }
                if event.keyCode == 53, !self.actions.isEmpty || self.scroll?.isFindBarVisible == true {
                    self.finder.performAction(.hideFindInterface); return true
                }
                return false
            }
            return consumed ? nil : event
        }
        if let input { update(input, target: inputTarget) }
    }
    func stop() {
        lifetime &+= 1; scope &+= 1
        presented = false
        cancelPrefix(); cancelTail()
        updateWork?.cancel(); updateWork = nil
        actions.removeAll(); resumeInterface = false; needsClear = false
        prepared = nil; desired = nil; published = nil; target = nil; ready = false
        selection = NSRange(location: 0, length: 0)
        searchIndex.withLock { $0 = Index(prefix: [], tail: []) }
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil; visibility = nil
        finder.findBarContainer = nil
        scroll = nil
    }
    private func admit(_ action: NSTextFinder.Action) -> Bool {
        if action == .hideFindInterface {
            if !suspendingInterface { actions.removeAll(); resumeInterface = false }
            return true
        }
        guard presented, desired != nil else { return false }
        guard isCurrent else {
            actions.append(action)
            flushPendingUpdate()
            return false
        }
        return true
    }
    private func drainActions() {
        guard presented, isCurrent else { return }
        if resumeInterface {
            resumeInterface = false
            finder.performAction(.showFindInterface)
        }
        let pending = actions; actions.removeAll()
        for action in pending {
            guard presented, isCurrent else { return }
            finder.performAction(action)
        }
    }
    private func cancelPrefix() {
        prefixRevision &+= 1
        prefixWorker?.cancel(); prefixWorker = nil
        prefixCompletion?.cancel(); prefixCompletion = nil
        prefixInput = nil
    }
    private func cancelTail() {
        tailRevision &+= 1
        tailWorker?.cancel(); tailWorker = nil
        tailCompletion?.cancel(); tailCompletion = nil
        tailInput = nil
    }
    private func invalidate(resetSelection: Bool) {
        finder.noteClientStringWillChange()
        ready = false; published = nil
        searchIndex.withLock { $0 = Index(prefix: [], tail: []) }
        finder.isIncrementalSearchingEnabled = false
        if resetSelection {
            selection = NSRange(location: 0, length: 0)
            finder.cancelFindIndicator()
            needsClear = true
        }
        let life = lifetime, currentScope = scope
        DispatchQueue.main.async { [weak self] in
            guard let self, self.lifetime == life, self.scope == currentScope else { return }
            if self.needsClear { self.needsClear = false; self.clear?() }
            guard !self.ready, self.presented, let scroll = self.scroll, scroll.isFindBarVisible else { return }
            self.resumeInterface = true
            self.suspendingInterface = true
            self.finder.performAction(.hideFindInterface)
            self.suspendingInterface = false
        }
    }
    func update(_ transcript: SessionMessage.Transcript, target: String?) {
        guard desired != transcript || self.target != target else { return }
        let changedTarget = self.target != target
        let previous = desired
        let rebuilt = previous.map { transcript.committed.changes(since: $0.committed) == nil } ?? false
        desired = transcript; self.target = target
        if changedTarget || rebuilt {
            scope &+= 1
            actions.removeAll()
            cancelPrefix(); cancelTail()
            prepared = nil
        }
        let changedPrefix = previous?.committed !== transcript.committed || changedTarget
        if changedPrefix {
            updateWork?.cancel(); updateWork = nil
            cancelTail()
            invalidate(resetSelection: changedTarget || rebuilt)
            ensurePrefix()
        } else if prefixWorker == nil, prepared?.committed === transcript.committed {
            // Preserve the existing 100ms suffix display clock. User actions flush it.
            if updateWork == nil {
                let work = DispatchWorkItem { [weak self] in self?.flushPendingUpdate() }
                updateWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: work)
            }
        }
    }
    private func flushPendingUpdate() {
        updateWork?.cancel(); updateWork = nil
        ensurePrefix()
    }
    private func ensurePrefix() {
        guard let desired else { return }
        if prepared?.committed === desired.committed {
            prepareTail()
            return
        }
        if let input = prefixInput {
            // Tail bursts never restart this work. A completed canonical ancestor
            // can seed a checked delta, but is never published as the newer cut.
            if input === desired.committed || desired.committed.changes(since: input) != nil { return }
            cancelPrefix()
        }
        prefixRevision &+= 1
        let revision = prefixRevision, life = lifetime, currentScope = scope
        let input = desired.committed, previous = prepared
        prefixInput = input
        let worker = Task.detached(priority: .userInitiated) {
            return try Self.extractPrefix(input, previous: previous)
        }
        prefixWorker = worker
        prefixCompletion = Task { @MainActor [weak self] in
            guard let result = try? await worker.value, !Task.isCancelled,
                  let self, self.lifetime == life, self.scope == currentScope,
                  self.prefixRevision == revision, let latest = self.desired else { return }
            self.prefixInput = nil; self.prefixWorker = nil; self.prefixCompletion = nil
            guard latest.committed === result.committed || latest.committed.changes(since: result.committed) != nil else {
                self.ensurePrefix(); return
            }
            self.prepared = result
            self.ensurePrefix()
        }
    }
    private nonisolated static func extractPrefix(_ input: SessionMessage.CommittedContent, previous: Prefix?) throws -> Prefix {
        var values: [(id: String, text: String)]
        if let previous, let changes = input.changes(since: previous.committed), input.messages.count >= previous.text.count {
            values = previous.text
            for index in changes where index < values.count {
                try Task.checkCancellation()
                let message = input.messages[index]
                values[index] = (message.id, TranscriptFindText.message(message))
            }
            for index in values.count..<input.messages.count {
                try Task.checkCancellation()
                let message = input.messages[index]
                values.append((message.id, TranscriptFindText.message(message)))
            }
        } else {
            values = []; values.reserveCapacity(input.messages.count)
            for message in input.messages {
                try Task.checkCancellation()
                values.append((message.id, TranscriptFindText.message(message)))
            }
        }
        var segments: [Segment] = [], location = 0
        segments.reserveCapacity(values.count)
        for value in values {
            try Task.checkCancellation()
            let text = value.text + "\n"
            let range = NSRange(location: location, length: (text as NSString).length)
            segments.append(Segment(id: value.id, text: text, range: range)); location += range.length
        }
        return Prefix(committed: input, text: values, segments: segments)
    }
    private func prepareTail() {
        guard let desired, let prepared, prepared.committed === desired.committed else { return }
        if isCurrent { drainActions(); return }
        if tailWorker != nil, tailInput == desired { return }
        cancelTail()
        tailInput = desired
        let messages = desired.partial.map { [$0] } ?? []
        let tail = messages + desired.pending
        if tail.isEmpty { publish([], transcript: desired, prefix: prepared); return }
        let revision = tailRevision, life = lifetime, currentScope = scope
        let offset = prepared.segments.last.map { NSMaxRange($0.range) } ?? 0
        let worker = Task.detached(priority: .userInitiated) {
            var result: [Segment] = [], location = offset
            for message in tail {
                try Task.checkCancellation()
                let text = TranscriptFindText.message(message) + "\n"
                let range = NSRange(location: location, length: (text as NSString).length)
                result.append(Segment(id: message.id, text: text, range: range)); location += range.length
            }
            return result
        }
        tailWorker = worker
        tailCompletion = Task { @MainActor [weak self] in
            guard let result = try? await worker.value, !Task.isCancelled,
                  let self, self.lifetime == life, self.scope == currentScope, self.tailRevision == revision else { return }
            self.tailWorker = nil; self.tailCompletion = nil; self.tailInput = nil
            guard self.desired == desired, self.prepared?.committed === prepared.committed else {
                self.ensurePrefix(); return
            }
            self.publish(result, transcript: desired, prefix: prepared)
        }
    }
    private func publish(_ tail: [Segment], transcript: SessionMessage.Transcript, prefix: Prefix) {
        guard desired == transcript, prepared?.committed === transcript.committed else { return }
        finder.noteClientStringWillChange()
        let index = Index(prefix: prefix.segments, tail: tail)
        searchIndex.withLock { $0 = index }
        published = transcript; ready = true
        if NSMaxRange(selection) > index.length { selection = NSRange(location: 0, length: 0) }
        // This completion runs outside a SwiftUI view update. Clear before queued
        // native actions, and invalidate any older deferred clear of this scope.
        if needsClear { needsClear = false; clear?() }
        finder.isIncrementalSearchingEnabled = true
        drainActions()
    }
    var isSelectable: Bool { presented && ready }
    var isEditable: Bool { false }
    var allowsMultipleSelection: Bool { false }
    nonisolated func stringLength() -> Int { searchIndex.withLock { $0.length } }
    private nonisolated func segment(at index: Int) -> Segment? { searchIndex.withLock { $0.segment(at: index) } }
    nonisolated func string(at characterIndex: Int, effectiveRange outRange: NSRangePointer, endsWithSearchBoundary outFlag: UnsafeMutablePointer<ObjCBool>) -> String {
        guard let value = segment(at: characterIndex) else {
            outRange.pointee = NSRange(location: characterIndex, length: 0)
            outFlag.pointee = true; return ""
        }
        outRange.pointee = value.range; outFlag.pointee = true
        return value.text
    }
    var firstSelectedRange: NSRange { ready ? selection : NSRange(location: 0, length: 0) }
    var selectedRanges: [NSValue] {
        get { ready ? [NSValue(range: selection)] : [] }
        set { if presented && ready { selection = newValue.first?.rangeValue ?? NSRange(location: 0, length: 0) } }
    }
    func scrollRangeToVisible(_ range: NSRange) {
        guard presented, ready else { return }
        selection = range
        guard let value = segment(at: range.location) else { return }
        let local = NSRange(location: range.location - value.range.location, length: min(range.length, NSMaxRange(value.range) - range.location))
        reveal?(value.id, local)
    }
}

/// Public AppKit geometry for the selected SwiftUI block. This does not replace
/// Text's selection implementation or manufacture a second rendering of the row.
struct TranscriptFindReveal: NSViewRepresentable {
    let scope: TranscriptFindScope
    final class Probe: NSView {
        var scope: TranscriptFindScope?
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); reveal() }
        func reveal() {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.window != nil, self.bounds.height > 0,
                      self.scope?.navigation?.claim() == true else { return }
                self.scrollToVisible(self.bounds)
            }
        }
    }
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) {
        guard view.scope != scope else { return }
        view.scope = scope; view.reveal()
    }
}

/// Attaches to the fallback SwiftUI ScrollView's public AppKit ancestor. No second
/// scroll view, replacement transcript, or imitation find bar is introduced.
struct TranscriptFindAttachment: NSViewRepresentable {
    let transcript: SessionMessage.Transcript
    let target: String?
    var isPresented = true
    let clear: () -> Void
    let reveal: (String, NSRange) -> Void
    final class Probe: NSView {
        let search = TranscriptFind()
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); connect() }
        override func viewDidMoveToSuperview() { super.viewDidMoveToSuperview(); connect() }
        func connect() {
            if let scroll = enclosingScrollView { search.attach(scroll) }
        }
    }
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) {
        view.search.reveal = reveal
        view.search.clear = clear
        view.search.setPresented(isPresented)
        view.search.update(transcript, target: target)
        DispatchQueue.main.async { [weak view] in view?.connect() }
    }
    static func dismantleNSView(_ view: Probe, coordinator: ()) { view.search.stop() }
}
#endif
