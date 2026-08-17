import SwiftUI

/// Shared command/output presentation for tool results and background-task panels.
struct CommandOutputView: View {
    let target: String?
    let command: String
    var timeoutMs: Double? = nil
    var output: String? = nil

    private var commandLine: String {
        let prefix = target.flatMap { $0.isEmpty ? nil : $0 }
        return (prefix.map { "\($0) " } ?? "") + "$ " + command
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: commandLine)
                if let timeoutMs {
                    Text("\((timeoutMs / 1000).formatted()) s timeout")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
            }
            if let output, !output.isEmpty { Text(verbatim: output) }
        }
        .textSelection(.enabled)
        .font(.system(.body, design: .monospaced))
    }
}
