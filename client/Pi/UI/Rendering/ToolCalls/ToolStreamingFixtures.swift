import Foundation

/// Parser-derived assistant arguments followed by independent native execution
/// observations. Synthetic replays, not executed requests or live provider recordings.
enum ToolStreamingFixtures {
    static func final(_ name: String) -> NativeToolPresentation {
        name == "custom_unknown" ? unknown : PreviewFixtures.toolCalls.first { $0.name == name }!
    }
    private static let unknown = NativeToolPresentation(
        call: decode(#"{"id":"preview-unknown","name":"custom_unknown","arguments":{"query":"Show fallback behavior","limit":3}}"#),
        result: decode(#"{"role":"toolResult","toolCallId":"preview-unknown","toolName":"custom_unknown","content":"An extension-owned result without a dedicated renderer.","details":{"items":["first","second"],"futureField":true}}"#)
    )

    static func frames(_ name: String) -> [ToolStreamingFrame] {
        let original = final(name)
        let snapshots = ToolArgumentStreamingFixtures.argumentSnapshots[name]!
        // Keep the representative parser timeline, including states whose new
        // arguments do not change the current renderer's appearance.
        let arguments: [ToolStreamingFrame] = snapshots.map { raw in
            let call: ToolCall = decodeJSON(.object(["id": .string(original.call.id), "name": .string(name),
                "arguments": decode(raw) as LinkJSON]))
            return .init(label: "Assistant tool call", call: call, result: nil)
        }
        var execution = executionFrames(name)
        // Execution-end is a native observation, not yet a committed toolResult.
        if let committed = execution.last, let result = committed.result, let start = execution.first?.execution?.start {
            let end = LinkToolExecution.End(toolCallId: original.call.id, toolName: name,
                result: .init(content: result.content, details: result.details.map(json)), isError: result.isError == true)
            execution.insert(.init(label: "Execution ended; awaiting committed result", call: committed.call, result: nil,
                execution: .init(start: start, update: execution.dropLast().last?.execution?.update, end: end)), at: execution.count - 1)
        }
        return arguments + execution
    }

    private static func executionFrames(_ name: String) -> [ToolStreamingFrame] {
        let original = final(name)
        let all: [String: LinkJSON] = decode(ToolArgumentStreamingFixtures.argumentSnapshots[name]!.last!)
        func call(_ fields: [String: LinkJSON]) -> ToolCall {
            decodeJSON(.object(["id": .string(original.call.id), "name": .string(name), "arguments": .object(fields)]))
        }
        func pending(_ label: String) -> ToolStreamingFrame {
            .init(label: label, call: call(all), result: nil,
                  execution: .init(start: .init(toolCallId: original.call.id, toolName: name, args: .object(all)), update: nil, end: nil))
        }
        func update(_ label: String, _ text: String?, _ details: LinkJSON? = nil) -> ToolStreamingFrame {
            let content: NativeMessageContent = text.map { blocks($0) } ?? .blocks([])
            let start = LinkToolExecution.Start(toolCallId: original.call.id, toolName: name, args: .object(all))
            let update = LinkToolExecution.Update(toolCallId: original.call.id, toolName: name, args: .object(all),
                partialResult: .init(content: content, details: details))
            return .init(label: label, call: call(all), result: nil, execution: .init(start: start, update: update, end: nil))
        }
        func result(_ text: String, _ details: LinkJSON? = nil, error: Bool = false) -> NativeMessage {
            var fields: [String: LinkJSON] = ["role": .string("toolResult"), "toolCallId": .string(original.call.id),
                "toolName": .string(name), "content": json(blocks(text)), "isError": .bool(error)]
            if let details { fields["details"] = details }
            return decodeJSON(.object(fields))
        }
        func committed(_ label: String, _ value: NativeMessage? = nil) -> ToolStreamingFrame {
            .init(label: label, call: call(all), result: value ?? original.result)
        }
        func text(_ key: String) -> String { if case .string(let value) = all[key] { value } else { "" } }

        switch name {
        // SDK1.0.2 ignores _onUpdate for all six filesystem operations.
        case "read":
            return [pending("Waiting for read"),
                committed("Requested file lines returned")]
        case "write":
            return [pending("Waiting for write"),
                committed("File write acknowledged")]
        case "edit":
            // The SDK's pure edit/diff helpers generated this result from the
            // same complete source and two disjoint requested replacements.
            return [pending("Waiting for edit"),
                committed("Applied edits and authoritative file diff returned")]
        case "ls":
            return [pending("Waiting for ls"),
                committed("Directory entries and kinds returned")]
        case "find":
            return [pending("Waiting for find"),
                committed("Matching paths and result count returned")]
        case "grep":
            return [pending("Waiting for grep"),
                committed("Matched lines and context metadata returned")]
        case "bash":
            // SDK bash emits empty output, then cumulative accumulator snapshots.
            // Keep every arrival, including the full update/end/recorded duplicates.
            let output = original.result?.content?.presentationText ?? ""
            let lines = output.components(separatedBy: "\n")
            let building = lines.prefix(6).joined(separator: "\n") + "\n"
            let testing = lines.prefix(10).joined(separator: "\n") + "\n"
            return [pending("Waiting for bash"),
                update("Initial empty accumulator", "", .object([:])),
                update("Build output · cumulative snapshot", building, .object([:])),
                update("Test output · cumulative snapshot", testing, .object([:])),
                update("Complete output · cumulative snapshot", output, .object([:])),
                committed("Complete stdout returned")]
        case "copy":
            // copy.ts753 emits one start notice; later rsync diagnostics are raw
            // CHUNK REPLACEMENTS, not cumulative or percentage progress. This
            // sample follows a supported transfer-error path; the catalog stays success.
            let request: LinkJSON = .object(["source": .object(["target": all["sourceTarget"]!, "requestedPath": all["sourcePath"]!]),
                "destination": .object(["target": all["destTarget"]!, "requestedPath": all["destPath"]!]), "overwrite": all["overwrite"] ?? .bool(false)])
            let diagnostic1 = "rsync: send_files failed to open \"Tests/SessionSearchTests.swift\": Permission denied (13)\n"
            let diagnostic2 = "rsync error: some files/attrs were not transferred (code 23)\n"
            let failed = result("copy failed: Copy receiver exited 23\n" + diagnostic1 + diagnostic2, error: true)
            return [pending("Waiting for copy"),
                update("rsync launch notice · no transfer percentages", "Copying with rsync", request),
                update("rsync diagnostic chunk replaces launch notice", diagnostic1, request),
                update("Next diagnostic replaces prior chunk", diagnostic2, request),
                committed("Copy failure returned; endpoint data preserved", failed)]
        case "vm_create":
            // Linux backend233–276 supplies these exact labels; extension accumulates them.
            let p1 = "Preparing VM scratch-preview\n"
            let p2 = p1 + "\nSaving VM scratch-preview\n"
            let p3 = p2 + "\nCleaning up VM scratch-preview\n"
            let p4 = p3 + "Created stopped VM scratch-preview\n"
            return [pending("Waiting for vm_create"),
                update("Backend: prepare image · cumulative log", p1),
                update("Backend: save image · cumulative log", p2),
                update("Backend: remove builder · cumulative log", p3),
                update("Backend: stopped image created · cumulative log", p4),
                committed("Created VM and running target returned")]
        case "vm_start":
            // Normal macOS boot emits one callback; Linux start has no callback.
            let vmID = text("vmId")
            let started = result("Started \(vmID).", .object(["display": .string("Started \(vmID)\nvm: rw\ntarget: \(vmID) [exec]"),
                "target": .object(["id": .string(vmID), "network": .bool(false), "execCapable": .bool(true)])]))
            return [pending("Waiting for vm_start"),
                update("macOS backend: normal boot callback", "Starting normal macOS boot\n"),
                committed("Started target and display metadata returned", started)]
        case "vm_stop":
            return [pending("Waiting for vm_stop"),
                committed("VM stopped and saved")]
        case "vm_list":
            return [pending("Waiting for vm_list"),
                committed("Managed VM list returned atomically")]
        case "vm_publish":
            return [pending("Waiting for vm_publish"),
                committed("Reusable VM base published")]
        case "vm_destroy":
            return [pending("Waiting for vm_destroy"),
                committed("VM filesystem destruction acknowledged")]
        case "bg_start":
            return [pending("Waiting for bg_start"),
                committed("Job accepted as running; live output belongs to background panel")]
        case "bg_list":
            // includeRead=false filters previously-read completions before markRead
            // updates the returned jobs. Both jobs below were eligible at that cut.
            let jobs: LinkJSON = .array([
                .object(["id": .string("bg_k7t34e"), "status": .string("running"), "target": .string("scratch-preview"),
                    "cwd": .string("/workspace/Pi"), "command": .string("swift test --filter SessionSearchTests"), "completionRead": .bool(false)]),
                .object(["id": .string("bg_m2p91a"), "status": .string("done"), "target": .string("scratch-preview"),
                    "cwd": .string("/workspace/Pi"), "command": .string("printf done"), "exitCode": .number(0), "completionRead": .bool(true)])])
            let listing = result("bg_k7t34e [running] target=scratch-preview cwd=/workspace/Pi $ swift test --filter SessionSearchTests\nbg_m2p91a [done exit=0] target=scratch-preview cwd=/workspace/Pi $ printf done\n\nUnread completion mailbox:\nbg_m2p91a [done exit=0]",
                .object(["jobs": jobs, "unreadCompletionIds": .array([.string("bg_m2p91a")])]))
            return [pending("Waiting for list"), committed("List returned", listing)]
        case "bg_status":
            return [pending("Waiting for bg_status"),
                committed("Running job header and buffered output snapshot")]
        case "bg_stop":
            return [pending("Waiting for bg_stop"),
                committed("Stopped job and retained output returned atomically")]
        case "capabilities":
            return [pending("Waiting for capabilities"),
                committed("Complete capability snapshot returned atomically")]
        case "spawn_subagent":
            // Keep the real callback arrival even though the renderer already
            // owns the authored instructions and must not duplicate their echo.
            return [pending("Waiting for spawn_subagent"),
                update("Starting actor callback · authored body retains one owner",
                       "Starting subagent " + text("name") + ".\n\nInstructions:\n" + text("instructions")),
                committed("Spawned actor ID/model/status returned")]
        case "list_subagents":
            let display = "Subagents: 2 active, 1 dismissed, 1 running\n\nActive subagents:\n  - Search review (sub-preview) [idle] claude-sonnet-4-5\n  - Layout audit (sub-layout) [running] gpt-5\n\nDismissed subagents:\n  - Completed review (sub-old) [dismissed] claude-sonnet-4-5"
            let agents: LinkJSON = .array([
                .object(["id": .string("sub-preview"), "name": .string("Search review"), "status": .string("idle"), "dormant": .bool(false), "model": .string("claude-sonnet-4-5")]),
                .object(["id": .string("sub-layout"), "name": .string("Layout audit"), "status": .string("running"), "dormant": .bool(false), "model": .string("gpt-5")]),
                .object(["id": .string("sub-old"), "name": .string("Completed review"), "status": .string("dismissed"), "dormant": .bool(true), "model": .string("claude-sonnet-4-5")])])
            return [pending("Waiting for list_subagents"),
                committed("Structured actor snapshot returned", result(display, .object(["agents": agents, "display": .string(display)])))]
        case "inspect_subagent":
            return [pending("Waiting for inspect_subagent"),
                committed("Saved transcript and actor identity returned")]
        case "message_subagent":
            let message = text("message")
            let dispatch: LinkJSON = .object(["id": all["id"]!, "name": .string("Search review"), "message": .string(message), "delivery": all["delivery"]!])
            return [pending("Waiting for message_subagent"),
                update("Native dispatch callback · message echo projected once", "Dispatching message to Search review (followUp).\n\nMessage:\n" + message, dispatch),
                committed("Delivery receipt and authored message returned")]
        case "dismiss_subagent":
            return [pending("Waiting for dismiss_subagent"),
                committed("Actor dismissed; saved conversation retained")]
        case "notify_parent":
            let message = text("message")
            return [pending("Waiting for notification"),
                committed("Parent notice sent, not a parent response", result("Sent notification to parent.\n\nMessage: " + message, .object(["message": .string(message)])))]
        case "goal_report":
            let report = text("report")
            return [pending("Waiting for goal report"),
                committed("Report submitted; evaluator outcome is not this tool's stream", result("Goal report submitted:\n\n" + report + "\n\nThe independent evaluator will decide after this turn ends.", .object(["goalId": .string("preview-goal"), "report": .string(report)])))]
        default:
            return [pending("Waiting for extension result"),
                committed("Opaque extension result returned")]
        }
    }

    private static func blocks(_ text: String) -> NativeMessageContent {
        .blocks([.text(TextContent(text: text, textSignature: nil))])
    }
    private static func object<T: Encodable>(_ value: T) -> [String: LinkJSON] {
        if case .object(let fields) = json(value) { fields } else { [:] }
    }
    private static func json<T: Encodable>(_ value: T) -> LinkJSON {
        try! JSONDecoder().decode(LinkJSON.self, from: JSONEncoder().encode(value))
    }
    private static func decodeJSON<T: Decodable>(_ value: LinkJSON) -> T {
        try! JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
    }
    private static func decode<T: Decodable>(_ text: String) -> T { try! JSONDecoder().decode(T.self, from: Data(text.utf8)) }
}
