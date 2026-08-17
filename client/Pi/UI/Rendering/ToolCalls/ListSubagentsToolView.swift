import SwiftUI

/// The tool result carries an ordered, structured snapshot. Never parse its
/// prose display or present delegation instructions as conversation previews.
struct ListSubagentsToolView: View {
    let call: ToolCall
    let result: NativeMessage?

    private var agents: [SubagentToolDetails]? { result?.details?.listSubagentsValue?.agents }
    private var activeOnly: Bool {
        let arguments = call.arguments?.listSubagentsValue
        return (arguments?.includeDismissed ?? arguments?.includeDormant) == false
    }

    private func isDismissed(_ agent: SubagentToolDetails) -> Bool {
        if let status = agent.status { return status == "dismissed" }
        return agent.dormant == true
    }

    private func row(_ agent: SubagentToolDetails) -> some View {
        let status = agent.status ?? (agent.dormant == true ? "dismissed" : "Status unavailable")
        let color: Color = switch status {
        case "running": .green
        case "idle": .blue
        default: .secondary
        }
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: agent.name ?? agent.id ?? "Unnamed subagent")
                    .font(.headline)
                Spacer(minLength: 4)
                Text(verbatim: status.capitalized)
                    .foregroundStyle(color)
            }
            if let model = agent.model, !model.isEmpty {
                Text(verbatim: model).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func section(_ title: String, agents: [SubagentToolDetails]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold))
            if agents.isEmpty {
                Text("None").foregroundStyle(.secondary)
            } else {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(agents.indices, id: \.self) { index in row(agents[index]) }
                }
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if result == nil {
                EmptyView()
            } else if result?.isError == true || result?.errorMessage?.isEmpty == false {
                Text("Could not list subagents").foregroundStyle(.secondary)
                ToolResultContentView(content: result?.content, error: result?.errorMessage,
                                      emptyLabel: "No error description returned")
            } else if let agents {
                let active = agents.filter { !isDismissed($0) }
                let dismissed = agents.filter(isDismissed)
                if activeOnly { Text("Active only").font(.caption).foregroundStyle(.secondary) }
                section("Active subagents", agents: active)
                if !activeOnly || !dismissed.isEmpty {
                    section("Dismissed subagents", agents: dismissed)
                }
            } else if let result {
                ToolResultContentView(content: result.content, emptyLabel: "Subagent list unavailable")
            } else {
                Text("Subagent list unavailable").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}



#Preview("list_subagents") {
    ToolStreamingPreview("list_subagents") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
