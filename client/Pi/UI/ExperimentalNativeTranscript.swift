import SwiftUI
#if os(macOS)
import AppKit

/// Opt-in prototype. The original SwiftUI transcript remains the default/fallback.
/// Uses the existing renderers and authoritative messages; only presentation geometry is cached.
struct ExperimentalNativeTranscript: NSViewRepresentable {
    @Environment(\.self) private var environment
    let messages: SessionMessage.Transcript
    let isStreaming: Bool
    let workingMessage: String?
    let interactions: [LinkInteraction]
    let enabled: Bool
    let sessionID: String?
    let answer: (LinkInteraction, LinkJSON) -> Void
    var bottomInset: CGFloat = 0

    func makeCoordinator() -> ExperimentalTranscriptOwner { ExperimentalTranscriptOwner() }
    func makeNSView(context: Context) -> NSScrollView { context.coordinator.make() }
    static func dismantleNSView(_ view: NSScrollView, coordinator: ExperimentalTranscriptOwner) { coordinator.stop() }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        guard let width = proposal.width, let height = proposal.height,
              width.isFinite, height.isFinite, width >= 0, height >= 0 else { return nil }
        return CGSize(width: width, height: height)
    }
    func updateNSView(_ view: NSScrollView, context: Context) {
        context.coordinator.setComposerInset(bottomInset)
        context.coordinator.update(messages, isStreaming: isStreaming, workingMessage: workingMessage,
                                   interactions: interactions,
                                   environment: environment, enabled: enabled,
                                   sessionID: sessionID, answer: answer)
    }
}

fileprivate enum ExperimentalTranscriptRow {
    case message(SessionMessage), empty, spinner(String), interaction(LinkInteraction)
    var id: String {
        switch self {
        case .message(let message): message.id
        case .empty: "native:empty"
        case .spinner: "native:spinner"
        case .interaction(let request): "native:interaction:\(request.id)"
        }
    }
}

fileprivate struct ExperimentalTranscriptToken: Equatable {
    let id: String
    let revision: UInt64
    let host: UUID
    let generation: UInt64
}

@MainActor fileprivate final class ExperimentalTranscriptHost: NSHostingView<AnyView> {
    var invalidated: (() -> Void)?
    override func invalidateIntrinsicContentSize() {
        super.invalidateIntrinsicContentSize()
        invalidated?()
    }
}

@MainActor fileprivate final class ExperimentalTranscriptItem: NSCollectionViewItem {
    let host = ExperimentalTranscriptHost(rootView: AnyView(EmptyView()))
    private let hostID = UUID()
    private var generation: UInt64 = 0
    var rowID = ""
    var revision: UInt64 = 0
    private var content = AnyView(EmptyView())
    private var inputEnvironment = EnvironmentValues()
    private(set) var proposedWidth: CGFloat = 0
    private(set) var accepted: NSSize?
    private(set) var acceptedToken: ExperimentalTranscriptToken?
    var token: ExperimentalTranscriptToken {
        .init(id: rowID, revision: revision, host: hostID, generation: generation)
    }
    var invalidate: (() -> Void)?
    var measured: ((ExperimentalTranscriptItem) -> Void)?
    private var invalidationQueued = false

    override func loadView() {
        view = NSView()
        host.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.topAnchor.constraint(equalTo: view.topAnchor),
            host.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.invalidated = { [weak self] in self?.queueInvalidation() }
    }
    func configure(id: String, revision: UInt64, content: AnyView, environment: EnvironmentValues, width: CGFloat) {
        _ = view
        let changed = rowID != id || self.revision != revision || proposedWidth != width
        rowID = id
        self.revision = revision
        self.content = content
        inputEnvironment = environment
        if changed { setRoot(width: width) }
    }
    private func setRoot(width: CGFloat) {
        guard width.isFinite, width > 0 else { return }
        proposedWidth = width
        generation &+= 1
        host.rootView = AnyView(content.environment(\.self, inputEnvironment)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 28).padding(.vertical, 14)
            .frame(width: width).fixedSize(horizontal: false, vertical: true).id(rowID))
    }
    private func queueInvalidation() {
        guard !invalidationQueued else { return }
        invalidationQueued = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.invalidationQueued = false
            self.invalidate?()
        }
    }
    func hasUnchangedCurrentSize() -> Bool {
        let captured = token, width = view.bounds.width
        guard let accepted, acceptedToken == captured, width > 0,
              width == proposedWidth, host.bounds.width == width, accepted.width == width else { return false }
        let size = host.intrinsicContentSize
        return captured == token && width == view.bounds.width && size.height.isFinite
            && size.height > 0 && accepted == NSSize(width: width, height: size.height)
    }
    override func preferredLayoutAttributesFitting(_ attributes: NSCollectionViewLayoutAttributes) -> NSCollectionViewLayoutAttributes {
        let result = attributes.copy() as! NSCollectionViewLayoutAttributes
        let width = attributes.size.width
        guard width.isFinite, width > 0 else { return result }
        if proposedWidth != width { setRoot(width: width) }
        let captured = token
        // Fresh renderer measurement, never the cached presentation height.
        let size = host.intrinsicContentSize
        guard captured == token, size.height.isFinite, size.height > 0 else { return result }
        result.size = NSSize(width: width, height: size.height)
        accepted = result.size
        acceptedToken = captured
        measured?(self)
        return result
    }
    override func prepareForReuse() {
        super.prepareForReuse()
        accepted = nil
        acceptedToken = nil
        rowID = ""
        invalidate = nil
        measured = nil
    }
}

