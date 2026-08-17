import SwiftUI
import Combine

/// Shared session presentation; the window owns its draft and supplies session actions.
struct SessionView: View {
    let hasSession: Bool
    let connected: Bool
    var isPresented = true
    let messages: SessionMessage.Transcript
    var localMessages: [SessionMessage] = []
    var queuedMessages: [SessionMessage] = []
    var retrySubmission: (String) -> Void = { _ in }
    let isStreaming: Bool
    let interactions: [LinkInteraction]
    let canMutate: Bool
    let ownsControl: Bool
    @Binding var draft: String
    @State private var composerHeight: CGFloat = 0
    @State private var foundRowID: String?
    @State private var foundRange: NSRange?
    @State private var foundNavigation: TranscriptFindNavigation?
    @State private var draftImages: [String: [ComposerImage]] = [:]
    let enqueue: (String, [ComposerImage], Bool) -> Bool
    var imageInputSupported = true
    var sendUnavailableReason: String? = nil
    let abort: () async -> Void
    let answer: (LinkInteraction, LinkJSON) -> Void
    var sessionID: String? = nil
    var workingMessage: String? = nil
    var localCompletionDirectory: String? = nil
    var commands: [LinkCommand] = []
    var commandCompletions: (String, String) async -> [LinkCompletionItem]? = { _, _ in nil }
    // Supplied only by the presented root. Child panels must not borrow its events.
    var nativeMarkdownEvents: AnyPublisher<LinkIncomingFrame, Never>? = nil
    var contextUsage: LinkContextUsage? = nil
    var statusFooterData: LinkStatusFooterData? = nil
    var compacting = false

    #if os(macOS)
    @AppStorage("experimentalNativeTranscript") private var experimentalNativeTranscript = false
    #endif

    var body: some View {
        VStack(spacing: 0) {
            if hasSession {
                let key = sessionID ?? ""
                let images = Binding<[ComposerImage]>(
                    get: { draftImages[key] ?? [] },
                    set: { draftImages[key] = $0 }
                )
                let composer = SessionComposerView(draft: $draft, images: images, isStreaming: isStreaming,
                                                   canMutate: canMutate, ownsControl: ownsControl, isPresented: isPresented,
                                                   enqueue: enqueue, imageInputSupported: imageInputSupported,
                                                   sendUnavailableReason: sendUnavailableReason, abort: abort,
                                                   sessionID: sessionID,
                                                   contextUsage: connected ? contextUsage : nil,
                                                   workingMessage: workingMessage,
                                                   statusFooterData: connected ? statusFooterData : nil,
                                                   compacting: connected && compacting,
                                                   localCompletionDirectory: localCompletionDirectory,
                                                   commands: commands,
                                                   commandCompletions: commandCompletions)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                        if composerHeight != height { composerHeight = height }
                    }
                let composed = selectedTranscript.safeAreaInset(edge: .bottom, spacing: 0) { composer }
                #if os(macOS)
                if experimentalNativeTranscript {
                    composed.ignoresSafeArea(.container, edges: .bottom)
                } else { composed }
                #else
                composed
                #endif
            } else {
                ContentUnavailableView(
                    connected ? "Select a session" : "Connect to Pi",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text(connected ? "Choose a session from the sidebar." : "Start Pi to connect.")
                )
            }
        }
        .onChange(of: isPresented) { _, presented in
            if !presented { foundNavigation?.cancel() }
        }
    }

    @ViewBuilder private var selectedTranscript: some View {
        #if os(macOS)
        if experimentalNativeTranscript {
            ExperimentalNativeTranscript(messages: presentedMessages, isStreaming: isStreaming,
                                         workingMessage: workingMessage,
                                         interactions: interactions.filter { $0.kind != "confirm" },
                                         enabled: canMutate, isPresented: isPresented, sessionID: sessionID, answer: answer,
                                         bottomInset: composerHeight,
                                         nativeMarkdownEvents: nativeMarkdownEvents,
                                         retrySubmission: retrySubmission)
                .ignoresSafeArea(.container, edges: [.top, .bottom])
        } else {
            transcript
        }
        #else
        transcript
        #endif
    }

    private var presentedMessages: SessionMessage.Transcript {
        UserMessagePresentation.compose(messages, queued: queuedMessages, local: localMessages)
    }

    private var transcript: some View {
        let values = presentedMessages
        let rows = TranscriptSpacing.Rows(messages: values)
        let pendingStart = rows.endIndex - values.pending.count + values.pendingPromptCount
        let requests = interactions.filter { $0.kind != "confirm" }
        let hasTranscriptContent = !rows.isEmpty || values.isEmpty
        return ScrollViewReader { proxy in
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                // Initial prompts stay with committed/live messages; queued
                // steering/follow-ups follow them. Status lives below the composer.
                ForEach(rows.prefix(upTo: pendingStart)) { row in
                    transcriptRow(row)
                }
                if presentedMessages.isEmpty {
                    ContentUnavailableView("No messages yet", systemImage: "bubble.left", description: Text("Send a message below."))
                        .frame(maxWidth: .infinity)
                }
                ForEach(rows.suffix(from: pendingStart)) { row in
                    transcriptRow(row)
                }
                // Non-permission input/select requests retain their existing working controls.
                ForEach(requests) { request in
                    DaemonInteractionView(request: request, enabled: canMutate) { value in
                        answer(request, value)
                    }
                    .padding(.top, hasTranscriptContent || request.id != requests.first?.id ? TranscriptSpacing.row : 0)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(28)
            #if os(macOS)
            .background(TranscriptFindAttachment(transcript: values, target: sessionID, isPresented: isPresented, clear: { foundRowID = nil; foundRange = nil }) { id, range in
                foundRowID = id
                foundRange = range
                foundNavigation = TranscriptFindNavigation()
                proxy.scrollTo(id, anchor: .top)
            }.frame(width: 0, height: 0))
            #endif
        }
        .defaultScrollAnchor(.bottom)
        }
        .onChange(of: sessionID) { foundRowID = nil }
    }

    private func transcriptRow(_ row: TranscriptSpacing.Rows.Element, spacingBefore: CGFloat? = nil) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SessionMessageView(message: row.message)
                .environment(\.retrySubmission, retrySubmission)
                .environment(\.transcriptFindScope, foundRowID == row.id ? foundRange.map { .init(row: row.id, part: 0, range: $0, navigation: foundNavigation) } : nil)
        }
        .padding(.top, spacingBefore ?? row.spacingBefore)
    }
}

