import SwiftUI

struct ToolStreamingFrame {
    let label: String
    let call: ToolCall
    let result: NativeMessage?
    var execution: LinkToolExecution? = nil
}

/// Small Canvas-only manual stage host. The production view keeps its identity while
/// native argument/execution/result observations change; no tools are executed.
struct ToolStreamingPreview<Content: View>: View {
    private let name: String
    private let frames: [ToolStreamingFrame]
    private let content: (ToolStreamingFrame) -> Content
    @State private var index = 0

    init(_ name: String, @ViewBuilder content: @escaping (ToolStreamingFrame) -> Content) {
        self.name = name
        frames = ToolStreamingFixtures.frames(name)
        self.content = content
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(name) · \(index + 1)/\(frames.count) · \(frames[index].label)")
                    .font(.caption).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
                    .frame(height: 20, alignment: .leading)
                Slider(value: Binding(get: { Double(index) }, set: {
                    index = min(max(Int($0.rounded()), 0), frames.count - 1)
                }), in: 0...Double(frames.count - 1), step: 1)
                .accessibilityLabel("Stage")
            }
            .frame(height: 60, alignment: .topLeading)
            content(frames[index])
        }
        .frame(width: 520, height: 900, alignment: .topLeading)
        .padding()
    }
}