@MainActor fileprivate final class ExperimentalTranscriptContext: NSCollectionViewLayoutInvalidationContext {
    var proposal: ExperimentalTranscriptLayout.Receipt?
    var modelVersion: UInt64 = 0
    var proposedWidth: CGFloat?
}

@MainActor fileprivate final class ExperimentalTranscriptLayout: NSCollectionViewLayout {
    struct Entry {
        let id: String
        let revision: UInt64
        var height: CGFloat = 50 // Explicit provisional offscreen estimate.
        var accepted = false
    }
    struct Receipt {
        weak var item: ExperimentalTranscriptItem?
        let token: ExperimentalTranscriptToken
        let size: NSSize
        var isCurrent: Bool { item?.token == token && item?.acceptedToken == token }
    }
    private var entries: [Entry] = []
    private var frames: [NSRect] = []
    private var receipts: [String: Receipt] = [:]
    private(set) var columnWidth: CGFloat = 0
    private var extent: CGFloat = 28
    private var bottomPadding: CGFloat = 0
    private var modelVersion: UInt64 = 0
    private enum Position {
        case bottom
        case reading(id: String, offset: CGFloat, index: Int)
    }
    private var position: Position?
    private var navigationEpoch: UInt64 = 0
    private var reconciliationQueued = false
    var userNavigating = false
    var stopped = false

    /// Native navigation always wins, including over already queued corrections.
    func yieldToNavigation() {
        navigationEpoch &+= 1
        position = nil
    }
    private func capturePosition(reset: Bool = false) {
        guard !userNavigating, !stopped else { return }
        if reset { position = .bottom; return }
        guard position == nil, let clip = collectionView?.enclosingScrollView?.contentView.bounds else { return }
        if extent <= clip.height || extent - clip.maxY <= 24 {
            position = .bottom
        } else if let index = frames.firstIndex(where: { $0.maxY > clip.minY }) {
            position = .reading(id: entries[index].id, offset: clip.minY - frames[index].minY, index: index)
        }
    }
    private func positionTarget() -> CGFloat? {
        guard !userNavigating, !stopped, let clip = collectionView?.enclosingScrollView?.contentView.bounds,
              clip.height > 0, let position else { return nil }
        let maximum = max(0, extent - clip.height)
        switch position {
        case .bottom: return maximum
        case .reading(let id, let offset, let oldIndex):
            guard !frames.isEmpty else { return 0 }
            // If the anchor disappeared, retain the nearest surviving ordinal instead.
            let index = entries.firstIndex(where: { $0.id == id }) ?? min(oldIndex, frames.count - 1)
            return min(maximum, max(0, frames[index].minY + min(offset, frames[index].height - 1)))
        }
    }
    private func schedulePositionReconciliation() {
        guard !reconciliationQueued, !stopped else { return }
        reconciliationQueued = true
        let epoch = navigationEpoch
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.reconciliationQueued = false
            guard epoch == self.navigationEpoch, let target = self.positionTarget(),
                  let scroll = self.collectionView?.enclosingScrollView,
                  let document = scroll.documentView,
                  abs(document.frame.height - self.extent) < 1 else { return }
            // Native invalidation may consume an offset before resizing its document. Reconcile
            // once after publication, against the actual new range; never run a scroll-back timer.
            let clip = scroll.contentView
            if abs(clip.bounds.minY - target) > 0.5 {
                clip.scroll(to: NSPoint(x: clip.bounds.minX, y: target))
                scroll.reflectScrolledClipView(clip)
            }
        }
    }
    override class var invalidationContextClass: AnyClass { ExperimentalTranscriptContext.self }

    func publishModel(_ ids: [String], revisions: [String: UInt64], reset: Bool) {
        if !reset, ids == entries.map(\.id), entries.allSatisfy({ $0.revision == revisions[$0.id, default: 0] }) { return }
        capturePosition(reset: reset)
        let old = Dictionary(uniqueKeysWithValues: entries.map { ($0.id, $0) })
        entries = ids.map { id in
            if !reset, let previous = old[id] {
                if previous.revision == revisions[id, default: 0] { return previous }
                return Entry(id: id, revision: revisions[id, default: 0], height: previous.height)
            }
            return Entry(id: id, revision: revisions[id, default: 0])
        }
        receipts.removeAll()
        modelVersion &+= 1
        publishGeometry()
    }
    /// A content revision does not change membership or provisional geometry. Keep the
    /// existing heights until the same fresh-measurement contract accepts replacements.
    func publishRevisions(_ changes: [(index: Int, revision: UInt64)]) {
        guard !changes.isEmpty else { return }
        capturePosition()
        for change in changes {
            let previous = entries[change.index]
            entries[change.index] = Entry(id: previous.id, revision: change.revision, height: previous.height)
            receipts.removeValue(forKey: previous.id)
        }
        modelVersion &+= 1
    }
    func setBottomPadding(_ padding: CGFloat) {
        guard bottomPadding != padding else { return }
        capturePosition()
        bottomPadding = padding
        publishGeometry()
        invalidateLayout()
    }
    private func publishGeometry() {
        var y: CGFloat = 14
        frames = entries.map { entry in
            defer { y += entry.height }
            return NSRect(x: 0, y: y, width: columnWidth, height: entry.height)
        }
        extent = y + 14 + bottomPadding
        schedulePositionReconciliation()
    }
    private func publishWidth(_ width: CGFloat) {
        capturePosition()
        columnWidth = width
        receipts.removeAll()
        modelVersion &+= 1
        // Retain old heights as explicit stale estimates until fresh width measurements arrive.
        for index in entries.indices { entries[index].accepted = false }
        publishGeometry()
    }
    func noteMeasurement(_ item: ExperimentalTranscriptItem) {
        guard let size = item.accepted, item.acceptedToken == item.token else { return }
        receipts[item.rowID] = Receipt(item: item, token: item.token, size: size)
    }
    override func prepare() {
        super.prepare()
        guard let width = collectionView?.bounds.width, width.isFinite, width > 0 else { return }
        if columnWidth == 0 { publishWidth(width) }
    }
    override var collectionViewContentSize: NSSize { NSSize(width: columnWidth, height: extent) }
    override func shouldInvalidateLayout(forBoundsChange newBounds: NSRect) -> Bool { newBounds.width != columnWidth }
    func downstreamPaths(from index: Int) -> Set<IndexPath> {
        guard entries.indices.contains(index) else { return [] }
        return Set((index..<entries.count).map { IndexPath(item: $0, section: 0) })
    }
    override func invalidationContext(forBoundsChange newBounds: NSRect) -> NSCollectionViewLayoutInvalidationContext {
        let context = super.invalidationContext(forBoundsChange: newBounds) as! ExperimentalTranscriptContext
        if newBounds.width != columnWidth {
            context.invalidateItems(at: downstreamPaths(from: 0))
            context.proposedWidth = newBounds.width
            context.modelVersion = modelVersion
        }
        context.contentSizeAdjustment = .zero
        context.contentOffsetAdjustment = .zero
        return context
    }
    override func layoutAttributesForItem(at indexPath: IndexPath) -> NSCollectionViewLayoutAttributes? {
        guard indexPath.section == 0, frames.indices.contains(indexPath.item), columnWidth > 0 else { return nil }
        let attributes = NSCollectionViewLayoutAttributes(forItemWith: indexPath)
        attributes.frame = frames[indexPath.item]
        return attributes
    }
    override func layoutAttributesForElements(in rect: NSRect) -> [NSCollectionViewLayoutAttributes] {
        frames.indices.filter { frames[$0].intersects(rect) }
            .compactMap { layoutAttributesForItem(at: IndexPath(item: $0, section: 0)) }
    }
    private func validated(_ preferred: NSCollectionViewLayoutAttributes) -> Receipt? {
        guard let path = preferred.indexPath, entries.indices.contains(path.item) else { return nil }
        let entry = entries[path.item]
        guard let receipt = receipts[entry.id], receipt.isCurrent, receipt.token.revision == entry.revision,
              receipt.size == preferred.size, receipt.size.width == columnWidth,
              receipt.size.height.isFinite, receipt.size.height > 0 else { return nil }
        return receipt
    }
    override func shouldInvalidateLayout(forPreferredLayoutAttributes preferred: NSCollectionViewLayoutAttributes,
                                         withOriginalAttributes original: NSCollectionViewLayoutAttributes) -> Bool {
        guard let receipt = validated(preferred), let index = preferred.indexPath?.item else { return false }
        return !entries[index].accepted || entries[index].height != receipt.size.height
    }
    override func invalidationContext(forPreferredLayoutAttributes preferred: NSCollectionViewLayoutAttributes,
                                      withOriginalAttributes original: NSCollectionViewLayoutAttributes) -> NSCollectionViewLayoutInvalidationContext {
        let context = super.invalidationContext(forPreferredLayoutAttributes: preferred, withOriginalAttributes: original) as! ExperimentalTranscriptContext
        context.proposal = validated(preferred)
        context.modelVersion = modelVersion
        if let index = preferred.indexPath?.item { context.invalidateItems(at: downstreamPaths(from: index)) }
        context.contentSizeAdjustment = .zero
        context.contentOffsetAdjustment = .zero
        return context
    }
    override func invalidateLayout(with context: NSCollectionViewLayoutInvalidationContext) {
        if let context = context as? ExperimentalTranscriptContext {
            if let width = context.proposedWidth, width.isFinite, width > 0,
               context.modelVersion == modelVersion, collectionView?.bounds.width == width, width != columnWidth {
                // Publish before native invalidation can query/cache attributes at the new width.
                publishWidth(width)
            }
            if let receipt = context.proposal, context.modelVersion == modelVersion, receipt.isCurrent,
               let index = entries.firstIndex(where: { $0.id == receipt.token.id }),
               entries[index].revision == receipt.token.revision, receipt.size.width == columnWidth {
                capturePosition()
                entries[index].height = receipt.size.height
                entries[index].accepted = true
                publishGeometry()
            }
        }
        // Relative native contribution uses the newly published prefix geometry. Geometry is
        // always forwarded even when navigation cancels the optional position policy.
        if let target = positionTarget(), let clip = collectionView?.enclosingScrollView?.contentView {
            let inherited = context.contentOffsetAdjustment.y
            context.contentOffsetAdjustment.y += target - (clip.bounds.minY + inherited)
        }
        super.invalidateLayout(with: context)
        schedulePositionReconciliation()
    }
}

