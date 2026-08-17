import SwiftUI
#if os(macOS)

/// Only display metadata is retained when switching sessions, never another history copy.
nonisolated struct SessionSidebarSummary: Equatable {
    let name: String?
    let preview: String?
    let modified: Date?
    var messageCount: Int? = nil
    var title: String { LinkSession.displayTitle(name) }

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
    case connected, viewing, disconnected

    var title: String {
        switch self {
        case .connected: "Connected"
        case .viewing: "Viewing"
        case .disconnected: "Disconnected"
        }
    }
}

private struct SessionSidebarRow: View {
    let summary: SessionSidebarSummary
    let connection: SessionSidebarConnection
    let messageCount: Int?
    let working: Bool
    let unread: Bool

    private var connectionColor: Color {
        switch connection {
        case .connected: .green
        case .viewing: .blue
        case .disconnected: .red
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                if working {
                    ProgressView().controlSize(.mini).accessibilityLabel("Working")
                } else if unread {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 8)).foregroundStyle(Color.accentColor)
                        .accessibilityLabel("Unread messages")
                } else {
                    Color.clear.frame(height: 12).accessibilityHidden(true)
                }
            }
            .frame(width: 14)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(summary.title).font(.headline).lineLimit(1)
                    Spacer(minLength: 4)
                    if let modified = summary.modified {
                        Text(modified, format: .relative(presentation: .named, unitsStyle: .abbreviated))
                            .font(.caption2).foregroundStyle(.secondary).fixedSize()
                            .help(modified.formatted(date: .abbreviated, time: .shortened))
                    }
                }
                HStack(alignment: .firstTextBaseline) {
                    if let messageCount {
                        Text(messageCount == 1 ? "1 message" : "\(messageCount.formatted()) messages")
                    }
                    Spacer(minLength: 4)
                    Text(connection.title).foregroundStyle(connectionColor)
                }
                .font(.subheadline).lineLimit(1)
                if let detail = summary.preview {
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct SessionSidebarView: View {
    @EnvironmentObject private var store: DaemonSessionStore
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
        Binding(get: { store.selectedID }, set: { id in
            guard let id, id != store.selectedID else { return }
            Task { await store.select(id) }
        })
    }

    var body: some View {
        List(selection: selection) {
            ForEach(filteredSessions) { session in
                SessionSidebarRow(
                    summary: store.sidebarSummary(for: session),
                    connection: store.sidebarConnection(for: session),
                    messageCount: store.sidebarMessageCount(for: session),
                    working: store.sidebarWorking(for: session),
                    unread: store.sessionActivity.unread.contains(session.sessionId)
                )
                .tag(session.id)
            }
        }
        .disabled(store.busy)
        .overlay {
            if filteredSessions.isEmpty, !searchText.isEmpty {
                ContentUnavailableView.search(text: searchText)
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
