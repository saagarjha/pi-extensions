import SwiftUI

/// Read-only capability facts captured when the tool ran, not current permission controls.
struct CapabilitiesToolCallView: View {
    let result: NativeMessage?

    private var details: CapabilitiesDetails? { result?.details?.capabilitiesValue }
    private var capabilities: ToolCapabilities? { details?.capabilities }
    private func flag(_ value: Bool?) -> String { value.map { $0 ? "yes" : "no" } ?? "unknown" }
    private func value(_ text: String?) -> String { text ?? "unknown" }

    private var sections: [(title: String, rows: [String])] {
        [
            ("Files", (capabilities?.files ?? []).map { "\($0.path) — \($0.mode)" }),
            ("System paths", (capabilities?.systemPaths ?? []).map {
                "\(value($0.label))\n\(value($0.path)) — \(value($0.mode))"
            }),
            ("Network", [capabilities?.network ?? "unknown"]),
            ("VMs", (capabilities?.vms ?? []).map {
                "\(value($0.id)) — \(value($0.os)), \(value($0.mode)), \(value($0.attachment).replacingOccurrences(of: "-", with: " "))\nVM network grant: \(flag($0.networkGrant)); execution-capable: \(flag($0.execCapable)); network active: \(flag($0.network))"
            }),
            ("SSH targets", (capabilities?.sshTargets ?? []).map {
                let port = $0.port.map { ":\($0)" } ?? ""
                return "\($0.id) — \($0.destination)\(port)"
            }),
            ("Execution grants", (capabilities?.execGrants ?? []).map {
                "\($0.target) · \($0.command) — \($0.mode)"
            }),
            ("Running targets", (capabilities?.runningTargets ?? []).map { target in
                var lines = [
                    "\(value(target.id)) — \(value(target.kind))",
                    "Execution-capable: \(flag(target.execCapable)); network: \(flag(target.network))"
                ]
                if let vmID = target.vmId { lines.append("VM: " + vmID) }
                if let execution = target.vmExec, let status = execution.status {
                    lines.append("Execution: " + status.replacingOccurrences(of: "-", with: " "))
                    if let reason = execution.blockedReason { lines.append(reason.replacingOccurrences(of: "-", with: " ")) }
                }
                for mount in target.mounts ?? [] {
                    lines.append("\(mount.hostPath) → \(mount.guestPath) (\(mount.mode))")
                }
                return lines.joined(separator: "\n")
            }),
            ("Tools", capabilities?.tools ?? [])
        ]
    }

    private var fallbackText: String {
        if let display = details?.display { return display }
        switch result?.content {
        case .text(let text): return text
        case .blocks(let blocks):
            return blocks.compactMap { block in
                if case .text(let value) = block { return value.text }
                return nil
            }.joined(separator: "\n\n")
        case nil: return result?.errorMessage ?? ""
        }
    }

    var body: some View {
        if capabilities != nil {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(Array(sections.enumerated()), id: \.offset) { _, section in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(section.title).font(.headline)
                        if section.rows.isEmpty {
                            Text("None").foregroundStyle(.secondary)
                        } else {
                            ForEach(Array(section.rows.enumerated()), id: \.offset) { _, row in
                                Text(verbatim: row)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }
            }
            .textSelection(.enabled)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text(result == nil ? "Waiting for capabilities…" : "Structured capabilities are unavailable for this result.")
                    .foregroundStyle(.secondary)
                if !fallbackText.isEmpty { Text(verbatim: fallbackText).textSelection(.enabled) }
            }
        }
    }
}

#Preview("Capabilities") {
    let tool = PreviewFixtures.toolCalls.first { $0.name == "capabilities" }!
    ToolCallView(call: tool.call, result: tool.result)
}
