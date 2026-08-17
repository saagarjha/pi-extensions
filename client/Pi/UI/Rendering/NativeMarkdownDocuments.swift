#if os(macOS)
import AppKit
import Combine
import SwiftUI

nonisolated struct NativeMarkdownMessageContext: Sendable {
    let registry: NativeMarkdownDocuments
    let scope: UUID
    let publication: UInt64
    let messageID: String
    let observation: UUID?
}
private struct NativeMarkdownMessageKey: EnvironmentKey {
    static let defaultValue: NativeMarkdownMessageContext? = nil
}
extension EnvironmentValues {
    var nativeMarkdownMessage: NativeMarkdownMessageContext? {
        get { self[NativeMarkdownMessageKey.self] }
        set { self[NativeMarkdownMessageKey.self] = newValue }
    }
}

/// Owns only realized documents, the current live response, and one short commit
/// handoff. It does not retain collection items, hosting views, or history roots.
/// A committed entry always has its own key; response identity authorizes only a
/// single observed live -> newly appended entry handoff in the same provenance.
@MainActor final class NativeMarkdownDocuments {
    nonisolated struct Slot: Hashable {
        let messageID: String
        let observation: UUID?
        let part: Int
        let kind: String
    }
    @MainActor final class Document {
        let view = NativeMarkdownTextView()
        weak var registry: NativeMarkdownDocuments?
        weak var host: NativeMarkdownHost?
        let scope: UUID
        var lease = UUID()
        var publication: UInt64 = 0
        var hostOrdinal: UInt64 = 0
        var focus: Focus?
        init(registry: NativeMarkdownDocuments) { self.registry = registry; scope = registry.scope }
    }
    @MainActor final class Focus {
        weak var window: NSWindow?
        let interaction: UInt64
        init(window: NSWindow, interaction: UInt64) { self.window = window; self.interaction = interaction }
    }
    private final class WeakDocument {
        weak var value: Document?
        init(_ value: Document) { self.value = value }
    }
    private struct Hint: Equatable {
        let response: SessionMessage.ResponseIdentity?
        let observation: SessionMessage.ObservationHint?
        init(_ partial: SessionMessage) {
            response = partial.responseIdentity; observation = partial.observationHint
        }
        init(_ partial: NativeMessage) {
            response = partial.responseId.map { .init(id: $0, provider: partial.provider, role: partial.role) }
            observation = .init(timestamp: partial.timestamp, provider: partial.provider, role: partial.role)
        }
    }
    private(set) var scope = UUID()
    private(set) var interaction: UInt64 = 0
    private(set) var stopped = false
    private var publication: UInt64 = 0
    private var hostOrdinal: UInt64 = 0
    private var liveObservation: UUID?
    private var invalidatedHandoff = false
    private var sessionID: String?
    private weak var previous: SessionMessage.CommittedContent?
    private var documents: [Slot: WeakDocument] = [:]
    private var live: [Slot: Document] = [:]
    private var handoff: [Slot: Document] = [:]
    private var expiry: DispatchWorkItem?
    private var liveID: String?
    private var response: SessionMessage.ResponseIdentity?
    private var hint: SessionMessage.ObservationHint?
    private var observation = UUID()
    private var rawHint: Hint?
    private var rawInitialized = false
    private var publisher: AnyPublisher<LinkIncomingFrame, Never>?
    private var subscription: AnyCancellable?