@MainActor fileprivate final class ExperimentalTranscriptScrollView: NSScrollView {
    var composerInset: CGFloat = 0 {
        didSet { if composerInset != oldValue { updateInsets() } }
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateInsets()
    }
    override func layout() {
        super.layout()
        updateInsets()
    }
    private func updateInsets() {
        let top = safeAreaInsets.top
        if contentInsets.top != top || contentInsets.bottom != composerInset {
            contentInsets = NSEdgeInsets(top: top, left: 0, bottom: composerInset, right: 0)
        }
    }
}

@MainActor final class ExperimentalTranscriptOwner: NSObject, NSCollectionViewDataSource, NSCollectionViewDelegate {
    private let collection = NSCollectionView()
    private let layout = ExperimentalTranscriptLayout()
    private let scroll = ExperimentalTranscriptScrollView()
    private var loaded = false
    private var stopped = false
    private var items: [ExperimentalTranscriptRow] = []
    private var committed: SessionMessage.CommittedProjection?
    private var revisions: [String: UInt64] = [:]
    private var environment = EnvironmentValues()
    private var enabled = false
    private var answer: ((LinkInteraction, LinkJSON) -> Void)?
    private var sessionID: String?
    private var inputMonitor: Any?
    private var scrollObservers: [NSObjectProtocol] = []
    private var pointerDown = false
    private var liveScrolling = false

