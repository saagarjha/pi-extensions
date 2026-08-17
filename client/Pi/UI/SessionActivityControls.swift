import SwiftUI
#if os(macOS)

/// Only these inputs affect the activity buttons. Keeping the observed session store
/// outside this view lets unrelated streaming text leave native toolbar controls alone.
struct SessionActivityControls: View {
    let subagentCount: Int?
    let backgroundCount: Int?
    @Binding var activity: ActivityPanel?

    var body: some View {
        ControlGroup {
            Button { activity = .subagents } label: {
                HStack {
                    Label("Subagents", systemImage: "person.3")
                    if let count = subagentCount { Text("\(count)") }
                }
            }
            .help("Show subagents")
            Button { activity = .tasks } label: {
                HStack {
                    Label("Background Tasks", systemImage: "apple.terminal.on.rectangle")
                    if let count = backgroundCount { Text("\(count)") }
                }
            }
            .help("Show background tasks")
        }
        .controlGroupStyle(.navigation)
    }
}
#endif
