import SwiftUI

/// Shared session presentation; the window owns its draft and supplies session actions.
struct SessionView: View {
    let hasSession: Bool
    let connected: Bool
    let messages: SessionMessage.Transcript
    let isStreaming: Bool
    let interactions: [LinkInteraction]
    let canMutate: Bool
    let ownsControl: Bool
    @Binding var draft: String
    @State private var composerHeight: CGFloat = 0
    let submit: (String) async -> Bool
    let abort: () async -> Void
    let answer: (LinkInteraction, LinkJSON) -> Void
    var sessionID: String? = nil
    var workingMessage: String? = nil
    var localCompletionDirectory: String? = nil
    var commands: [LinkCommand] = []
    var commandCompletions: (String, String) async -> [LinkCompletionItem]? = { _, _ in nil }

    #if os(macOS)
    @AppStorage("experimentalNativeTranscript") private var experimentalNativeTranscript = false
    #endif

    var body: some View {
        VStack(spacing: 0) {
            if hasSession {
                // The inset needs composer inputs, not a closure capturing this entire
                // SessionView (including the full changing transcript array).
                let composer = SessionComposerView(draft: $draft, isStreaming: isStreaming,
                                                   canMutate: canMutate, ownsControl: ownsControl,
                                                   submit: submit, abort: abort,
                                                   sessionID: sessionID,
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
                } else {
                    composed
                }
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
    }

    @ViewBuilder private var selectedTranscript: some View {
        #if os(macOS)
        if experimentalNativeTranscript {
            ExperimentalNativeTranscript(messages: messages, isStreaming: isStreaming,
                                         workingMessage: workingMessage,
                                         interactions: interactions.filter { $0.kind != "confirm" },
                                         enabled: canMutate, sessionID: sessionID, answer: answer,
                                         bottomInset: composerHeight)
                .ignoresSafeArea(.container, edges: [.top, .bottom])
        } else {
            transcript
        }
        #else
        transcript
        #endif
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                // One explicit stack per element preserves lazy row realization.
                ForEach(messages) { message in
                    VStack(alignment: .leading, spacing: 0) {
                        SessionMessageView(message: message)
                    }
                }
                if messages.isEmpty {
                    ContentUnavailableView("No messages yet", systemImage: "bubble.left", description: Text("Send a message below."))
                        .frame(maxWidth: .infinity)
                }
                if isStreaming { ProgressView(workingMessage ?? "Working…").controlSize(.small) }
                // Non-permission input/select requests retain their existing working controls.
                ForEach(interactions.filter { $0.kind != "confirm" }) { request in
                    DaemonInteractionView(request: request, enabled: canMutate) { value in
                        answer(request, value)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(28)
        }
        .defaultScrollAnchor(.bottom)

    }

}

#Preview("Session") {
    @Previewable @State var draft = ""
    SessionView(
        hasSession: true, connected: true, messages: .init(PreviewFixtures.allToolMessages),
        isStreaming: false, interactions: [], canMutate: true, ownsControl: true,
        draft: $draft, submit: { _ in true }, abort: {}, answer: { _, _ in }
    )
}

#Preview("No selected session") {
    SessionView(
        hasSession: false, connected: true, messages: [], isStreaming: false,
        interactions: [], canMutate: false, ownsControl: false,
        draft: .constant(""), submit: { _ in false }, abort: {}, answer: { _, _ in }
    )
}

#Preview("Empty session") {
    @Previewable @State var draft = ""
    SessionView(
        hasSession: true, connected: true, messages: [], isStreaming: false,
        interactions: [], canMutate: true, ownsControl: true,
        draft: $draft, submit: { _ in true }, abort: {}, answer: { _, _ in }
    )
}

#Preview("Streaming and pending tool") {
    @Previewable @State var draft = ""
    SessionView(
        hasSession: true, connected: true, messages: .init(PreviewFixtures.streamingMessages),
        isStreaming: true, interactions: [], canMutate: true, ownsControl: true,
        draft: $draft, submit: { _ in true }, abort: {}, answer: { _, _ in }
    )
}

#Preview("Pending input requests") {
    @Previewable @State var draft = ""
    SessionView(
        hasSession: true, connected: true, messages: .init(PreviewFixtures.allToolMessages),
        isStreaming: false, interactions: PreviewFixtures.inputRequests, canMutate: true, ownsControl: true,
        draft: $draft, submit: { _ in true }, abort: {}, answer: { _, _ in }
    )
}