    func setComposerInset(_ inset: CGFloat) {
        scroll.composerInset = inset
        layout.setBottomPadding(inset)
    }
    private func navigationChanged() {
        layout.userNavigating = pointerDown || liveScrolling
        layout.yieldToNavigation()
    }
    func make() -> NSScrollView {
        collection.collectionViewLayout = layout
        collection.dataSource = self
        collection.delegate = self
        collection.isSelectable = false
        collection.backgroundColors = [.clear]
        collection.autoresizingMask = [.width]
        collection.register(ExperimentalTranscriptItem.self, forItemWithIdentifier: NSUserInterfaceItemIdentifier("row"))
        scroll.documentView = collection
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.drawsBackground = false
        scroll.automaticallyAdjustsContentInsets = false
        inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .scrollWheel, .keyDown]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let window = self.scroll.window, event.window === window else { return }
                let inside = self.scroll.bounds.contains(self.scroll.convert(event.locationInWindow, from: nil))
                if event.type == .keyDown {
                    guard [UInt16(49), 115, 116, 119, 121, 123, 124, 125, 126].contains(event.keyCode),
                          let responder = window.firstResponder as? NSView,
                          responder.isDescendant(of: self.scroll) else { return }
                } else if !inside && !self.pointerDown { return }
                if event.type == .leftMouseDown { self.pointerDown = true }
                if event.type == .leftMouseUp { self.pointerDown = false }
                self.navigationChanged()
            }
            return event
        }
        for (name, began) in [(NSScrollView.willStartLiveScrollNotification, true), (NSScrollView.didEndLiveScrollNotification, false)] {
            scrollObservers.append(NotificationCenter.default.addObserver(forName: name, object: scroll, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.liveScrolling = began
                    self?.navigationChanged()
                }
            })
        }
        return scroll
    }
    func stop() {
        stopped = true
        layout.stopped = true
        layout.yieldToNavigation()
        if let inputMonitor { NSEvent.removeMonitor(inputMonitor) }
        inputMonitor = nil
        scrollObservers.forEach { NotificationCenter.default.removeObserver($0) }
        scrollObservers.removeAll()
        collection.dataSource = nil
        collection.delegate = nil
    }
    /// Capture concrete values, not another EnvironmentValues handle: deferred reads of
    /// a retained environment can already resolve the new values on the next update.
    private struct Presentation: Equatable {
        let font: Font?
        let lineSpacing: CGFloat
        let colorScheme: ColorScheme
        let contrast: ColorSchemeContrast
        let dynamicTypeSize: DynamicTypeSize
        let locale: Locale
        let layoutDirection: LayoutDirection
        let directory: String?
        let targets: [PermissionsSnapshot.RunningTarget]
        init(_ environment: EnvironmentValues) {
            font = environment.font; lineSpacing = environment.lineSpacing
            colorScheme = environment.colorScheme; contrast = environment.colorSchemeContrast
            dynamicTypeSize = environment.dynamicTypeSize; locale = environment.locale
            layoutDirection = environment.layoutDirection
            directory = environment.localPathDirectory; targets = environment.pathTargets
        }
    }
    private var presentation: Presentation?
    private func presentationChanged(_ environment: EnvironmentValues) -> Bool {
        presentation != Presentation(environment)
    }
    private func setEnvironment(_ environment: EnvironmentValues) {
        self.environment = environment
        presentation = Presentation(environment)
    }

    fileprivate func update(_ transcript: SessionMessage.Transcript, isStreaming: Bool,
                            workingMessage: String?, interactions: [LinkInteraction], environment: EnvironmentValues,
                            enabled: Bool, sessionID: String?, answer: @escaping (LinkInteraction, LinkJSON) -> Void) {
        var suffix = transcript.partial.map { [ExperimentalTranscriptRow.message($0)] } ?? []
        if transcript.isEmpty { suffix.append(.empty) }
        if isStreaming { suffix.append(.spinner(workingMessage ?? "Working…")) }
        suffix.append(contentsOf: interactions.map(ExperimentalTranscriptRow.interaction))
        let prefixCount = transcript.committed.messages.count
        // Only this exact immutable derived snapshot can authorize skipping the prefix.
        // New snapshot/branch/tool-result projections cannot pass this identity test.
        if loaded, self.sessionID == sessionID, committed === transcript.committed,
           !presentationChanged(environment), items.count == prefixCount + suffix.count,
           suffix.indices.allSatisfy({ items[prefixCount + $0].id == suffix[$0].id }) {
            var changes: [(index: Int, revision: UInt64)] = []
            for offset in suffix.indices {
                let index = prefixCount + offset, value = suffix[offset]
                let needsUpdate: Bool
                if case .message(let old) = items[index], case .message(let new) = value {
                    needsUpdate = old != new
                } else { needsUpdate = true }
                if needsUpdate {
                    revisions[value.id, default: 0] &+= 1
                    changes.append((index, revisions[value.id, default: 0]))
                    items[index] = value
                }
            }
            setEnvironment(environment)
            self.enabled = enabled
            self.answer = answer
            layout.publishRevisions(changes)
            let changedIndices = Set(changes.map(\.index))
            for case let item as ExperimentalTranscriptItem in collection.visibleItems() {
                if let path = collection.indexPath(for: item), changedIndices.contains(path.item) {
                    configure(item, index: path.item)
                }
            }
            if let first = changes.first?.index {
                let context = ExperimentalTranscriptContext()
                context.invalidateItems(at: layout.downstreamPaths(from: first))
                layout.invalidateLayout(with: context)
            }
            return
        }
        // Membership changes, new committed snapshots and presentation changes retain the
        // complete identity/content checks. Flatten only on this uncommon path.
        let values = transcript.committed.messages.map(ExperimentalTranscriptRow.message) + suffix
        if updateRows(values, environment: environment, enabled: enabled, sessionID: sessionID, answer: answer) {
            committed = transcript.committed
        }
    }

    private func updateRows(_ values: [ExperimentalTranscriptRow], environment: EnvironmentValues,
                            enabled: Bool, sessionID: String?, answer: @escaping (LinkInteraction, LinkJSON) -> Void) -> Bool {
        let environmentChanged = presentationChanged(environment)
        // This is the fallback for changed committed snapshots/presentation, not the
        // streaming path. Compare every retained row so earlier tool results stay correct.
        if loaded, self.sessionID == sessionID, items.count == values.count,
           zip(items, values).allSatisfy({ $0.id == $1.id }) {
            var changes: [(index: Int, revision: UInt64)] = []
            for index in values.indices {
                let needsUpdate: Bool
                if case .message(let old) = items[index], case .message(let new) = values[index] {
                    needsUpdate = old != new || environmentChanged
                } else { needsUpdate = true }
                if needsUpdate {
                    let id = values[index].id
                    revisions[id, default: 0] &+= 1
                    changes.append((index, revisions[id, default: 0]))
                }
            }
            setEnvironment(environment)
            self.enabled = enabled
            self.answer = answer
            items = values
            layout.publishRevisions(changes)
            let changedIndices = Set(changes.map(\.index))
            for case let item as ExperimentalTranscriptItem in collection.visibleItems() {
                if let path = collection.indexPath(for: item), changedIndices.contains(path.item) {
                    configure(item, index: path.item)
                }
            }
            if let first = changes.first?.index {
                let context = ExperimentalTranscriptContext()
                context.invalidateItems(at: layout.downstreamPaths(from: first))
                layout.invalidateLayout(with: context)
            }
            return true
        }
        let old = items, oldIDs = items.map(\.id), newIDs = values.map(\.id)
        let oldSet = Set(oldIDs), newSet = Set(newIDs)
        guard oldSet.count == old.count, newSet.count == values.count else { return false }
        let reordered = oldIDs.filter { newSet.contains($0) } != newIDs.filter { oldSet.contains($0) }
        // Rare reorder resets native views rather than silently retaining the wrong model.
        let replacing = !loaded || self.sessionID != sessionID || reordered
        let removed = oldSet.subtracting(newSet), inserted = newSet.subtracting(oldSet)
        let oldIndices = Dictionary(uniqueKeysWithValues: oldIDs.enumerated().map { ($0.element, $0.offset) })
        let newIndices = Dictionary(uniqueKeysWithValues: newIDs.enumerated().map { ($0.element, $0.offset) })
        var changed = Set<String>()
        var nextRevisions = replacing ? [:] : revisions.filter { newSet.contains($0.key) }
        for value in values {
            guard !replacing, let index = oldIndices[value.id] else { nextRevisions[value.id] = 0; continue }
            let needsUpdate: Bool
            if case .message(let a) = old[index], case .message(let b) = value {
                needsUpdate = a != b || environmentChanged
            } else { needsUpdate = true }
            if needsUpdate { changed.insert(value.id); nextRevisions[value.id, default: 0] &+= 1 }
        }
        let realized = collection.visibleItems().compactMap { $0 as? ExperimentalTranscriptItem }.filter { changed.contains($0.rowID) }
        func publish() {
            setEnvironment(environment)
            self.enabled = enabled
            self.answer = answer
            self.sessionID = sessionID
            self.items = values
            self.revisions = nextRevisions
            self.loaded = true
            self.layout.publishModel(newIDs, revisions: nextRevisions, reset: replacing)
        }
        func updateRetainedRoots() {
            for item in realized { if let index = newIndices[item.rowID] { configure(item, index: index) } }
        }
        if replacing { publish(); collection.reloadData(); return true }
        if !removed.isEmpty || !inserted.isEmpty {
            let deletions = Set(oldIDs.enumerated().filter { removed.contains($0.element) }.map { IndexPath(item: $0.offset, section: 0) })
            let insertions = Set(newIDs.enumerated().filter { inserted.contains($0.element) }.map { IndexPath(item: $0.offset, section: 0) })
            collection.performBatchUpdates({
                publish()
                if !deletions.isEmpty { self.collection.deleteItems(at: deletions) }
                if !insertions.isEmpty { self.collection.insertItems(at: insertions) }
                updateRetainedRoots()
            }, completionHandler: nil)
        } else { publish(); updateRetainedRoots() }
        if let first = changed.compactMap({ newIndices[$0] }).min() {
            let context = ExperimentalTranscriptContext()
            context.invalidateItems(at: layout.downstreamPaths(from: first))
            layout.invalidateLayout(with: context)
        }
        return true
    }
    private func body(_ value: ExperimentalTranscriptRow) -> AnyView {
        switch value {
        case .message(let message): AnyView(SessionMessageView(message: message))
        case .empty: AnyView(ContentUnavailableView("No messages yet", systemImage: "bubble.left", description: Text("Send a message below.")).frame(maxWidth: .infinity))
		case .spinner(let label): AnyView(LabeledContent(label) {
			ProgressView().controlSize(.small)
		})
        case .interaction(let request): AnyView(DaemonInteractionView(request: request, enabled: enabled) { [weak self] in self?.answer?(request, $0) })
        }
    }
    private func configure(_ item: ExperimentalTranscriptItem, index: Int) {
        let value = items[index]
        item.invalidate = { [weak self, weak item] in
            guard let self, !self.stopped, let item, let path = self.collection.indexPath(for: item), !item.hasUnchangedCurrentSize() else { return }
            let context = ExperimentalTranscriptContext()
            context.invalidateItems(at: [path])
            self.layout.invalidateLayout(with: context)
        }
        item.measured = { [weak self] in self?.layout.noteMeasurement($0) }
        item.configure(id: value.id, revision: revisions[value.id, default: 0], content: body(value), environment: environment, width: layout.columnWidth)
    }
    func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int { items.count }
    func collectionView(_ collectionView: NSCollectionView, itemForRepresentedObjectAt indexPath: IndexPath) -> NSCollectionViewItem {
        let item = collectionView.makeItem(withIdentifier: NSUserInterfaceItemIdentifier("row"), for: indexPath) as! ExperimentalTranscriptItem
        configure(item, index: indexPath.item)
        return item
    }
}
#endif
