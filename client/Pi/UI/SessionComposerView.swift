import SwiftUI
#if os(macOS)
import AppKit
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

struct SessionComposerView: View {
    @Binding var draft: String
    let isStreaming: Bool
    let canMutate: Bool
    let ownsControl: Bool
    let submit: (String) async -> Bool
    let abort: () async -> Void
    var sessionID: String? = nil
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

    var body: some View {
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
                        guard canMutate, !isStreaming else { return }
                        if !shownCompletions.isEmpty {
                            accept(shownCompletions[min(selectedCompletion, shownCompletions.count - 1)])
                        } else if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            send()
                        }
                    }
                    .onKeyPress(keys: [.tab, .upArrow, .downArrow, .escape], phases: [.down, .repeat]) { press in
                        guard canMutate, !isStreaming else { return .ignored }
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
                if isStreaming {
                    Task { await abort() }
                } else {
                    send()
                }
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
            .disabled(!canMutate || (!isStreaming && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            .help(!ownsControl ? "This session is read-only" : isStreaming ? "Stop response" : "Send message")
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
        .onChange(of: draft) { _, _ in
            if suppressNextAutomaticCompletion {
                suppressNextAutomaticCompletion = false
                dismissCompletions()
            } else { requestCompletions(debounced: true) }
        }
        .onChange(of: commands) { _, _ in dismissCompletions() }
        .onChange(of: sessionID) { _, _ in dismissCompletions() }
        .onChange(of: localCompletionDirectory) { _, _ in dismissCompletions() }
        .onChange(of: canMutate) { _, allowed in if !allowed { dismissCompletions() } }
        .onChange(of: isStreaming) { _, streaming in if streaming { dismissCompletions() } }
        .onDisappear { completionTask?.cancel() }
    }

    private func dismissCompletions() {
        completionTask?.cancel(); completionTask = nil
        fetchedCompletions = []; selectedCompletion = 0; completionScrollOffset = nil
        fileReplacementRange = nil
    }

    private func accept(_ completion: ComposerCompletion) {
        suppressNextAutomaticCompletion = true
        if let range = fileReplacementRange, NSMaxRange(range) <= (draft as NSString).length {
            draft = (draft as NSString).replacingCharacters(in: range, with: completion.value)
            let caret = range.location + (completion.value as NSString).length
            dismissCompletions()
            DispatchQueue.main.async {
                #if os(macOS)
                if let editor = NSApp.keyWindow?.firstResponder as? NSTextView, editor.string == draft {
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
        let length = (draft as NSString).length
        let editor = NSApp.keyWindow?.firstResponder as? NSTextView
        let caret = messageFocused && editor?.string == draft
            ? min(length, editor!.selectedRange().location) : length
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
        guard canMutate, !isStreaming else { return }
        if let cwd = localCompletionDirectory, let token = fileToken(explicit: !debounced) {
            let original = draft
            fileReplacementRange = token.range
            completionTask = Task {
                if debounced {
                    try? await Task.sleep(for: .milliseconds(120))
                    guard !Task.isCancelled else { return }
                }
                let matches = await LocalFileCompletions.search(cwd: cwd, query: token.query)
                guard !Task.isCancelled, draft == original else { return }
                fetchedCompletions = matches.map { match in
                    ComposerCompletion(value: token.marker + match.path + (match.directory ? "/" : " "),
                                       detail: match.directory ? "Folder" : "File")
                }
                selectedCompletion = 0; completionScrollOffset = nil
            }
            return
        }
        guard draft.hasPrefix("/"), !draft.contains("\n") else { return }
        if let separator = draft.firstIndex(of: " ") {
            let name = String(draft[draft.index(after: draft.startIndex)..<separator])
            guard commands.contains(where: { $0.invokedAs == name && $0.argumentCompletions == true }) else { return }
            let prefix = String(draft[draft.index(after: separator)...])
            let original = draft
            completionTask = Task {
                if debounced {
                    try? await Task.sleep(for: .milliseconds(120))
                    guard !Task.isCancelled else { return }
                }
                let items = await commandCompletions(name, prefix) ?? []
                guard !Task.isCancelled, draft == original else { return }
                fetchedCompletions = items.map {
                    ComposerCompletion(value: "/\(name) \($0.value)", detail: $0.description ?? $0.label)
                }
                selectedCompletion = 0; completionScrollOffset = nil
            }
        } else {
            let typed = String(draft.dropFirst())
            fetchedCompletions = commands.filter { typed.isEmpty || $0.invokedAs.range(of: typed, options: [.anchored, .caseInsensitive]) != nil }
                .map { ComposerCompletion(value: "/\($0.invokedAs) ", detail: $0.description ?? "Command") }
            selectedCompletion = 0; completionScrollOffset = nil
        }
    }

    private func send() {
        let text = draft
        Task {
            if await submit(text), draft == text { draft = "" }
        }
    }
}

#Preview("Composer") {
    @Previewable @State var draft = "Can you explain this change?"
    SessionComposerView(draft: $draft, isStreaming: false, canMutate: true, ownsControl: true,
                             submit: { _ in true }, abort: {})
}

#Preview("Autocomplete") {
    @Previewable @State var draft = ""
    SessionComposerView(draft: $draft, isStreaming: false, canMutate: true, ownsControl: true,
                        submit: { _ in true }, abort: {},
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

#Preview("Streaming composer") {
    @Previewable @State var draft = ""
    SessionComposerView(draft: $draft, isStreaming: true, canMutate: true, ownsControl: true,
                             submit: { _ in true }, abort: {})
}

#Preview("Watching composer") {
    @Previewable @State var draft = "An unsent draft"
    SessionComposerView(draft: $draft, isStreaming: false, canMutate: false, ownsControl: false,
                             submit: { _ in false }, abort: {})
}
