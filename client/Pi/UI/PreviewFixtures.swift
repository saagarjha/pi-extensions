import Foundation

/// Concrete API/native models used in previews. No transport or JSON-tree projection.
nonisolated enum PreviewFixtures {
    static let control = LinkControl(controllerClientId: "preview-other-client", controlGeneration: 1)
    static let sessions: [LinkSession] = [
        session(id: "interface", title: "Build the Mac interface", firstMessage: "Keep the session front and center."),
        session(id: "review", title: "Review session events", firstMessage: "Let's look at the latest changes."),
        session(id: "notes", title: nil, firstMessage: "A few things to come back to.")
    ]

    static let backgroundTasks: [LinkBackgroundTask] = [
        LinkBackgroundTask(id: "build", target: "local", command: "swift build", cwd: "/workspace/Pi",
                           status: "running", timeoutMs: nil, exitCode: nil, error: nil,
                           startedAt: 0, updatedAt: 1000, revision: 1),
        LinkBackgroundTask(id: "web", target: "scratch-linux", command: "npm run dev", cwd: "/workspace/web",
                           status: "running", timeoutMs: nil, exitCode: nil, error: nil,
                           startedAt: 0, updatedAt: 1000, revision: 1)
    ]
    static let backgroundTaskOutput = LinkBackgroundTaskDetail(
        id: "build", target: "local", command: "swift build", cwd: "/workspace/Pi",
        status: "running", timeoutMs: nil, exitCode: nil, error: nil,
        startedAt: 0, updatedAt: 1000, revision: 1,
        output: """
        Building for debugging...
        [1/8] Write sources
        [2/8] Write swift-version
        [3/8] Compiling Pi ActivityStore.swift
        [4/8] Compiling Pi ActivityView.swift
        [5/8] Compiling Pi SessionView.swift
        """
    )
    static let activitySubagents: [LinkSubagent] = [
        LinkSubagent(id: "interface", name: "Interface", status: "running", dormant: false,
                     controlRevision: 1, nativeIdentity: "preview-interface", sourceFile: nil,
                     model: .init(provider: "anthropic", id: "claude-sonnet-4-6"), thinkingLevel: nil, error: nil),
        LinkSubagent(id: "review", name: "Review", status: "idle", dormant: false,
                     controlRevision: 1, nativeIdentity: "preview-review", sourceFile: nil,
                     model: .init(provider: "openai", id: "gpt-5.2"), thinkingLevel: nil, error: nil)
    ]

    private static func session(id: String, title: String?, firstMessage: String) -> LinkSession {
        LinkSession(id: id, sessionId: id, name: title, cwd: "/", agentDir: nil,
                    status: nil, attachedClientCount: id == "interface" ? 1 : 0, fileIdentity: nil, firstMessage: firstMessage,
                    streaming: false, control: id == "interface" ? control : LinkControl(controllerClientId: nil, controlGeneration: 0),
                    modified: Date().addingTimeInterval(id == "interface" ? -180 : id == "review" ? -7200 : -86400).formatted(.iso8601),
                    messageCount: id == "interface" ? nil : id == "review" ? 240 : 18)
    }

    static let markdown = """
    ## A native session

    Messages can include **bold text**, *emphasis*, ~~strikethrough~~, and `inline code`. Here's a [SwiftUI reference](https://developer.apple.com/documentation/swiftui).

    - Keep the sidebar easy to scan.
    - Render tool output separately from the response.
    - Leave room for a longer explanation.

    > Keep the interface focused on the session.

    ### A small SwiftUI example

    ```swift
    struct Greeting: View {
        var body: some View {
            Text("Hello, Pi")
                .font(.headline)
        }
    }
    ```

    Plain paragraphs should still feel comfortable to read alongside formatted content.
    """

    // Real native calls retain both typed and complete raw arguments.
    static let nativeToolCalls: [ToolCall] = decode("""
    [
      {"id":"call-read","name":"read","arguments":{"target":"local","path":"UI/ContentView.swift","offset":1,"limit":40}},
      {"id":"call-bash","name":"bash","arguments":{"target":"local","command":"find UI -name '*.swift'","timeoutMs":1000}},
      {"id":"call-missing","name":"read","arguments":{"target":"local","path":"UI/Missing.swift"}},
      {"id":"call-bash-error","name":"bash","arguments":{"target":"local","command":"swift build"}},
      {"id":"call-capabilities","name":"capabilities","arguments":{}},
      {"id":"call-pending","name":"read","arguments":{"path":"UI/"}}
    ]
    """)

    static let remoteReadCall: ToolCall = decode("""
    {"id":"remote-read","name":"read","arguments":{"target":"build-host","path":"/workspace/Sources/Example.swift","offset":41,"limit":20}}
    """)
    static let remoteReadResult = message(
        role: "toolResult", content: .blocks([text("func example() {\n    print(\"Hello\")\n}")]),
        toolCallId: "remote-read", toolName: "read", isError: false
    )

    // A value-only capabilities snapshot, matching the permissions tool's DTO.
    // These are example paths/IDs, not inspected host state or live permissions.
    static let capabilitiesResult: NativeMessage = {
        let summary = "files:\n  rw        /sample/project\nsystem:\n  rw        /sample/session/scratch (session scratch)\nnetwork: deny\nvms:\n  rw        scratch-preview [linux]running [exec]\nssh targets:\n  none\nexec grants:\n  allow scratch-preview *\nrunning:\n  scratch-preview [exec-capable] [exec allowed]\n      /sample/project → /mnt/project (rw)\ntools: read, write, edit, ls, find, grep, copy, bash, bg_start, bg_list, bg_status, bg_stop, vm_create, vm_start, vm_list, vm_stop, vm_publish, vm_destroy, spawn_subagent, list_subagents, inspect_subagent, message_subagent, dismiss_subagent, capabilities, goal_report"
        let snapshot: ToolCapabilities = decode(#"""
        {
          "files": [
            {
              "path": "/sample/project",
              "mode": "rw"
            }
          ],
          "systemPaths": [
            {
              "path": "/sample/session/scratch",
              "mode": "rw",
              "label": "session scratch"
            }
          ],
          "network": "deny",
          "vms": [
            {
              "id": "scratch-preview",
              "os": "linux",
              "mode": "rw",
              "networkGrant": false,
              "attachment": "running",
              "execCapable": true,
              "network": false
            }
          ],
          "sshTargets": [],
          "execGrants": [
            {
              "target": "scratch-preview",
              "command": "*",
              "mode": "allow"
            }
          ],
          "runningTargets": [
            {
              "id": "scratch-preview",
              "kind": "linux",
              "execCapable": true,
              "network": false,
              "vmId": "scratch-preview",
              "vmExec": {
                "status": "allowed"
              },
              "mounts": [
                {
                  "hostPath": "/sample/project",
                  "guestPath": "/mnt/project",
                  "mode": "rw"
                }
              ]
            }
          ],
          "tools": [
            "read",
            "write",
            "edit",
            "ls",
            "find",
            "grep",
            "copy",
            "bash",
            "bg_start",
            "bg_list",
            "bg_status",
            "bg_stop",
            "vm_create",
            "vm_start",
            "vm_list",
            "vm_stop",
            "vm_publish",
            "vm_destroy",
            "spawn_subagent",
            "list_subagents",
            "inspect_subagent",
            "message_subagent",
            "dismiss_subagent",
            "capabilities",
            "goal_report"
          ]
        }
        """#)
        var result = message(role: "toolResult", content: .blocks([text(summary)]), toolCallId: "call-capabilities", toolName: "capabilities", isError: false)
        result.details = .capabilities(CapabilitiesDetails(capabilities: snapshot, display: summary))
        return result
    }()

    static let nativeToolResults: [NativeMessage] = [
        message(role: "toolResult", content: .blocks([text("import SwiftUI\n\nstruct ContentView: View {\n    var body: some View { Text(\"Hello\") }\n}")]), toolCallId: "call-read", toolName: "read", isError: false),
        message(role: "toolResult", content: .blocks([text("UI/ContentView.swift\nUI/MyApp.swift\n\nExit code: 0")]), toolCallId: "call-bash", toolName: "bash", isError: false),
        message(role: "toolResult", content: .blocks([text("File not found: UI/Missing.swift")]), toolCallId: "call-missing", toolName: "read", isError: true),
        message(role: "toolResult", content: .blocks([text("error: Could not find Package.swift in this directory.\nExit code: 1")]), toolCallId: "call-bash-error", toolName: "bash", isError: true),
        capabilitiesResult
    ]

    // Static registration-union samples: permissions (including SDK filesystem
    // tools), subagents (including child-only notify_parent), and goal. No tool
    // definitions/catalogs are loaded or executed by a preview.
    static let additionalToolCalls: [ToolCall] = decode(#"""
    [
      {
        "id": "catalog-write",
        "name": "write",
        "arguments": {
          "target": "local",
          "path": "notes.txt",
          "content": "Hello\n"
        }
      },
      {
        "id": "catalog-edit",
        "name": "edit",
        "arguments": {
          "target": "local",
          "path": "notes.txt",
          "edits": [
            {
              "oldText": "Hello",
              "newText": "Hello, Pi"
            }
          ]
        }
      },
      {
        "id": "catalog-ls",
        "name": "ls",
        "arguments": {
          "target": "local",
          "path": "UI",
          "limit": 20
        }
      },
      {
        "id": "catalog-find",
        "name": "find",
        "arguments": {
          "target": "local",
          "pattern": "**/*.swift",
          "path": "UI",
          "limit": 20
        }
      },
      {
        "id": "catalog-grep",
        "name": "grep",
        "arguments": {
          "target": "local",
          "pattern": "SessionView",
          "path": "UI",
          "glob": "*.swift",
          "ignoreCase": false,
          "literal": true,
          "context": 1,
          "limit": 20
        }
      },
      {
        "id": "catalog-copy",
        "name": "copy",
        "arguments": {
          "sourceTarget": "local",
          "sourcePath": "notes.txt",
          "destTarget": "scratch-preview",
          "destPath": "/workspace/notes.txt",
          "overwrite": false
        }
      },
      {
        "id": "catalog-vm_create",
        "name": "vm_create",
        "arguments": {
          "os": "linux",
          "network": false
        }
      },
      {
        "id": "catalog-vm_start",
        "name": "vm_start",
        "arguments": {
          "vmId": "scratch-preview",
          "network": false
        }
      },
      {
        "id": "catalog-vm_stop",
        "name": "vm_stop",
        "arguments": {
          "target": "scratch-preview"
        }
      },
      {
        "id": "catalog-vm_list",
        "name": "vm_list",
        "arguments": {}
      },
      {
        "id": "catalog-vm_destroy",
        "name": "vm_destroy",
        "arguments": {
          "vmId": "scratch-preview"
        }
      },
      {
        "id": "catalog-vm_publish",
        "name": "vm_publish",
        "arguments": {
          "target": "scratch-preview",
          "name": "preview-base"
        }
      },
      {
        "id": "catalog-bg_start",
        "name": "bg_start",
        "arguments": {
          "target": "scratch-preview",
          "command": "printf ready; sleep 300",
          "cwd": "/",
          "timeoutMs": 600000
        }
      },
      {
        "id": "catalog-bg_list",
        "name": "bg_list",
        "arguments": {
          "includeRead": true,
          "markRead": false
        }
      },
      {
        "id": "catalog-bg_status",
        "name": "bg_status",
        "arguments": {
          "id": "bg-preview",
          "tailChars": 2000
        }
      },
      {
        "id": "catalog-bg_stop",
        "name": "bg_stop",
        "arguments": {
          "id": "bg-preview"
        }
      },
      {
        "id": "catalog-spawn_subagent",
        "name": "spawn_subagent",
        "arguments": {
          "instructions": "Review the sample view without editing files. Report the findings with notify_parent.",
          "name": "Preview review"
        }
      },
      {
        "id": "catalog-list_subagents",
        "name": "list_subagents",
        "arguments": {
          "includeDormant": true
        }
      },
      {
        "id": "catalog-inspect_subagent",
        "name": "inspect_subagent",
        "arguments": {
          "id": "sub-preview"
        }
      },
      {
        "id": "catalog-dismiss_subagent",
        "name": "dismiss_subagent",
        "arguments": {
          "id": "sub-preview"
        }
      },
      {
        "id": "catalog-message_subagent",
        "name": "message_subagent",
        "arguments": {
          "id": "sub-preview",
          "message": "Summarize the review findings.",
          "delivery": "followUp"
        }
      },
      {
        "id": "catalog-notify_parent",
        "name": "notify_parent",
        "arguments": {
          "message": "The sample view review is complete. No files were changed."
        }
      },
      {
        "id": "catalog-goal_report",
        "name": "goal_report",
        "arguments": {
          "report": "The sample review is complete; the requested cases were checked."
        }
      }
    ]
    """#)
    private static let additionalToolOutput: [String] = decode(#"""
    [
      "Successfully wrote to notes.txt",
      "Successfully replaced 1 block in notes.txt.",
      "ContentView.swift\nSessionView.swift\nToolCallView.swift",
      "SessionView.swift\nToolCallView.swift",
      "SessionView.swift:4: struct SessionView: View {",
      "Copy completed.",
      "Created and started scratch-preview.",
      "Started scratch-preview.",
      "Stopped scratch-preview and saved its changes.",
      "scratch-preview [linux] attached",
      "Destroyed scratch-preview.",
      "Published scratch-preview as preview-base.",
      "Started background command bg-preview on scratch-preview.",
      "bg-preview [running] target=scratch-preview cwd=/ $ printf ready; sleep 300",
      "bg-preview [running]\nready",
      "Stopped background command bg-preview.",
      "Spawned subagent Preview review (sub-preview).",
      "Subagents: 1 active, 0 dormant\nActive subagents:\n  Preview review (sub-preview)",
      "Preview review (sub-preview)\nThe sample view review is complete.",
      "Dismissed Preview review (sub-preview); its saved conversation is retained.",
      "Sent follow-up message to Preview review (sub-preview).",
      "Sent notification to parent.",
      "Goal report submitted. The independent evaluator will decide after this turn ends."
    ]
    """#)
    static let additionalToolResults: [NativeMessage] = zip(additionalToolCalls, additionalToolOutput).map { call, output in
        var result = message(role: "toolResult", content: .blocks([text(output)]), toolCallId: call.id, toolName: call.name, isError: false)
        if call.name == "copy" {
            result.details = .copy(CopyDetails(
                display: "Copy completed",
                source: CopyEndpoint(target: "local", path: "/sample/project/notes.txt", requestedPath: "notes.txt"),
                destination: CopyEndpoint(target: "scratch-preview", path: "/workspace/notes.txt", requestedPath: "/workspace/notes.txt"),
                sourceIsDirectory: false, overwrite: false, permissionFiltered: false
            ))
        } else if call.name == "dismiss_subagent" {
            result.details = .dismissSubagent(decode(#"{"id":"sub-preview","name":"Preview review","status":"idle","dormant":true}"#))
        } else if call.name == "message_subagent" {
            result.details = .messageSubagent(decode(#"{"id":"sub-preview","name":"Preview review","delivery":"followUp","reactivated":false,"status":"running","message":"Summarize the review findings."}"#))
        } else if call.name == "vm_create" {
            result.details = .vmCreate(decode(#"{"display":"Created and started scratch-preview\nvm: rw\ntarget: scratch-preview [exec]","vm":{"id":"scratch-preview","os":"linux"},"target":{"id":"scratch-preview","network":false,"execCapable":true},"parameters":{"os":"linux","network":false}}"#))
        } else if call.name == "edit" {
            result.details = .edit(EditDetails(diff: "-1 Hello\n+1 Hello, Pi", patch: "--- notes.txt\n+++ notes.txt\n@@ -1 +1 @@\n-Hello\n+Hello, Pi\n", firstChangedLine: 1))
        } else if call.name == "ls" {
            result.details = .ls(LsDetails(truncation: nil, entryLimitReached: nil,
                path: "/workspace/Pi/UI", target: "local",
                entries: ["ContentView.swift", "SessionView.swift", "ToolCallView.swift"].map {
                    FileToolEntry(name: $0, path: "/workspace/Pi/UI/\($0)", kind: "file")
                }, returnedCount: 3, truncated: false))
        } else if call.name == "find" {
            result.details = .find(FindDetails(truncation: nil, resultLimitReached: nil,
                path: "/workspace/Pi/UI", target: "local", pattern: "**/*.swift",
                entries: ["SessionView.swift", "ToolCallView.swift"].map {
                    FileToolEntry(name: $0, path: "/workspace/Pi/UI/\($0)", kind: "unknown")
                }, returnedCount: 2, truncated: false))
        } else if call.name == "grep" {
            result.details = .grep(decode(#"{"path":"/workspace/Pi/UI","target":"local","pattern":"SessionView","isDirectory":true,"entries":[{"name":"SessionView.swift","path":"/workspace/Pi/UI/SessionView.swift","line":4,"text":"struct SessionView: View {","match":true}],"returnedCount":1,"truncated":false}"#))
        }
        return result
    }

    static let editMultipleCall: ToolCall = decode(#"""
    {"id":"edit-multiple","name":"edit","arguments":{"target":"build-host","path":"/workspace/Sources/Example.swift","edits":[{"oldText":"let first = 1","newText":"let first = 2"},{"oldText":"let last = false","newText":"let last = true"}]}}
    """#)
    static let editMultipleResult: NativeMessage = {
        var result = message(role: "toolResult", content: .blocks([text("Successfully replaced 2 blocks in Sources/Example.swift.")]),
                             toolCallId: "edit-multiple", toolName: "edit", isError: false)
        result.details = .edit(EditDetails(
            diff: "  1 import Foundation\n- 2 let first = 1\n+ 2 let first = 2\n  3 // context 3\n  4 // context 4\n  5 // context 5\n  6 // context 6\n    ...\n 16 // context 16\n 17 // context 17\n 18 // context 18\n 19 // context 19\n-20 let last = false\n+20 let last = true",
            patch: nil, firstChangedLine: 2
        ))
        return result
    }()
    static let editFailureResult = message(
        role: "toolResult", content: .blocks([text("Could not find the exact old text in Sources/Example.swift.")]),
        toolCallId: "edit-multiple", toolName: "edit", isError: true
    )

    // Message-kind and edge-case samples for individual message previews and tests.
    static let records: [NativeRecord] = {
        var records: [NativeRecord] = []
        func append(_ id: String, _ message: NativeMessage) {
            records.append(entry(id, parent: records.last?.id, message: message))
        }
        append("message-0", message(role: "user", content: .text("Let's build a native Mac interface. This sample should show every kind of session item.")))
        append("message-1", message(role: "assistant", content: .blocks([
            text("I'll inspect the interface first.")
        ] + nativeToolCalls.prefix(5).map(NativeContent.toolCall)), stopReason: "toolUse"))
        for (index, result) in nativeToolResults.enumerated() { append("tool-\(index)", result) }
        append("message-2", message(role: "user", content: .text("Show thinking, tool failures, and native fallback content too.")))
        records.append(entry("custom-entry", parent: records.last?.id, message: nil, type: "custom_message",
                             customType: "extension.notice", content: .text("A displayed native custom entry.")))
        records.append(entry("custom-unavailable", parent: records.last?.id, message: nil, type: "custom_message", customType: "extension.notice"))
        let fallbacks: [NativeMessage] = decode("""
        [
          {"role":"custom","customType":"extension.message","display":true,"content":"A custom message role."},
          {"role":"bashExecution","command":"pwd","output":"/sample/project","exitCode":0},
          {"role":"compactionSummary","summary":"Earlier work was summarized by the native session."},
          {"role":"assistant","omitted":{"reason":"Message exceeds the transfer size limit"}},
          {"role":"nativeNotice"},
          {"role":"assistant","content":"A partial answer before an error.","errorMessage":"The provider response ended unexpectedly."},
          {"role":"toolResult","toolName":"read","toolCallId":"unavailable-call","content":"A result whose original call is outside the known history segment."}
        ]
        """)
        for (index, fallback) in fallbacks.enumerated() { append("fallback-\(index)", fallback) }
        append("thinking", message(role: "assistant", content: .blocks([thinking("I should compare the available options before answering.")])))
        append("redacted", message(role: "assistant", content: .blocks([thinking("REDACTED_PREVIEW_PAYLOAD", redacted: true)])))
        append("media", message(role: "assistant", content: .blocks([
            .image(ImageContent(data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png")),
            .unsupported(type: "audio")
        ])))
        append("message-3", message(role: "assistant", content: .blocks([text(markdown)]), stopReason: "stop"))
        append("mixed", message(role: "assistant", content: .blocks([
            text("The answer starts with normal prose."),
            thinking("I should check **all cases** before choosing an approach."),
            text("The answer continues **without** inheriting the thinking style.")
        ]), stopReason: "stop"))
        return records
    }()

    // One useful, successful example per registered tool in the full Session preview.
    // The root/window and Session previews share this same normal catalog chain.
    static let allToolRecords: [NativeRecord] = {
        var expanded = [
            entry("catalog-user", parent: nil, message: message(role: "user", content: .text("Show one normal example of every available tool."))),
            entry("catalog-intro", parent: "catalog-user", message: message(role: "assistant", content: .blocks([
                text("Here are the available tools, starting with file operations."),
                thinking("Each example should be separate and easy to inspect.")
            ])))
        ]
        for tool in toolCalls {
            let callEntry = "message-" + tool.call.id
            expanded.append(entry(callEntry, parent: expanded.last?.id,
                                  message: message(role: "assistant", content: .blocks([.toolCall(tool.call)]), stopReason: "toolUse")))
            expanded.append(entry("result-" + tool.call.id, parent: callEntry, message: tool.result!))
        }
        return expanded
    }()
    static let allToolMessages = SessionMessage.project(
        sessionID: "interface", records: allToolRecords, leafID: allToolRecords.last?.id, partial: nil
    )

    static let streamingPartial = message(role: "assistant", content: .blocks([
        thinking("I'll inspect the next file while keeping this reasoning distinct."),
        text("Now reading the next file…"),
        .toolCall(nativeToolCalls[5])
    ]))
    static let streamingMessages = SessionMessage.project(
        sessionID: "interface", records: allToolRecords, leafID: allToolRecords.last?.id, partial: streamingPartial
    )
    static let inputRequests: [LinkInteraction] = [
        LinkInteraction(id: "input", kind: "input", arguments: .text(title: "Name the result", detail: "A short name")),
        LinkInteraction(id: "select", kind: "select", arguments: .select(title: "Choose an output style", choices: ["Concise", "Detailed"])),
        LinkInteraction(id: "editor", kind: "editor", arguments: .text(title: "Edit the notes", detail: "Keep the existing behavior.\nReview each state in the preview.")),
        LinkInteraction(id: "custom", kind: "custom", arguments: .fallback([.string("Extension-specific interface")]))
    ]

    static let live = LinkLive(
        sessionName: "Build the Mac interface", leafId: allToolRecords.last?.id, streaming: false, idle: true, partial: nil,
        model: LinkModel(provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5"),
        catalog: [
            LinkModel(provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5"),
            LinkModel(provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5")
        ],
        thinking: "medium",
        thinkingLevels: ["off", "minimal", "low", "medium", "high"]
    )
    static let header: NativeRecord = decode("""
    {"type":"session","version":3,"id":"interface","timestamp":"2026-06-01T12:00:00.000Z","cwd":"/"}
    """)
    static let snapshot = LinkSnapshot(
        sessionId: "interface", seq: 0, header: header, entries: allToolRecords, leafId: allToolRecords.last?.id, live: live,
        pendingRequests: [], operations: [], control: control, cwd: "/"
    )
    static let messages = SessionMessage.project(
        sessionID: "interface", records: records, leafID: records.last?.id, partial: nil
    )
    static let pendingInteraction = LinkInteraction(
        id: "permission-1", kind: "confirm",
        arguments: .text(title: "Allow network access?", detail: "The command requests network access.")
    )

    #if os(macOS)
    @MainActor static func daemonStore() -> DaemonSessionStore {
        let store = DaemonSessionStore()
        store.sessions = sessions
        store.selectedID = snapshot.sessionId
        store.snapshot = snapshot
        store.records = snapshot.entries
        store.live = snapshot.live
        store.leafID = snapshot.leafId
        store.control = snapshot.control
        store.messages = .init(allToolMessages)
        store.sidebarSummaries[snapshot.sessionId] = SessionSidebarSummary(
            name: snapshot.live.sessionName,
            preview: SessionSidebarSummary.latestMessage(in: store.messages), modified: sessions.first?.modifiedDate,
            messageCount: snapshot.entries.lazy.filter { $0.type == "message" }.count
        )
        store.connected = true
        // A watching session: real views and state, but no transport or controller authority.
        // The root preview disables automatic connection.
        return store
    }
    #endif

    static let toolCalls: [NativeToolPresentation] = {
        let calls = [nativeToolCalls[0], nativeToolCalls[1], nativeToolCalls[4]] + additionalToolCalls
        let results = nativeToolResults + additionalToolResults
        let order = [
            "read", "write", "edit", "ls", "find", "grep",
            "copy", "bash", "bg_start", "bg_list", "bg_status", "bg_stop",
            "vm_create", "vm_start", "vm_list", "vm_stop", "vm_publish", "vm_destroy",
            "spawn_subagent", "list_subagents", "inspect_subagent", "message_subagent", "dismiss_subagent", "notify_parent",
            "capabilities", "goal_report"
        ]
        return order.map { name in
            let call = calls.first { $0.name == name }!
            return NativeToolPresentation(call: call, result: results.first { $0.toolCallId == call.id }!)
        }
    }()

    private static func thinking(_ value: String, redacted: Bool = false) -> NativeContent {
        .thinking(ThinkingContent(thinking: value, thinkingSignature: nil, redacted: redacted))
    }

    private static func text(_ value: String) -> NativeContent {
        .text(TextContent(text: value, textSignature: nil))
    }

    private static func message(role: String, content: NativeMessageContent, stopReason: String? = nil,
                                toolCallId: String? = nil, toolName: String? = nil, isError: Bool? = nil) -> NativeMessage {
        NativeMessage(
            role: role, content: content, timestamp: 1_780_315_200_000,
            api: role == "assistant" ? "anthropic-messages" : nil,
            provider: role == "assistant" ? "anthropic" : nil,
            model: role == "assistant" ? "claude-sonnet-4-5" : nil,
            responseModel: nil, responseId: nil, usage: role == "assistant" ? usage : nil,
            stopReason: stopReason, errorMessage: nil, rawStopReason: nil, endTurn: nil,
            toolCallId: toolCallId, toolName: toolName, isError: isError, addedToolNames: nil,
            customType: nil, display: nil, command: nil, output: nil, exitCode: nil,
            cancelled: nil, truncated: nil, fullOutputPath: nil, excludeFromContext: nil,
            summary: nil, fromId: nil, tokensBefore: nil, omitted: nil
        )
    }

    private static let usage = NativeUsage(
        input: 100, output: 80, cacheRead: 0, cacheWrite: 0, cacheWrite1h: nil, reasoning: nil, totalTokens: 180,
        cost: .init(input: 0.0003, output: 0.0012, cacheRead: 0, cacheWrite: 0, total: 0.0015)
    )

    private static func entry(_ id: String, parent: String?, message: NativeMessage?, type: String = "message",
                              customType: String? = nil, content: NativeMessageContent? = nil) -> NativeRecord {
        NativeRecord(
            type: type, id: id, parentId: parent, timestamp: "2026-06-01T12:00:00.000Z", message: message,
            version: nil, cwd: nil, parentSession: nil, customType: customType, display: type == "custom_message" ? true : nil, content: content,
            thinkingLevel: nil, provider: nil, modelId: nil, summary: nil, firstKeptEntryId: nil,
            tokensBefore: nil, fromId: nil, fromHook: nil, usage: nil, targetId: nil, label: nil, name: nil
        )
    }

    private static func decode<T: Decodable>(_ source: String) -> T {
        // Fail visibly if a wire fixture stops matching its concrete Codable model.
        try! JSONDecoder().decode(T.self, from: Data(source.utf8))
    }
}