    init(events: AnyPublisher<LinkIncomingFrame, Never>) { publisher = events }
    func userInteracted() { interaction &+= 1 }
    func nextHostOrdinal() -> UInt64 { hostOrdinal &+= 1; return hostOrdinal }
    func stop() {
        stopped = true
        subscription?.cancel(); subscription = nil; publisher = nil
        clear()
    }
    private func clear() {
        scope = UUID(); interaction &+= 1
        expiry?.cancel(); expiry = nil
        documents.removeAll(); live.removeAll(); handoff.removeAll()
        previous = nil; liveID = nil; response = nil; hint = nil
        observation = UUID(); rawHint = nil; rawInitialized = false
        liveObservation = nil; invalidatedHandoff = false
    }
    private func subscribe() {
        subscription?.cancel()
        subscription = publisher?.sink { [weak self] frame in
            // The existing presented-root subject is sent synchronously by the
            // main-actor store. Do not queue or retain entire incoming frames.
            MainActor.assumeIsolated { self?.receive(frame) }
        }
    }
    private func receive(_ frame: LinkIncomingFrame) {
        guard !stopped else { return }
        if case .snapshot(let snapshot) = frame.payload {
            guard snapshot.sessionId == sessionID else { return }
            clear(); subscribe()
            return
        }
        guard frame.sessionId == sessionID, case .live(let value) = frame.payload else { return }
        let next = value.partial.map(Hint.init)
        rawInitialized = true
        if next != rawHint {
            // Equality of this tuple is only a hint. A real nil boundary breaks
            // the observation even when timestamps/response identifiers repeat.
            if next == nil || rawHint == nil || next?.response != rawHint?.response || next?.observation != rawHint?.observation {
                // Clear unidentified observations at the boundary itself, not
                // only when a later SwiftUI render happens to observe the gap.
                for document in live.values where response == nil {
                    document.view.setSelectedRange(NSRange(location: 0, length: 0))
                    document.focus = nil
                }
                if next != nil {
                    if !live.isEmpty, next?.response == response { invalidatedHandoff = true }
                    observation = UUID()
                }
            }
            rawHint = next
        }
    }
    func update(_ transcript: SessionMessage.Transcript, sessionID: String?) {
        guard !stopped else { return }
        let old = previous
        let knownLineage = old.map { transcript.committed.changes(since: $0) != nil } ?? true
        if self.sessionID != sessionID || !knownLineage {
            clear(); self.sessionID = sessionID; subscribe()
        } else if subscription == nil {
            self.sessionID = sessionID; subscribe()
        }
        if !rawInitialized {
            rawHint = transcript.partial.map(Hint.init); rawInitialized = true
        }
        publication &+= 1
        documents = documents.filter { $0.value.value != nil }
        if let old, previous != nil, let response, !invalidatedHandoff,
           transcript.committed.messages.count > old.messages.count {
            let appended = transcript.committed.messages[old.messages.count...].filter { $0.responseIdentity == response }
            if appended.count == 1, let entry = appended.first {
                expiry?.cancel(); handoff.removeAll()
                for (key, document) in live {
                    let target = Slot(messageID: entry.id, observation: nil, part: key.part, kind: key.kind)
                    documents[target] = WeakDocument(document); handoff[target] = document
                    documents.removeValue(forKey: key)
                }
                let token = scope
                let expiry = DispatchWorkItem { [weak self] in
                    guard let self, self.scope == token else { return }
                    self.handoff.removeAll(); self.expiry = nil
                }
                self.expiry = expiry
                DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: expiry)
            }
        }
        let partial = transcript.partial
        if partial?.id != liveID || partial?.responseIdentity != response || partial?.observationHint != hint || liveObservation != observation {
            live.removeAll()
            if partial != nil { observation = UUID() }
        }
        liveID = partial?.id; response = partial?.responseIdentity; hint = partial?.observationHint
        liveObservation = partial == nil ? nil : observation
        invalidatedHandoff = false
        previous = transcript.committed
    }
    func context(for message: SessionMessage) -> NativeMarkdownMessageContext {
        NativeMarkdownMessageContext(registry: self, scope: scope, publication: publication,
                                     messageID: message.id, observation: message.id == liveID ? observation : nil)
    }
    func isCurrent(_ context: NativeMarkdownMessageContext) -> Bool {
        !stopped && context.scope == scope && (context.observation == nil ||
            (context.messageID == liveID && context.observation == observation))
    }
    func document(for context: NativeMarkdownMessageContext, part: Int, kind: String) -> Document? {
        guard isCurrent(context) else { return nil }
        let key = Slot(messageID: context.messageID, observation: context.observation, part: part, kind: kind)
        let document = handoff.removeValue(forKey: key) ?? documents[key]?.value ?? Document(registry: self)
        documents[key] = WeakDocument(document)
        if context.observation != nil { live[key] = document }
        return document
    }
}