#Preview("Session") {
    @Previewable @State var draft = ""
    SessionView(
        hasSession: true, connected: true, messages: .init(PreviewFixtures.allToolMessages),
        isStreaming: false, interactions: [], canMutate: true, ownsControl: true,
        draft: $draft, enqueue: { _, _, _ in true }, abort: {}, answer: { _, _ in }
    )
}

#Preview("No selected session") {
    SessionView(
        hasSession: false, connected: true, messages: [], isStreaming: false,
        interactions: [], canMutate: false, ownsControl: false,
        draft: .constant(""), enqueue: { _, _, _ in false }, abort: {}, answer: { _, _ in }
    )
}

#Preview("Empty session") {
    @Previewable @State var draft = ""
    SessionView(
        hasSession: true, connected: true, messages: [], isStreaming: false,
        interactions: [], canMutate: true, ownsControl: true,
        draft: $draft, enqueue: { _, _, _ in true }, abort: {}, answer: { _, _ in }
    )
}

#Preview("Streaming and pending tool") {
    @Previewable @State var draft = ""
    SessionView(
        hasSession: true, connected: true, messages: .init(PreviewFixtures.streamingMessages),
        isStreaming: true, interactions: [], canMutate: true, ownsControl: true,
        draft: $draft, enqueue: { _, _, _ in true }, abort: {}, answer: { _, _ in }
    )
}

#Preview("Pending input requests") {
    @Previewable @State var draft = ""
    SessionView(
        hasSession: true, connected: true, messages: .init(PreviewFixtures.allToolMessages),
        isStreaming: false, interactions: PreviewFixtures.inputRequests, canMutate: true, ownsControl: true,
        draft: $draft, enqueue: { _, _, _ in true }, abort: {}, answer: { _, _ in }
    )
}
