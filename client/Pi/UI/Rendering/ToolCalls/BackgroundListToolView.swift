import SwiftUI

/// New results carry ordered job metadata. Older results still carry the
/// original human-readable listing, so they never need JSON or text parsing.
struct BackgroundListToolView: View {
    let call: ToolCall
    let result: NativeMessage?

    private var listingText: String? { result?.content?.presentationText }

    private func jobRow(_ job: BackgroundListJob) -> some View {
        let color: Color = switch job.status {
        case "running", "done": .green
        case "failed": .red
        case "stopped", "interrupted": .orange
        default: .secondary
        }
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: job.id).font(.subheadline.weight(.medium))
                Spacer(minLength: 4)
                Text(verbatim: job.status.capitalized).foregroundStyle(color)
                if let exitCode = job.exitCode { Text(verbatim: "exit \(exitCode)").foregroundStyle(.secondary) }
            }
            Text(verbatim: "$ " + job.command)
                .font(.system(.body, design: .monospaced))
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: "\(job.target) · \(job.cwd)")
                .font(.caption).foregroundStyle(.secondary)
            if job.completionRead == true {
                Text("Completion read").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            let arguments = call.arguments?.bgListValue
            if arguments?.includeRead == false || arguments?.markRead == true {
                HStack(spacing: 12) {
                    if arguments?.includeRead == false { Text("Unread only") }
                    if arguments?.markRead == true { Text("Mark completions read") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if let result {
                if result.isError == true || result.errorMessage?.isEmpty == false {
                    Text(verbatim: result.errorMessage ?? listingText ?? "Could not list background commands")
                        .foregroundStyle(.red)
                } else if let jobs = result.details?.bgListValue?.jobs {
                    if jobs.isEmpty {
                        Text("No background commands.").foregroundStyle(.secondary)
                    } else {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            ForEach(jobs.indices, id: \.self) { index in jobRow(jobs[index]) }
                        }
                    }
                    if let ids = result.details?.bgListValue?.unreadCompletionIds, !ids.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(arguments?.markRead == true ? "Completions marked read" : "Unread completion mailbox")
                                .font(.subheadline.weight(.semibold))
                            ForEach(ids.indices, id: \.self) { index in
                                Text(verbatim: ids[index]).font(.system(.caption, design: .monospaced))
                            }
                        }
                    }
                } else if let listingText, !listingText.isEmpty {
                    Text(verbatim: listingText)
                        .font(.system(.body, design: .monospaced))
                        .fixedSize(horizontal: false, vertical: true)
                } else if let error = result.errorMessage, !error.isEmpty {
                    Text(verbatim: error).foregroundStyle(.red)
                } else {
                    ToolResultContentView(content: result.content, emptyLabel: "No list content returned")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}



#Preview("bg_list") {
    ToolStreamingPreview("bg_list") { frame in
        ToolCallView(call: frame.call, result: frame.result, execution: frame.execution)
    }
}
