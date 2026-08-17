import SwiftUI
#if os(macOS)

/// Only display metadata is retained when switching sessions, never another history copy.
nonisolated struct SessionSidebarSummary: Equatable {
    let name: String?
    let preview: String?
    let modified: Date?
    var messageCount: Int? = nil
    var title: String { LinkSession.displayTitle(name) }
    var isUnnamed: Bool { LinkSession.isUnnamed(name) }

    static func excerpt(_ text: String?) -> String? {
        guard let text else { return nil }
        let result = text.prefix(240).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return result.isEmpty ? nil : result
    }

    static func latestMessage<Messages: BidirectionalCollection>(in messages: Messages) -> String?
        where Messages.Element == SessionMessage {
        for message in messages.reversed() where message.isUser || message.isAssistant {
            var text = ""
            for part in message.parts {
                if case .text(let value) = part {
                    if !text.isEmpty { text += " " }
                    text += value.prefix(max(0, 240 - text.count))
                    if text.count >= 240 { break }
                }
            }
            if let text = excerpt(text) { return text }
        }
        return nil
    }

    static func activityDate(_ record: NativeRecord) -> Date? {
        guard record.type == "message", let message = record.message,
              message.role == "user" || message.role == "assistant" else { return nil }
        if let timestamp = message.timestamp, timestamp.isFinite, timestamp > 0 {
            return Date(timeIntervalSince1970: timestamp / 1000)
        }
        return LinkSession.date(from: record.timestamp)
    }
}

nonisolated enum SessionSidebarConnection {
    case controlling, viewing

    var title: String {
        switch self {
        case .controlling: "Controlling"
        case .viewing: "Watching"
        }
    }
}

private struct SessionSidebarRow: View {
    let summary: SessionSidebarSummary
    let connection: SessionSidebarConnection?
    let messageCount: Int?
    let working: Bool
    let unread: Bool
    let needsAttention: Bool
    let selected: Bool

