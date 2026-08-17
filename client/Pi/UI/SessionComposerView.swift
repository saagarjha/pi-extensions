import SwiftUI
#if os(macOS)
import AppKit
import UniformTypeIdentifiers
#endif

struct ComposerCompletion: Identifiable {
    let value: String
    let detail: String
    var id: String { value }
}

private struct ComposerCompletionChip: View {
    let completion: ComposerCompletion
    let choose: (ComposerCompletion) -> Void
    var contentOpacity: Double = 1
    var selected = false
    var tintOpacity: Double = 1

    var body: some View {
        Button { choose(completion) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(completion.value)
                    .font(.system(.body, design: .monospaced))
                Spacer(minLength: 8)
                Text(completion.detail)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 14)
            .frame(height: 40)
            .frame(maxWidth: .infinity)
            .opacity(contentOpacity)
            .contentShape(RoundedRectangle(cornerRadius: 20))
        }
        .buttonStyle(.plain)
        .glassEffect(selected ? .regular.tint(.accentColor.opacity(0.25 * tintOpacity)) : .regular,
                     in: RoundedRectangle(cornerRadius: 20))
        .accessibilityLabel("\(completion.value), \(completion.detail)")
    }
}

private struct ComposerCompletionPanel: View {
    let completions: [ComposerCompletion]
    let choose: (ComposerCompletion) -> Void
    let emergingIndex: Int?
    let selectedID: String?
    @Binding var scrollOffset: CGFloat?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func height(for count: Int) -> CGFloat { min(240, max(0, CGFloat(count) * 48 - 4)) }

    var body: some View {
        let reduceMotion = reduceMotion
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                ForEach(Array(completions.enumerated()), id: \.element.id) { index, completion in
                    if index == emergingIndex {
                        Color.clear.frame(height: 40).accessibilityHidden(true)
                    } else {
                        ComposerCompletionChip(completion: completion, choose: choose,
                                               selected: completion.id == selectedID)
                            .compositingGroup()
                            .scrollTransition(.interactive, axis: .vertical) { content, phase in
                                let topExit = max(0, -phase.value)
                                let scale: CGFloat = reduceMotion ? 1 : max(0.52, 1 - topExit * 0.48)
                                let shift: CGFloat = reduceMotion ? 0 : topExit * 38
                                return content.scaleEffect(scale).offset(y: shift)
                            }
                    }
                }
            }
                .padding(.top, 4)
            }
            .scrollIndicators(.hidden)
            .defaultScrollAnchor(.bottom)
            .frame(height: Self.height(for: completions.count))
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, offset in
                scrollOffset = offset
            }
            .compositingGroup()
            .clipped()
            .onChange(of: selectedID) { _, selected in
                guard let selected, let index = completions.firstIndex(where: { $0.id == selected }) else { return }
                let height = Self.height(for: completions.count)
                let position = scrollOffset ?? max(0, CGFloat(completions.count) * 48 - 4 - height)
                let top = CGFloat(index) * 48 + 4
                if top < position { proxy.scrollTo(selected, anchor: .top) }
                else if top + 40 > position + height { proxy.scrollTo(selected, anchor: .bottom) }
            }
        }
    }
}

/// Event bookkeeping only: changing this reference never invalidates SwiftUI.
@MainActor private final class ComposerPendingSends {
    struct Input: Hashable {
        let sessionID: String?
        let text: String
        let imageIDs: [UUID]
    }
    var inputs: Set<Input> = []
    var isActive = false
    var sessionID: String?
}