/// A representable has its own lease/measurement, while a verified commit can
/// move the one live NSTextView document into the new row without recreating it.
@MainActor final class NativeMarkdownHost: NSView {
    var document: NativeMarkdownDocuments.Document?
    private(set) var lease = UUID()
    var ordinal: UInt64 = 0
    private(set) var measured = NSSize.zero
    override var isFlipped: Bool { true }
    var ownsDocument: Bool { document?.lease == lease && document?.host === self }
    func attach(_ document: NativeMarkdownDocuments.Document) -> Bool {
        if self.document === document && ownsDocument { return true }
        guard document.host == nil || ordinal >= document.hostOrdinal else { return false }
        if ownsDocument { self.document?.view.removeFromSuperview() }
        self.document = document; lease = UUID()
        if let window = document.view.window, window.firstResponder === document.view,
           let registry = document.registry {
            document.focus = .init(window: window, interaction: registry.interaction)
        }
        document.lease = lease; document.host = self; document.hostOrdinal = ordinal
        addSubview(document.view)
        document.view.frame = bounds
        document.view.autoresizingMask = [.width, .height]
        restoreFocus()
        return true
    }
    func measure(width: CGFloat) -> NSSize {
        guard ownsDocument, let document else { return measured }
        measured = document.view.measure(width: width)
        return measured
    }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: measured.height) }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); restoreFocus() }
    private func restoreFocus() {
        guard ownsDocument, let document, let focus = document.focus,
              let registry = document.registry, !registry.stopped, registry.scope == document.scope,
              registry.interaction == focus.interaction, let window, window === focus.window else { return }
        guard window.firstResponder == nil || window.firstResponder === window || window.firstResponder === document.view else {
            document.focus = nil; return
        }
        window.makeFirstResponder(document.view); document.focus = nil
    }
    func detach() {
        if ownsDocument, let document {
            if let window = document.view.window, window.firstResponder === document.view,
               let registry = document.registry {
                document.focus = .init(window: window, interaction: registry.interaction)
            }
            document.view.removeFromSuperview(); document.host = nil
        }
        document = nil
    }
}

struct NativeMarkdownBody: NSViewRepresentable {
    let document: MarkdownDocument
    let message: NativeMarkdownMessageContext
    let part: Int
    let kind: String
    func makeNSView(context: Context) -> NativeMarkdownHost {
        let host = NativeMarkdownHost()
        host.ordinal = message.registry.nextHostOrdinal()
        configure(host, environment: context.environment)
        return host
    }
    func updateNSView(_ host: NativeMarkdownHost, context: Context) {
        configure(host, environment: context.environment)
        host.invalidateIntrinsicContentSize()
    }
    @discardableResult private func configure(_ host: NativeMarkdownHost, environment: EnvironmentValues) -> Bool {
        guard let state = message.registry.document(for: message, part: part, kind: kind),
              message.publication >= state.publication else { return false }
        guard host.attach(state) else { return false }
        state.publication = message.publication
        let openURL = environment.openURL
        state.view.openLink = { url in openURL(url) }
        state.view.update(document, environment: environment)
        return true
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeMarkdownHost, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        // SwiftUI may size before updateNSView. Consume this exact input first.
        // A retired live wrapper can still be asked to size after its document
        // moved to the committed row. It cannot issue a fresh sizing receipt.
        guard configure(nsView, environment: context.environment) else { return nil }
        return nsView.measure(width: width)
    }
    static func dismantleNSView(_ view: NativeMarkdownHost, coordinator: ()) { view.detach() }
}
#endif