    @Environment(\.controlActiveState) private var controlActiveState
    private var highlighted: Bool { selected && controlActiveState == .key }
    private var selectedText: Color { Color(nsColor: .alternateSelectedControlTextColor) }
    private var primaryText: Color { highlighted ? selectedText : .primary }
    private var secondaryText: Color { highlighted ? selectedText.opacity(0.8) : .secondary }
    private var connectionColor: Color {
        highlighted ? selectedText : connection == .controlling ? .green : .blue
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                if working {
                    ProgressView().controlSize(.mini)
                        .tint(highlighted ? selectedText : .accentColor)
                        .accessibilityLabel("Working")
                } else if unread {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 8))
                        .foregroundStyle(highlighted ? selectedText : .accentColor)
                        .accessibilityLabel("Unread messages")
                } else {
                    Color.clear.frame(height: 12).accessibilityHidden(true)
                }
            }
            .frame(width: 14)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(summary.title)
                        .font(summary.isUnnamed ? .headline.italic() : .headline)
                        .foregroundStyle(primaryText).lineLimit(1)
                    Spacer(minLength: 4)
                    if let modified = summary.modified {
                        Text(modified, format: .relative(presentation: .named, unitsStyle: .abbreviated))
                            .font(.caption2).foregroundStyle(secondaryText).fixedSize()
                            .help(modified.formatted(date: .abbreviated, time: .shortened))
                    }
                }
                HStack(alignment: .firstTextBaseline) {
                    if let messageCount {
                        Text(messageCount == 1 ? "1 message" : "\(messageCount.formatted()) messages")
                            .foregroundStyle(primaryText)
                    }
                    Spacer(minLength: 4)
                    if needsAttention {
                        Image(systemName: "exclamationmark.bubble.fill")
                            .foregroundStyle(highlighted ? selectedText : .orange)
                            .accessibilityLabel("Session needs a response")
                    }
                    if let connection {
                        Text(connection.title).foregroundStyle(connectionColor)
                    }
                }
                .font(.subheadline).lineLimit(1)
                if let detail = summary.preview {
                    Text(detail).font(.caption).foregroundStyle(secondaryText).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct SessionSidebarView: View {
    @EnvironmentObject private var store: DaemonSessionStore
    @Environment(\.openWindow) private var openWindow
    @State private var searchText = ""
    let newSession: () -> Void

    private var filteredSessions: [LinkSession] {
        // Resolve each displayed date once, not repeatedly inside the comparator.
        let matches: [(index: Int, session: LinkSession, modified: Date?)] = store.sessions.enumerated().compactMap { index, session in
            let summary = store.sidebarSummary(for: session)
            guard searchText.isEmpty || summary.title.localizedCaseInsensitiveContains(searchText)
                || (summary.preview?.localizedCaseInsensitiveContains(searchText) ?? false) else { return nil }
            return (index, session, summary.modified)
        }
        return matches.sorted { lhs, rhs in
            switch (lhs.modified, rhs.modified) {
            case let (left?, right?) where left != right: return left > right
            case (_?, nil): return true
            case (nil, _?): return false
            default: return lhs.index < rhs.index
            }
        }.map(\.session)
    }

    private var selection: Binding<String?> {
        Binding(get: { store.presentedSelectionID }, set: { id in
            guard let id, id != store.presentedSelectionID || (!store.busy && store.selectionPending) else { return }
            store.requestSelection(id)
        })
    }

    var body: some View {
        List(selection: selection) {
            ForEach(filteredSessions) { session in
                SessionSidebarRow(
                    summary: store.sidebarSummary(for: session),
                    connection: store.sidebarConnection(for: session),
                    messageCount: store.sidebarMessageCount(for: session),
                    working: store.sidebarWorking(for: session)
                        || (store.selectionLoading && store.presentedSelectionID == session.id),
                    unread: store.sessionActivity.unread.contains(session.sessionId),
                    needsAttention: store.hiddenPendingRequests[session.sessionId]?.isEmpty == false
                        || store.hiddenErrors[session.sessionId] != nil,
                    selected: store.presentedSelectionID == session.sessionId
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .simultaneousGesture(TapGesture(count: 2).onEnded {
                    openWindow(id: "session-detail", value: session.id)
                })
                .tag(session.id)
            }
        }
        // Keep the second click available while the first click attaches a session.
        // Selection intent is coalesced and native attachment admission serialized;
        // disabling the List would swallow reselection and a row's double-click.
        .overlay {
            if filteredSessions.isEmpty, !searchText.isEmpty {
                ContentUnavailableView.search(text: searchText)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let diagnostic = store.activityError {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Live activity updates are unavailable.", systemImage: "exclamationmark.circle")
                        .font(.callout)
                    Text("Reconnect to try again.")
                        .font(.caption).foregroundStyle(.secondary)
                    DisclosureGroup("Details") {
                        Text(diagnostic).font(.caption).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .font(.caption)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.regularMaterial)
            }
        }
        .searchable(text: $searchText, placement: .sidebar, prompt: "Search sessions")
        .navigationTitle("Sessions")
        .toolbar(removing: .sidebarToggle)
        .navigationSplitViewColumnWidth(min: 200, ideal: 250, max: 340)
        .toolbar {
            ToolbarSpacer(.flexible, placement: .primaryAction)
            ToolbarItem(placement: .primaryAction) {
                Button(action: newSession) {
                    Label("New Session", systemImage: "square.and.pencil")
                }
                .keyboardShortcut("n", modifiers: .command)
                .help("New session")
                .disabled(!store.connected || store.busy)
            }
        }
    }
}

#Preview("Session sidebar") {
    NavigationSplitView {
        SessionSidebarView(newSession: {})
    } detail: {
        Color.clear
    }
    .environmentObject(PreviewFixtures.daemonStore())
}
#endif