struct SessionComposerView: View {
    @Binding var draft: String
    @Binding var images: [ComposerImage]
    let isStreaming: Bool
    let canMutate: Bool
    let ownsControl: Bool
    var isPresented = true
    let enqueue: (String, [ComposerImage], Bool) -> Bool
    var imageInputSupported = true
    var sendUnavailableReason: String? = nil
    let abort: () async -> Void
    var sessionID: String? = nil
    var contextUsage: LinkContextUsage? = nil
    var workingMessage: String? = nil
    var statusFooterData: LinkStatusFooterData? = nil
    var compacting = false
    var localCompletionDirectory: String? = nil
    var commands: [LinkCommand] = []
    var commandCompletions: (String, String) async -> [LinkCompletionItem]? = { _, _ in nil }
    @FocusState private var messageFocused: Bool
    @State private var fetchedCompletions: [ComposerCompletion] = []
    @State private var selectedCompletion = 0
    @State private var completionTask: Task<Void, Never>?
    @State private var suppressNextAutomaticCompletion = false
    @State private var completionScrollOffset: CGFloat?
    @State private var fileReplacementRange: NSRange?
    @State private var completionSelection: NSRange?
    @State private var completionDraft: String?
    @State private var completionRequestID: UUID?
    @State private var imageError: String?
    @State private var pendingSends = ComposerPendingSends()
    #if os(macOS)
    @State private var imagePasteMonitor: Any?
    @State private var composerWindow: NSWindow?
    #endif

