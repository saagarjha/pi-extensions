import SwiftUI

struct DaemonInteractionView: View {
    let request: LinkInteraction
    let enabled: Bool
    let answer: (LinkJSON) -> Void
    @State private var text = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(request.title ?? "Daemon request").font(.headline)
            switch request.kind {
            case "input", "editor":
                TextField(request.kind == "editor" ? "Response" : request.detail ?? "Response", text: $text, axis: .vertical)
                Button("Submit") { answer(.string(text)) }.disabled(!enabled)
            case "select":
                ForEach(Array(request.choices.enumerated()), id: \.offset) { _, value in
                    Button(value) { answer(.string(value)) }.disabled(!enabled)
                }
            default:
                Text("This request requires a TUI controller. It has not been answered.").foregroundStyle(.secondary)
            }
            if !enabled { Text("Take control to answer.").font(.caption).foregroundStyle(.secondary) }
        }.padding().frame(maxWidth: .infinity, alignment: .leading).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            .task(id: request.id) { if request.kind == "editor" { text = request.detail ?? "" } }
    }
}

#Preview("Input request") {
    DaemonInteractionView(
        request: LinkInteraction(id: "input-preview", kind: "input", arguments: .text(title: "Name this session", detail: "Session name")),
        enabled: true, answer: { _ in }
    )
}