    private var imageCapabilityError: String? {
        !imageInputSupported && !images.isEmpty ? "Selected model does not accept images." : nil
    }
    private var hasInput: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty
    }

    private var shownCompletions: [ComposerCompletion] { fetchedCompletions }

    private var displayedCompletions: [ComposerCompletion] { Array(shownCompletions.reversed()) }

    private var distanceFromBottom: CGFloat {
        guard let completionScrollOffset else { return 0 }
        let contentHeight = max(0, CGFloat(shownCompletions.count) * 48 - 4)
        let initialOffset = max(0, contentHeight - ComposerCompletionPanel.height(for: shownCompletions.count))
        return max(0, initialOffset - completionScrollOffset)
    }

    private var emergingIndex: Int? {
        guard distanceFromBottom > 0.5 else { return nil }
        let index = shownCompletions.count - 1 - Int(distanceFromBottom / 48)
        return displayedCompletions.indices.contains(index) ? index : nil
    }

    private var composerFooter: some View {
        HStack(spacing: 8) {
            if isStreaming || compacting {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini)
                        .scaleEffect(0.6).frame(width: 8, height: 8)
                    Text(workingMessage ?? (compacting ? "Compacting" : "Working…"))
                        .lineLimit(1)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .modifier(ComposerStatusMaterial())
            }
            Spacer(minLength: 8)
            ComposerContextCaption(usage: contextUsage, statusFooterData: statusFooterData).fixedSize()
        }
        // Align each label with the message field's bottom curve tangents.
        .padding(.leading, 40)
        .padding(.trailing, 92)
        // 2pt vertical gap below the composer, within its existing 20pt padding.
        .padding(.top, 2)
        .frame(height: 20, alignment: .top)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let warning = imageError ?? imageCapabilityError ?? sendUnavailableReason {
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
            if !images.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(images) { image in
                            Image(decorative: image.thumbnail, scale: 1)
                                .resizable().scaledToFill()
                                .frame(width: 68, height: 68).clipShape(RoundedRectangle(cornerRadius: 8))
                                .overlay(alignment: .topTrailing) {
                                    Button { images.removeAll { $0.id == image.id } } label: {
                                        Image(systemName: "xmark.circle.fill")
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Remove image")
                                }
                                .accessibilityLabel("Attached image")
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .frame(height: 72)
            }
            HStack(alignment: .bottom, spacing: 12) {
            GlassEffectContainer(spacing: 6) {
                TextField("Message…", text: $draft, axis: .vertical)
                    .focused($messageFocused)
                    .font(.system(size: 14))
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20))
                    .accessibilityLabel("Message")
                    .onSubmit {
                        guard canMutate, sendUnavailableReason == nil, imageCapabilityError == nil else { return }
                        if !shownCompletions.isEmpty {
                            accept(shownCompletions[min(selectedCompletion, shownCompletions.count - 1)])
                        } else if hasInput { send() }
                    }
                    #if os(macOS)
                    .onPasteCommand(of: [.image, .fileURL]) { providers in importImages(providers) }
                    #endif
                    .onKeyPress(.return, phases: .down) { press in
                        guard press.modifiers.contains(.shift), canMutate,
                              sendUnavailableReason == nil else { return .ignored }
                        send(followUp: true)
                        return .handled
                    }
                    .onKeyPress(keys: [.tab, .upArrow, .downArrow, .escape], phases: [.down, .repeat]) { press in
                        guard canMutate else { return .ignored }
                        if press.phase == .repeat, press.key != .upArrow, press.key != .downArrow {
                            return .handled
                        }
                        switch press.key {
                        case .tab:
                            if shownCompletions.isEmpty { requestCompletions() }
                            else { accept(shownCompletions[min(selectedCompletion, shownCompletions.count - 1)]) }
                            return .handled
                        case .upArrow where !shownCompletions.isEmpty:
                            selectedCompletion = min(shownCompletions.count - 1, selectedCompletion + 1)
                            return .handled
                        case .downArrow where !shownCompletions.isEmpty:
                            selectedCompletion = max(0, selectedCompletion - 1)
                            return .handled
                        case .escape where !shownCompletions.isEmpty:
                            dismissCompletions()
                            return .handled
                        default: return .ignored
                        }
                    }
                    .overlay(alignment: .topLeading) {
                        if let index = emergingIndex {
                            let progress = distanceFromBottom.truncatingRemainder(dividingBy: 48)
                            let visibility = 1 - min(1, Double(progress) / 16)
                            ComposerCompletionChip(
                                completion: displayedCompletions[index], choose: accept,
                                contentOpacity: visibility,
                                selected: displayedCompletions[index].id == shownCompletions[min(selectedCompletion, shownCompletions.count - 1)].id,
                                tintOpacity: visibility
                            )
                            .frame(maxWidth: .infinity)
                            .offset(y: -48 + progress)
                        }
                    }
            }
            .overlay(alignment: .topLeading) {
                if !shownCompletions.isEmpty {
                    ComposerCompletionPanel(completions: displayedCompletions, choose: accept,
                                            emergingIndex: emergingIndex,
                                            selectedID: shownCompletions[min(selectedCompletion, shownCompletions.count - 1)].id,
                                            scrollOffset: $completionScrollOffset)
                        .frame(maxWidth: .infinity)
                        .offset(y: -(ComposerCompletionPanel.height(for: shownCompletions.count) + 8))
                }
            }
            .zIndex(1)

            Button {
                if isStreaming { Task { await abort() } }
                else { send() }
            } label: {
                Image(systemName: isStreaming ? "stop.fill" : ownsControl ? "arrow.up" : "eye")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 18, height: 18)
            }
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.circle)
            .controlSize(.extraLarge)
            .tint(isStreaming && ownsControl ? .red : .accentColor)
            .frame(width: 40, height: 40)
            .accessibilityLabel(isStreaming ? "Stop" : "Send")
            .disabled(!canMutate || (!isStreaming &&
                (sendUnavailableReason != nil || imageCapabilityError != nil || !hasInput)))
            .help(isStreaming ? "Stop response" : sendUnavailableReason ??
                (!ownsControl ? "This session is read-only" : "Send message"))
            }
        }
        .frame(maxWidth: .infinity)
        #if os(macOS)
        .background(ComposerWindowReader { composerWindow = $0 }.frame(width: 0, height: 0))
        .onReceive(NotificationCenter.default.publisher(for: NSTextView.didChangeSelectionNotification)) { notification in
            guard let editor = notification.object as? NSTextView,
                  editor === composerWindow?.firstResponder,
                  editor.string == draft, let selection = completionSelection,
                  editor.selectedRange() != selection else { return }
            dismissCompletions()
        }
        .onDrop(of: [.image, .fileURL], isTargeted: nil) { providers in
            importImages(providers)
            return true
        }
        #endif
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
        .background(alignment: .bottom) {
            composerFooter
        }
        .onChange(of: draft) { _, _ in
            if suppressNextAutomaticCompletion {
                suppressNextAutomaticCompletion = false
                dismissCompletions()
            } else { requestCompletions(debounced: true) }
        }
        .onChange(of: commands) { _, _ in dismissCompletions() }
        .onChange(of: sessionID) { _, id in
            pendingSends.sessionID = id
            dismissCompletions()
        }
        .onChange(of: localCompletionDirectory) { _, _ in dismissCompletions() }
        .onChange(of: canMutate) { _, allowed in if !allowed { dismissCompletions() } }
        .onChange(of: isPresented) { _, presented in
            pendingSends.isActive = presented
            if !presented {
                dismissCompletions()
                #if os(macOS)
                if let window = composerWindow, let editor = window.firstResponder as? NSTextView,
                   let field = editor.delegate as? NSTextField, field.currentEditor() === editor,
                   field.placeholderString == "Message…" {
                    window.makeFirstResponder(nil)
                }
                #endif
                messageFocused = false
            }
        }
        .onAppear {
            pendingSends.isActive = isPresented
            pendingSends.sessionID = sessionID
            #if os(macOS)
            guard imagePasteMonitor == nil else { return }
            imagePasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                // NSApplication dispatches the Edit > Paste key equivalent to
                // SwiftUI's AppKit field editor before .onPasteCommand. Match the
                // owning window AND its composer editor; unrelated text fields
                // (including other windows) retain normal native text paste.
                guard pendingSends.isActive, event.modifierFlags.contains(.command),
                      event.charactersIgnoringModifiers?.lowercased() == "v",
                      let window = composerWindow, NSApp.keyWindow === window,
                      let editor = window.firstResponder as? NSTextView,
                      let field = editor.delegate as? NSTextField,
                      field.currentEditor() === editor, field.placeholderString == "Message…",
                      ComposerImageInput.hasPastedImages() else { return event }
                do {
                    if let incoming = try ComposerImageInput.pastedImages() {
                        images = try ComposerImageInput.append(incoming, to: images)
                        imageError = nil
                        return nil
                    }
                } catch { imageError = error.localizedDescription; return nil }
                return event
            }
            #endif
        }
        .onDisappear {
            pendingSends.isActive = false
            completionTask?.cancel()
            #if os(macOS)
            if let imagePasteMonitor { NSEvent.removeMonitor(imagePasteMonitor) }
            imagePasteMonitor = nil
            #endif
        }
    }

    private func dismissCompletions() {
        completionTask?.cancel(); completionTask = nil
        fetchedCompletions = []; selectedCompletion = 0; completionScrollOffset = nil
        fileReplacementRange = nil
        completionSelection = nil; completionDraft = nil; completionRequestID = nil
    }

    private func completionCaret() -> NSRange {
        let length = (draft as NSString).length
        #if os(macOS)
        if messageFocused, let editor = composerWindow?.firstResponder as? NSTextView,
           editor.string == draft {
            let selection = editor.selectedRange()
            return NSRange(location: min(length, selection.location),
                           length: min(selection.length, length - min(length, selection.location)))
        }
        #endif
        return NSRange(location: length, length: 0)
    }

    private func accept(_ completion: ComposerCompletion) {
        guard completionDraft == draft, completionSelection == completionCaret() else {
            dismissCompletions(); return
        }
        suppressNextAutomaticCompletion = true
        if let range = fileReplacementRange, NSMaxRange(range) <= (draft as NSString).length {
            draft = (draft as NSString).replacingCharacters(in: range, with: completion.value)
            let caret = range.location + (completion.value as NSString).length
            dismissCompletions()
            let completedDraft = draft
            DispatchQueue.main.async {
                #if os(macOS)
                if self.draft == completedDraft,
                   let editor = self.composerWindow?.firstResponder as? NSTextView, editor.string == completedDraft {
                    editor.setSelectedRange(NSRange(location: caret, length: 0))
                }
                #endif
            }
        } else { draft = completion.value; dismissCompletions() }
        messageFocused = true
    }

    /// The native field editor supplies the insertion point; do not search some other token
    /// when the user has moved the caret into the middle of a multiline draft.
    private func fileToken(explicit: Bool) -> (query: String, marker: String, range: NSRange)? {
        #if os(macOS)
        let caret = completionCaret().location
        let before = (draft as NSString).substring(to: caret) as NSString
        let whitespace = before.rangeOfCharacter(from: .whitespacesAndNewlines, options: .backwards)
        let start = whitespace.location == NSNotFound ? 0 : NSMaxRange(whitespace)
        let token = before.substring(from: start)
        guard !token.isEmpty else { return nil }
        if token.hasPrefix("@") {
            return (String(token.dropFirst()), "@", NSRange(location: start, length: caret - start))
        }
        guard explicit, !token.hasPrefix("/" ) || !commands.contains(where: {
            $0.invokedAs.range(of: String(token.dropFirst()), options: [.anchored, .caseInsensitive]) != nil
        }) else { return nil }
        return (token, "", NSRange(location: start, length: caret - start))
        #else
        return nil
        #endif
    }

    private func requestCompletions(debounced: Bool = false) {
        dismissCompletions()
        guard canMutate else { return }
        let original = draft, selection = completionCaret(), requestID = UUID()
        let beforeCaret = (draft as NSString).substring(to: selection.location)
        completionDraft = original; completionSelection = selection; completionRequestID = requestID
        let commandName = beforeCaret.hasPrefix("/")
            ? beforeCaret.dropFirst().split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) : nil
        // Permissions names belong to the daemon even for a local attachment.
        // Swift selects the registered command, never parses its path grammar.
        let ownerCompletion = commands.contains {
            $0.name == "permissions" && $0.invokedAs == commandName && $0.argumentCompletions == true
        }
        if !ownerCompletion, let cwd = localCompletionDirectory, let token = fileToken(explicit: !debounced) {
            fileReplacementRange = token.range
            completionTask = Task {
                if debounced {
                    try? await Task.sleep(for: .milliseconds(120))
                    guard !Task.isCancelled else { return }
                }
                let matches = await LocalFileCompletions.search(cwd: cwd, query: token.query)
                guard !Task.isCancelled, draft == original, completionCaret() == selection,
                      completionRequestID == requestID else { return }
                fetchedCompletions = matches.map { match in
                    ComposerCompletion(value: token.marker + match.path + (match.directory ? "/" : " "),
                                       detail: match.directory ? "Folder" : "File")
                }
                selectedCompletion = 0; completionScrollOffset = nil
            }
            return
        }
        guard beforeCaret.hasPrefix("/"), !beforeCaret.contains("\n") else { return }
        if let separator = beforeCaret.firstIndex(of: " ") {
            let name = String(beforeCaret[beforeCaret.index(after: beforeCaret.startIndex)..<separator])
            guard commands.contains(where: { $0.invokedAs == name && $0.argumentCompletions == true }) else { return }
            let argumentStart = beforeCaret.index(after: separator)
            let prefix = String(beforeCaret[argumentStart...])
            let start = beforeCaret[..<argumentStart].utf16.count
            fileReplacementRange = NSRange(location: start, length: selection.location - start)
            completionTask = Task {
                if debounced {
                    try? await Task.sleep(for: .milliseconds(120))
                    guard !Task.isCancelled else { return }
                }
                let items = await commandCompletions(name, prefix) ?? []
                guard !Task.isCancelled, draft == original, completionCaret() == selection,
                      completionRequestID == requestID else { return }
                fetchedCompletions = items.map {
                    ComposerCompletion(value: $0.value, detail: $0.description ?? $0.label)
                }
                selectedCompletion = 0; completionScrollOffset = nil
            }
        } else {
            let typed = String(beforeCaret.dropFirst())
            fileReplacementRange = NSRange(location: 0, length: selection.location)
            fetchedCompletions = commands.filter { typed.isEmpty || $0.invokedAs.range(of: typed, options: [.anchored, .caseInsensitive]) != nil }
                .map { ComposerCompletion(value: "/\($0.invokedAs) ", detail: $0.description ?? "Command") }
            selectedCompletion = 0; completionScrollOffset = nil
        }
    }

    #if os(macOS)
    private func importImages(_ providers: [NSItemProvider]) {
        let pending = pendingSends, id = sessionID
        guard pending.isActive else { return }
        Task {
            do {
                let incoming = try await ComposerImageInput.dropped(providers)
                guard pending.isActive, pending.sessionID == id else { return }
                images = try ComposerImageInput.append(incoming, to: images)
                imageError = nil
            } catch {
                guard pending.isActive, pending.sessionID == id else { return }
                imageError = error.localizedDescription
            }
        }
    }
    #endif

    private func send(followUp: Bool = false) {
        let text = draft, attachments = images
        guard canMutate, sendUnavailableReason == nil, imageCapabilityError == nil, hasInput else { return }
        let input = ComposerPendingSends.Input(sessionID: sessionID, text: text,
                                               imageIDs: attachments.map(\.id))
        let pending = pendingSends
        guard pending.inputs.insert(input).inserted else { return }
        // Native TextField submission can run inside an AppKit/SwiftUI update.
        // Capture authored input now, but admit and publish only after it returns.
        DispatchQueue.main.async {
            defer { pending.inputs.remove(input) }
            guard pending.isActive, pending.sessionID == input.sessionID else { return }
            if !attachments.isEmpty && text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") {
                if pending.sessionID == input.sessionID, draft == text, images.map(\.id) == input.imageIDs {
                    imageError = "Slash commands do not receive image attachments. Remove the slash or the images."
                }
                return
            }
            guard enqueue(text, attachments, followUp) else { return }
            // Image IDs identify immutable bytes. Never erase a subsequently
            // edited draft or changed attachment snapshot in this queued turn.
            if pending.sessionID == input.sessionID, draft == text, images.map(\.id) == input.imageIDs {
                draft = ""
                images = []
                imageError = nil
            }
        }
    }
}

#Preview("Composer") {
    @Previewable @State var draft = "Can you explain this change?"
    SessionComposerView(draft: $draft, images: .constant([]), isStreaming: false, canMutate: true, ownsControl: true,
                             enqueue: { _, _, _ in true }, abort: {},
                             contextUsage: .init(tokens: 12600, contextWindow: 200000, percent: 6.3))
}

#Preview("Autocomplete") {
    @Previewable @State var draft = ""
    SessionComposerView(draft: $draft, images: .constant([]), isStreaming: false, canMutate: true, ownsControl: true,
                        enqueue: { _, _, _ in true }, abort: {},
                        commands: [
                            LinkCommand(name: "read", description: "Read a file", invocationName: nil, argumentCompletions: true),
                            LinkCommand(name: "model", description: "Choose a model", invocationName: nil, argumentCompletions: true),
                            LinkCommand(name: "help", description: "Show available commands", invocationName: nil, argumentCompletions: false),
                            LinkCommand(name: "sessions", description: "Browse sessions", invocationName: nil, argumentCompletions: false),
                            LinkCommand(name: "thinking", description: "Set thinking level", invocationName: nil, argumentCompletions: false),
                            LinkCommand(name: "compact", description: "Compact context", invocationName: nil, argumentCompletions: false),
                            LinkCommand(name: "branch", description: "Switch branch", invocationName: nil, argumentCompletions: false),
                            LinkCommand(name: "status", description: "Show session status", invocationName: nil, argumentCompletions: false)
                        ],
                        commandCompletions: { name, _ in
                            name == "read" ? [
                                LinkCompletionItem(value: "README.md", label: "README.md", description: "Project overview"),
                                LinkCompletionItem(value: "Sources/App.swift", label: "Sources/App.swift", description: "App source")
                            ] : nil
                        })
        .frame(width: 680, height: 350, alignment: .bottom)
        .task { draft = "/" } // Exercise the real text-change and completion path on preview launch.
}

#Preview("Footer") {
    SessionComposerView(draft: .constant(""), images: .constant([]), isStreaming: true,
                        canMutate: true, ownsControl: true, enqueue: { _, _, _ in false }, abort: {},
                        contextUsage: .init(tokens: 12600, contextWindow: 200000, percent: 6.3),
                        workingMessage: "Working…")
        .frame(width: 680, height: 100, alignment: .bottom)
}

#Preview("Streaming composer") {
    @Previewable @State var draft = ""
    SessionComposerView(draft: $draft, images: .constant([]), isStreaming: true, canMutate: true, ownsControl: true,
                             enqueue: { _, _, _ in true }, abort: {})
}

#Preview("Watching composer") {
    @Previewable @State var draft = "An unsent draft"
    SessionComposerView(draft: $draft, images: .constant([]), isStreaming: false, canMutate: false, ownsControl: false,
                             enqueue: { _, _, _ in false }, abort: {})
}

