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
          "id": "bg_k7t34e",
          "tailChars": 2000
        }
      },
      {
        "id": "catalog-bg_stop",
        "name": "bg_stop",
        "arguments": {
          "id": "bg_k7t34e"
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
      "Started background command bg_k7t34e on scratch-preview.",
      "bg_k7t34e [running] target=scratch-preview cwd=/workspace $ printf ready; sleep 300\nbg_m8r52a [done exit=0] target=local cwd=/sample/project $ echo finished\n\nUnread completion mailbox:\nbg_m8r52a [done exit=0] target=local cwd=/sample/project $ echo finished",
      "bg_k7t34e [running]\nready",
      "Stopped background command bg_k7t34e.",
      "Spawned subagent Preview review (sub-preview).",
      "Subagents: 0 running, 1 idle, 0 dismissed\nIdle subagents:\n  Preview review (sub-preview)",
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
            result.details = .dismissSubagent(decode(#"{"id":"sub-preview","name":"Preview review","status":"dismissed","dormant":true}"#))
        } else if call.name == "bg_list" {
            result.details = .bgList(decode(#"{"jobs":[{"id":"bg_k7t34e","status":"running","target":"scratch-preview","cwd":"/workspace","command":"printf ready; sleep 300","completionRead":false},{"id":"bg_m8r52a","status":"done","target":"local","cwd":"/sample/project","command":"echo finished","exitCode":0,"completionRead":false}],"unreadCompletionIds":["bg_m8r52a"]}"#))
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

    // Larger, internally coherent synthetic tool scenarios used by the catalog
    // and canonical streaming previews. No sample request is executed.
    private static let reviewedToolCalls: [ToolCall] = decode(#"""
    [
      {
        "id": "call-read",
        "name": "read",
        "arguments": {
          "target": "local",
          "path": "UI/SessionSearch.swift",
          "offset": 10,
          "limit": 28
        }
      },
      {
        "id": "catalog-write",
        "name": "write",
        "arguments": {
          "target": "local",
          "path": "Tests/SessionSearchTests.swift",
          "content": "import XCTest\n@testable import Pi\n\nfinal class SessionSearchTests: XCTestCase {\n    private let search = SessionSearch(locale: Locale(identifier: \"en_US\"))\n\n    func testWhitespaceOnlyQueryReturnsEverySession() {\n        let sessions = fixtures()\n        XCTAssertEqual(search.results(in: sessions, query: \"  \\n\").count, sessions.count)\n    }\n\n    func testMatchingIgnoresCaseAndDiacritics() {\n        let results = search.results(in: fixtures(), query: \"cafe\")\n        XCTAssertEqual(results.map(\\.title), [\"Café layout review\"])\n    }\n\n    func testNewestSessionsComeFirst() {\n        let results = search.results(in: fixtures(), query: \"\")\n        XCTAssertEqual(results.map(\\.id), [\"recent\", \"older\"])\n    }\n\n    private func fixtures() -> [SessionSummary] {\n        [\n            SessionSummary(id: \"older\", title: \"Parser review\", preview: \"Check escaped text\", updatedAt: Date(timeIntervalSince1970: 10)),\n            SessionSummary(id: \"recent\", title: \"Café layout review\", preview: \"Search results remain stable\", updatedAt: Date(timeIntervalSince1970: 20))\n        ]\n    }\n}\n"
        }
      },
      {
        "id": "catalog-edit",
        "name": "edit",
        "arguments": {
          "target": "local",
          "path": "UI/SessionSearch.swift",
          "edits": [
            {
              "oldText": "    func matches(_ session: SessionSummary, query: String) -> Bool {\n        let needle = query.lowercased()\n        return session.title.lowercased().contains(needle)\n            || session.preview.lowercased().contains(needle)\n    }\n\n    func results(in sessions: [SessionSummary], query: String) -> [SessionSummary] {\n        sessions.filter { matches($0, query: query) }\n    }",
              "newText": "    func matches(_ session: SessionSummary, query: String) -> Bool {\n        let needle = folded(query.trimmingCharacters(in: .whitespacesAndNewlines))\n        guard !needle.isEmpty else { return true }\n        return folded(session.title).contains(needle)\n            || folded(session.preview).contains(needle)\n    }\n\n    func results(in sessions: [SessionSummary], query: String) -> [SessionSummary] {\n        newestFirst(sessions.filter { matches($0, query: query) })\n    }"
            },
            {
              "oldText": "text.folding(options: [.caseInsensitive], locale: locale)",
              "newText": "text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: locale)"
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
          "limit": 50
        }
      },
      {
        "id": "catalog-find",
        "name": "find",
        "arguments": {
          "target": "local",
          "path": "UI",
          "pattern": "**/*.swift",
          "limit": 50
        }
      },
      {
        "id": "catalog-grep",
        "name": "grep",
        "arguments": {
          "target": "local",
          "path": "UI",
          "pattern": "SessionSearch",
          "glob": "**/*.swift",
          "literal": true,
          "ignoreCase": false,
          "context": 2,
          "limit": 50
        }
      },
      {
        "id": "catalog-copy",
        "name": "copy",
        "arguments": {
          "sourceTarget": "local",
          "sourcePath": "Tests",
          "destTarget": "scratch-preview",
          "destPath": "/workspace/Pi/Tests",
          "overwrite": false
        }
      },
      {
        "id": "call-bash",
        "name": "bash",
        "arguments": {
          "target": "local",
          "command": "swift test --filter SessionSearchTests",
          "timeoutMs": 600000
        }
      },
      {
        "id": "catalog-bg_start",
        "name": "bg_start",
        "arguments": {
          "target": "scratch-preview",
          "command": "swift test --filter SessionSearchTests",
          "cwd": "/workspace/Pi",
          "timeoutMs": 600000
        }
      },
      {
        "id": "catalog-bg_list",
        "name": "bg_list",
        "arguments": {
          "includeRead": false,
          "markRead": true
        }
      },
      {
        "id": "catalog-bg_status",
        "name": "bg_status",
        "arguments": {
          "id": "bg_k7t34e",
          "tailChars": 2000
        }
      },
      {
        "id": "catalog-bg_stop",
        "name": "bg_stop",
        "arguments": {
          "id": "bg_k7t34e"
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
          "vmId": "scratch-macos-preview",
          "network": false,
          "options": {
            "cpuCount": 4,
            "ramMiB": 8192
          }
        }
      },
      {
        "id": "catalog-vm_list",
        "name": "vm_list",
        "arguments": {}
      },
      {
        "id": "catalog-vm_stop",
        "name": "vm_stop",
        "arguments": {
          "target": "scratch-preview"
        }
      },
      {
        "id": "catalog-vm_publish",
        "name": "vm_publish",
        "arguments": {
          "name": "preview-base",
          "target": "scratch-preview"
        }
      },
      {
        "id": "catalog-vm_destroy",
        "name": "vm_destroy",
        "arguments": {
          "vmId": "scratch-preview"
        }
      },
      {
        "id": "catalog-spawn_subagent",
        "name": "spawn_subagent",
        "arguments": {
          "name": "Search review",
          "instructions": "Review UI/SessionSearch.swift and Tests/SessionSearchTests.swift without editing files.\n\nCheck empty and whitespace-only queries, locale-aware case/diacritic folding, stable newest-first ordering, and updates arriving while a query is active. Pay particular attention to the Unicode comparison path: the UI must not invent match ranges when normalization changes string length.\n\nReturn concrete findings with file paths and line references. Separate correctness issues from cosmetic observations, and report completion with notify_parent. Do not run tools that modify the repository.",
          "model": "claude-sonnet-4-5"
        }
      },
      {
        "id": "catalog-list_subagents",
        "name": "list_subagents",
        "arguments": {
          "includeDismissed": true
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
        "id": "catalog-message_subagent",
        "name": "message_subagent",
        "arguments": {
          "id": "sub-preview",
          "message": "Please also check the partial-argument and completed-result transition in ToolCalls/EditToolCallView.swift.\n\nThe requested edit should use the same sign/code columns as the returned diff, without invented file positions or a minimum-width gutter. Include a multiline replacement containing unchanged lines and a second independent replacement; note any text movement or disappearing labels.",
          "delivery": "followUp"
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
        "id": "catalog-notify_parent",
        "name": "notify_parent",
        "arguments": {
          "message": "Search review complete. UI/SessionSearch.swift handles whitespace-only queries and folds case/diacritics with the requested locale; results retain newest-first ordering as summaries arrive.\n\nThe edit preview now covers a multiline replacement and a second disjoint change. Requested snippets carry no invented line numbers. No repository files were modified during the review; the reported paths refer only to the synthetic sample."
        }
      },
      {
        "id": "call-capabilities",
        "name": "capabilities",
        "arguments": {}
      },
      {
        "id": "catalog-goal_report",
        "name": "goal_report",
        "arguments": {
          "report": "Completed the synthetic session-search review. Checked empty/whitespace queries, accented titles, case folding, and deterministic ordering for equal timestamps.\n\nEvidence: UI/SessionSearch.swift:13–22 and Tests/SessionSearchTests.swift:7–21. The preview exercises partial escaped strings, multiline replacements, unchanged context, and two non-overlapping edits. The final diff was computed from the same original source and requested replacements.\n\nLimitations: this is an offline parser-backed example, not a live provider capture or an executed test suite. No real tools, network requests, or filesystem edits were performed by the sample calls."
        }
      }
    ]
    """#)
    private static let reviewedToolResults: [NativeMessage] = decode(#"""
    [
      {
        "role": "toolResult",
        "toolCallId": "call-read",
        "toolName": "read",
        "content": [
          {
            "type": "text",
            "text": "struct SessionSearch {\n    let locale: Locale\n\n    func matches(_ session: SessionSummary, query: String) -> Bool {\n        let needle = query.lowercased()\n        return session.title.lowercased().contains(needle)\n            || session.preview.lowercased().contains(needle)\n    }\n\n    func results(in sessions: [SessionSummary], query: String) -> [SessionSummary] {\n        sessions.filter { matches($0, query: query) }\n    }\n\n    // Keep ordering stable while new session summaries arrive.\n    func newestFirst(_ sessions: [SessionSummary]) -> [SessionSummary] {\n        sessions.sorted { left, right in\n            if left.updatedAt == right.updatedAt {\n                return left.id < right.id\n            }\n            return left.updatedAt > right.updatedAt\n        }\n    }\n\n    private func folded(_ text: String) -> String {\n        text.folding(options: [.caseInsensitive], locale: locale)\n    }\n}"
          }
        ],
        "isError": false
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-write",
        "toolName": "write",
        "content": [
          {
            "type": "text",
            "text": "Successfully wrote to Tests/SessionSearchTests.swift"
          }
        ],
        "isError": false
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-edit",
        "toolName": "edit",
        "content": [
          {
            "type": "text",
            "text": "Successfully replaced 2 blocks in UI/SessionSearch.swift."
          }
        ],
        "isError": false,
        "details": {
          "diff": "    ...\n 10 struct SessionSearch {\n 11     let locale: Locale\n 12 \n 13     func matches(_ session: SessionSummary, query: String) -> Bool {\n-14         let needle = query.lowercased()\n-15         return session.title.lowercased().contains(needle)\n-16             || session.preview.lowercased().contains(needle)\n+14         let needle = folded(query.trimmingCharacters(in: .whitespacesAndNewlines))\n+15         guard !needle.isEmpty else { return true }\n+16         return folded(session.title).contains(needle)\n+17             || folded(session.preview).contains(needle)\n 17     }\n 18 \n 19     func results(in sessions: [SessionSummary], query: String) -> [SessionSummary] {\n-20         sessions.filter { matches($0, query: query) }\n+21         newestFirst(sessions.filter { matches($0, query: query) })\n 21     }\n 22 \n 23     // Keep ordering stable while new session summaries arrive.\n 24     func newestFirst(_ sessions: [SessionSummary]) -> [SessionSummary] {\n    ...\n 30         }\n 31     }\n 32 \n 33     private func folded(_ text: String) -> String {\n-34         text.folding(options: [.caseInsensitive], locale: locale)\n+35         text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: locale)\n 35     }\n 36 }",
          "firstChangedLine": 14,
          "patch": "--- UI/SessionSearch.swift\n+++ UI/SessionSearch.swift\n@@ -10,15 +10,16 @@\n struct SessionSearch {\n     let locale: Locale\n \n     func matches(_ session: SessionSummary, query: String) -> Bool {\n-        let needle = query.lowercased()\n-        return session.title.lowercased().contains(needle)\n-            || session.preview.lowercased().contains(needle)\n+        let needle = folded(query.trimmingCharacters(in: .whitespacesAndNewlines))\n+        guard !needle.isEmpty else { return true }\n+        return folded(session.title).contains(needle)\n+            || folded(session.preview).contains(needle)\n     }\n \n     func results(in sessions: [SessionSummary], query: String) -> [SessionSummary] {\n-        sessions.filter { matches($0, query: query) }\n+        newestFirst(sessions.filter { matches($0, query: query) })\n     }\n \n     // Keep ordering stable while new session summaries arrive.\n     func newestFirst(_ sessions: [SessionSummary]) -> [SessionSummary] {\n@@ -30,7 +31,7 @@\n         }\n     }\n \n     private func folded(_ text: String) -> String {\n-        text.folding(options: [.caseInsensitive], locale: locale)\n+        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: locale)\n     }\n }\n"
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-ls",
        "toolName": "ls",
        "content": [
          {
            "type": "text",
            "text": "Components/\nRendering/\nSessionDetailView.swift\nSessionSearch.swift\nSessionSidebar.swift\nSessionSummary.swift\nState/"
          }
        ],
        "isError": false,
        "details": {
          "path": "/workspace/Pi/UI",
          "target": "local",
          "entries": [
            {
              "name": "Components",
              "path": "/workspace/Pi/UI/Components",
              "kind": "directory"
            },
            {
              "name": "Rendering",
              "path": "/workspace/Pi/UI/Rendering",
              "kind": "directory"
            },
            {
              "name": "SessionDetailView.swift",
              "path": "/workspace/Pi/UI/SessionDetailView.swift",
              "kind": "file"
            },
            {
              "name": "SessionSearch.swift",
              "path": "/workspace/Pi/UI/SessionSearch.swift",
              "kind": "file"
            },
            {
              "name": "SessionSidebar.swift",
              "path": "/workspace/Pi/UI/SessionSidebar.swift",
              "kind": "file"
            },
            {
              "name": "SessionSummary.swift",
              "path": "/workspace/Pi/UI/SessionSummary.swift",
              "kind": "file"
            },
            {
              "name": "State",
              "path": "/workspace/Pi/UI/State",
              "kind": "directory"
            }
          ],
          "returnedCount": 7,
          "truncated": false
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-find",
        "toolName": "find",
        "content": [
          {
            "type": "text",
            "text": "Components/SearchField.swift\nComponents/SessionRow.swift\nRendering/SessionMessageView.swift\nRendering/ToolCalls/EditToolCallView.swift\nRendering/ToolCalls/FindToolCallView.swift\nRendering/ToolCalls/ToolStreamingPreview.swift\nSessionDetailView.swift\nSessionSearch.swift\nSessionSidebar.swift\nSessionSummary.swift\nState/SessionListStore.swift\nState/SessionSearchState.swift"
          }
        ],
        "isError": false,
        "details": {
          "path": "/workspace/Pi/UI",
          "target": "local",
          "pattern": "**/*.swift",
          "entries": [
            {
              "name": "Components/SearchField.swift",
              "path": "/workspace/Pi/UI/Components/SearchField.swift",
              "kind": "unknown"
            },
            {
              "name": "Components/SessionRow.swift",
              "path": "/workspace/Pi/UI/Components/SessionRow.swift",
              "kind": "unknown"
            },
            {
              "name": "Rendering/SessionMessageView.swift",
              "path": "/workspace/Pi/UI/Rendering/SessionMessageView.swift",
              "kind": "unknown"
            },
            {
              "name": "Rendering/ToolCalls/EditToolCallView.swift",
              "path": "/workspace/Pi/UI/Rendering/ToolCalls/EditToolCallView.swift",
              "kind": "unknown"
            },
            {
              "name": "Rendering/ToolCalls/FindToolCallView.swift",
              "path": "/workspace/Pi/UI/Rendering/ToolCalls/FindToolCallView.swift",
              "kind": "unknown"
            },
            {
              "name": "Rendering/ToolCalls/ToolStreamingPreview.swift",
              "path": "/workspace/Pi/UI/Rendering/ToolCalls/ToolStreamingPreview.swift",
              "kind": "unknown"
            },
            {
              "name": "SessionDetailView.swift",
              "path": "/workspace/Pi/UI/SessionDetailView.swift",
              "kind": "unknown"
            },
            {
              "name": "SessionSearch.swift",
              "path": "/workspace/Pi/UI/SessionSearch.swift",
              "kind": "unknown"
            },
            {
              "name": "SessionSidebar.swift",
              "path": "/workspace/Pi/UI/SessionSidebar.swift",
              "kind": "unknown"
            },
            {
              "name": "SessionSummary.swift",
              "path": "/workspace/Pi/UI/SessionSummary.swift",
              "kind": "unknown"
            },
            {
              "name": "State/SessionListStore.swift",
              "path": "/workspace/Pi/UI/State/SessionListStore.swift",
              "kind": "unknown"
            },
            {
              "name": "State/SessionSearchState.swift",
              "path": "/workspace/Pi/UI/State/SessionSearchState.swift",
              "kind": "unknown"
            }
          ],
          "returnedCount": 12,
          "truncated": false
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-grep",
        "toolName": "grep",
        "content": [
          {
            "type": "text",
            "text": "SessionSearch.swift-9- \nSessionSearch.swift:10: struct SessionSearch {\nSessionSearch.swift-11-     let locale: Locale\nSessionSearch.swift-12- \nSessionSearch.swift-13-     func matches(_ session: SessionSummary, query: String) -> Bool {\nSessionSidebar.swift-22-     @Environment(\\.locale) private var locale\nSessionSidebar.swift:23:     private var search: SessionSearch {\nSessionSidebar.swift:24:         SessionSearch(locale: locale)\nSessionSidebar.swift-25-     }\nSessionSidebar.swift-26- \nSessionSidebar.swift-27-     var body: some View {\nState/SessionSearchState.swift-37-     private func refreshResults() {\nState/SessionSearchState.swift:38:         let matcher = SessionSearch(locale: locale)\nState/SessionSearchState.swift-39-         visibleSessions = matcher.results(in: summaries, query: query)\nState/SessionSearchState.swift-40-         selectedID = visibleSessions.first?.id\nState/SessionSearchState.swift-41-     }"
          }
        ],
        "isError": false,
        "details": {
          "path": "/workspace/Pi/UI",
          "target": "local",
          "pattern": "SessionSearch",
          "isDirectory": true,
          "entries": [
            {
              "name": "SessionSearch.swift",
              "path": "/workspace/Pi/UI/SessionSearch.swift",
              "line": 9,
              "text": "",
              "match": false
            },
            {
              "name": "SessionSearch.swift",
              "path": "/workspace/Pi/UI/SessionSearch.swift",
              "line": 10,
              "text": "struct SessionSearch {",
              "match": true
            },
            {
              "name": "SessionSearch.swift",
              "path": "/workspace/Pi/UI/SessionSearch.swift",
              "line": 11,
              "text": "    let locale: Locale",
              "match": false
            },
            {
              "name": "SessionSearch.swift",
              "path": "/workspace/Pi/UI/SessionSearch.swift",
              "line": 12,
              "text": "",
              "match": false
            },
            {
              "name": "SessionSearch.swift",
              "path": "/workspace/Pi/UI/SessionSearch.swift",
              "line": 13,
              "text": "    func matches(_ session: SessionSummary, query: String) -> Bool {",
              "match": false
            },
            {
              "name": "SessionSidebar.swift",
              "path": "/workspace/Pi/UI/SessionSidebar.swift",
              "line": 22,
              "text": "    @Environment(\\.locale) private var locale",
              "match": false
            },
            {
              "name": "SessionSidebar.swift",
              "path": "/workspace/Pi/UI/SessionSidebar.swift",
              "line": 23,
              "text": "    private var search: SessionSearch {",
              "match": true
            },
            {
              "name": "SessionSidebar.swift",
              "path": "/workspace/Pi/UI/SessionSidebar.swift",
              "line": 24,
              "text": "        SessionSearch(locale: locale)",
              "match": true
            },
            {
              "name": "SessionSidebar.swift",
              "path": "/workspace/Pi/UI/SessionSidebar.swift",
              "line": 25,
              "text": "    }",
              "match": false
            },
            {
              "name": "SessionSidebar.swift",
              "path": "/workspace/Pi/UI/SessionSidebar.swift",
              "line": 26,
              "text": "",
              "match": false
            },
            {
              "name": "SessionSidebar.swift",
              "path": "/workspace/Pi/UI/SessionSidebar.swift",
              "line": 27,
              "text": "    var body: some View {",
              "match": false
            },
            {
              "name": "State/SessionSearchState.swift",
              "path": "/workspace/Pi/UI/State/SessionSearchState.swift",
              "line": 37,
              "text": "    private func refreshResults() {",
              "match": false
            },
            {
              "name": "State/SessionSearchState.swift",
              "path": "/workspace/Pi/UI/State/SessionSearchState.swift",
              "line": 38,
              "text": "        let matcher = SessionSearch(locale: locale)",
              "match": true
            },
            {
              "name": "State/SessionSearchState.swift",
              "path": "/workspace/Pi/UI/State/SessionSearchState.swift",
              "line": 39,
              "text": "        visibleSessions = matcher.results(in: summaries, query: query)",
              "match": false
            },
            {
              "name": "State/SessionSearchState.swift",
              "path": "/workspace/Pi/UI/State/SessionSearchState.swift",
              "line": 40,
              "text": "        selectedID = visibleSessions.first?.id",
              "match": false
            },
            {
              "name": "State/SessionSearchState.swift",
              "path": "/workspace/Pi/UI/State/SessionSearchState.swift",
              "line": 41,
              "text": "    }",
              "match": false
            }
          ],
          "returnedCount": 16,
          "truncated": false
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "call-bash",
        "toolName": "bash",
        "content": [
          {
            "type": "text",
            "text": "Building for debugging...\n[1/5] Compiling Pi SessionSearch.swift\n[2/5] Compiling PiTests SessionSearchTests.swift\n[3/5] Emitting module PiTests\n[4/5] Linking PiPackageTests\nBuild complete! (1.84s)\nTest Suite 'SessionSearchTests' started.\nTest Case 'testWhitespaceOnlyQueryReturnsEverySession' started.\nTest Case 'testWhitespaceOnlyQueryReturnsEverySession' passed (0.001 seconds).\nTest Case 'testMatchingIgnoresCaseAndDiacritics' passed (0.001 seconds).\nTest Case 'testNewestSessionsComeFirst' passed (0.001 seconds).\nTest Suite 'SessionSearchTests' passed.\nExecuted 3 tests, with 0 failures (0 unexpected) in 0.003 seconds.\n"
          }
        ],
        "isError": false
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-bg_start",
        "toolName": "bg_start",
        "content": [
          {
            "type": "text",
            "text": "Background command started: bg_k7t34e\nTarget: scratch-preview\nWorking directory: /workspace/Pi\nCommand: swift test --filter SessionSearchTests"
          }
        ],
        "isError": false
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-bg_status",
        "toolName": "bg_status",
        "content": [
          {
            "type": "text",
            "text": "bg_k7t34e [running for 4s] target=scratch-preview cwd=/workspace/Pi\n$ swift test --filter SessionSearchTests\n\nBuilding for debugging...\n[1/5] Compiling Pi SessionSearch.swift\n[2/5] Compiling PiTests SessionSearchTests.swift\n[3/5] Emitting module PiTests\n[4/5] Linking PiPackageTests\nBuild complete! (1.84s)\nTest Suite 'SessionSearchTests' started.\nTest Case 'testWhitespaceOnlyQueryReturnsEverySession' started.\n"
          }
        ],
        "isError": false
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-bg_stop",
        "toolName": "bg_stop",
        "content": [
          {
            "type": "text",
            "text": "bg_k7t34e [stopped] target=scratch-preview cwd=/workspace/Pi\n$ swift test --filter SessionSearchTests\n\nBuilding for debugging...\n[1/5] Compiling Pi SessionSearch.swift\n[2/5] Compiling PiTests SessionSearchTests.swift\n[3/5] Emitting module PiTests\n[4/5] Linking PiPackageTests\nBuild complete! (1.84s)\nTest Suite 'SessionSearchTests' started.\nTest Case 'testWhitespaceOnlyQueryReturnsEverySession' started.\n"
          }
        ],
        "isError": false
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-vm_list",
        "toolName": "vm_list",
        "content": [
          {
            "type": "text",
            "text": "scratch-preview [linux] running target=scratch-preview [exec]\nscratch-macos-preview [macos] stopped\npreview-base [linux] published, stopped\nscratch-review [linux] running target=scratch-review [exec]"
          }
        ],
        "isError": false
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-spawn_subagent",
        "toolName": "spawn_subagent",
        "content": [
          {
            "type": "text",
            "text": "Spawned subagent Search review (sub-preview) with claude-sonnet-4-5. It will notify you when it needs attention or has a result."
          }
        ],
        "isError": false,
        "details": {
          "id": "sub-preview",
          "name": "Search review",
          "status": "running",
          "dormant": false,
          "model": "claude-sonnet-4-5",
          "display": "Spawned Search review (sub-preview) [running]\nmodel: claude-sonnet-4-5\nReview UI/SessionSearch.swift and Tests/SessionSearchTests.swift without editing files.\n\nCheck empty and whitespace-only queries, locale-aware case/diacritic folding, stable newest-first ordering, and updates arriving while a query is active. Pay particular attention to the Unicode comparison path: the UI must not invent match ranges when normalization changes string length.\n\nReturn concrete findings with file paths and line references. Separate correctness issues from cosmetic observations, and report completion with notify_parent. Do not run tools that modify the repository."
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-inspect_subagent",
        "toolName": "inspect_subagent",
        "content": [
          {
            "type": "text",
            "text": "Subagent Search review (sub-preview) [idle]\nDelegated instructions (parent): Review UI/SessionSearch.swift and Tests/SessionSearchTests.swift without editing files.\n\nCheck empty and whitespace-only queries, locale-aware case/diacritic folding, stable newest-first ordering, and updates arriving while a query is active. Pay particular attention to the Unicode comparison path: the UI must not invent match ranges when normalization changes string length.\n\nReturn concrete findings with file paths and line references. Separate correctness issues from cosmetic observations, and report completion with notify_parent. Do not run tools that modify the repository.\n\nassistant: I will check query normalization, ordering, and the edit handoff.\n\nassistant: Findings:\n1. UI/SessionSearch.swift:13 trims whitespace before matching.\n2. UI/SessionSearch.swift:35 folds case and diacritics using the selected locale.\n3. Tests/SessionSearchTests.swift:7–21 covers empty queries, accented titles, and ordering.\n\nassistant: The edit preview includes unchanged lines and two disjoint replacements. The returned file positions differ from snippet-relative locations; no file positions should be invented during authoring.\n\nassistant: Review complete. No repository files changed. This is a synthetic review transcript, not an executed test run."
          }
        ],
        "isError": false,
        "details": {
          "id": "sub-preview",
          "name": "Search review",
          "status": "idle",
          "dormant": false
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-message_subagent",
        "toolName": "message_subagent",
        "content": [
          {
            "type": "text",
            "text": "Sent message to subagent Search review (sub-preview) using followUp. Status: running. Model: claude-sonnet-4-5.\n\nMessage: Please also check the partial-argument and completed-result transition in ToolCalls/EditToolCallView.swift.\n\nThe requested edit should use the same sign/code columns as the returned diff, without invented file positions or a minimum-width gutter. Include a multiline replacement containing unchanged lines and a second independent replacement; note any text movement or disappearing labels."
          }
        ],
        "isError": false,
        "details": {
          "id": "sub-preview",
          "name": "Search review",
          "message": "Please also check the partial-argument and completed-result transition in ToolCalls/EditToolCallView.swift.\n\nThe requested edit should use the same sign/code columns as the returned diff, without invented file positions or a minimum-width gutter. Include a multiline replacement containing unchanged lines and a second independent replacement; note any text movement or disappearing labels.",
          "delivery": "followUp",
          "reactivated": false,
          "status": "running"
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-notify_parent",
        "toolName": "notify_parent",
        "content": [
          {
            "type": "text",
            "text": "Sent notification to parent.\n\nMessage: Search review complete. UI/SessionSearch.swift handles whitespace-only queries and folds case/diacritics with the requested locale; results retain newest-first ordering as summaries arrive.\n\nThe edit preview now covers a multiline replacement and a second disjoint change. Requested snippets carry no invented line numbers. No repository files were modified during the review; the reported paths refer only to the synthetic sample."
          }
        ],
        "isError": false,
        "details": {
          "message": "Search review complete. UI/SessionSearch.swift handles whitespace-only queries and folds case/diacritics with the requested locale; results retain newest-first ordering as summaries arrive.\n\nThe edit preview now covers a multiline replacement and a second disjoint change. Requested snippets carry no invented line numbers. No repository files were modified during the review; the reported paths refer only to the synthetic sample."
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-goal_report",
        "toolName": "goal_report",
        "content": [
          {
            "type": "text",
            "text": "Goal report submitted:\n\nCompleted the synthetic session-search review. Checked empty/whitespace queries, accented titles, case folding, and deterministic ordering for equal timestamps.\n\nEvidence: UI/SessionSearch.swift:13–22 and Tests/SessionSearchTests.swift:7–21. The preview exercises partial escaped strings, multiline replacements, unchanged context, and two non-overlapping edits. The final diff was computed from the same original source and requested replacements.\n\nLimitations: this is an offline parser-backed example, not a live provider capture or an executed test suite. No real tools, network requests, or filesystem edits were performed by the sample calls.\n\nThe independent evaluator will decide after this turn ends."
          }
        ],
        "isError": false,
        "details": {
          "goalId": "preview-goal",
          "report": "Completed the synthetic session-search review. Checked empty/whitespace queries, accented titles, case folding, and deterministic ordering for equal timestamps.\n\nEvidence: UI/SessionSearch.swift:13–22 and Tests/SessionSearchTests.swift:7–21. The preview exercises partial escaped strings, multiline replacements, unchanged context, and two non-overlapping edits. The final diff was computed from the same original source and requested replacements.\n\nLimitations: this is an offline parser-backed example, not a live provider capture or an executed test suite. No real tools, network requests, or filesystem edits were performed by the sample calls."
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-copy",
        "toolName": "copy",
        "content": [
          {
            "type": "text",
            "text": "Copy completed."
          }
        ],
        "isError": false,
        "details": {
          "display": "Copy completed",
          "source": {
            "target": "local",
            "path": "/sample/project/Tests",
            "requestedPath": "Tests"
          },
          "destination": {
            "target": "scratch-preview",
            "path": "/workspace/Pi/Tests",
            "requestedPath": "/workspace/Pi/Tests"
          },
          "sourceIsDirectory": true,
          "overwrite": false,
          "permissionFiltered": false
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-vm_start",
        "toolName": "vm_start",
        "content": [
          {
            "type": "text",
            "text": "Started scratch-macos-preview."
          }
        ],
        "isError": false,
        "details": {
          "display": "Started scratch-macos-preview\nvm: rw\ntarget: scratch-macos-preview [exec]",
          "target": {
            "id": "scratch-macos-preview",
            "network": false,
            "execCapable": true
          }
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-dismiss_subagent",
        "toolName": "dismiss_subagent",
        "content": [
          {
            "type": "text",
            "text": "Dismissed Search review (sub-preview); its saved conversation is retained."
          }
        ],
        "isError": false,
        "details": {
          "id": "sub-preview",
          "name": "Search review",
          "status": "dismissed",
          "dormant": true
        }
      },
      {
        "role": "toolResult",
        "toolCallId": "catalog-bg_list",
        "toolName": "bg_list",
        "content": [
          {
            "type": "text",
            "text": "bg_k7t34e [running] target=scratch-preview cwd=/workspace/Pi $ swift test --filter SessionSearchTests\nbg_m2p91a [done exit=0] target=scratch-preview cwd=/workspace/Pi $ printf done\n\nUnread completion mailbox:\nbg_m2p91a [done exit=0]"
          }
        ],
        "isError": false,
        "details": {
          "jobs": [
            {
              "id": "bg_k7t34e",
              "status": "running",
              "target": "scratch-preview",
              "cwd": "/workspace/Pi",
              "command": "swift test --filter SessionSearchTests",
              "completionRead": false
            },
            {
              "id": "bg_m2p91a",
              "status": "done",
              "target": "scratch-preview",
              "cwd": "/workspace/Pi",
              "command": "printf done",
              "exitCode": 0,
              "completionRead": true
            }
          ],
          "unreadCompletionIds": [
            "bg_m2p91a"
          ]
        }
      }
    ]
    """#)

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
            let call = reviewedToolCalls.first { $0.name == name } ?? calls.first { $0.name == name }!
            let result = reviewedToolResults.first { $0.toolCallId == call.id } ?? results.first { $0.toolCallId == call.id }!
            return NativeToolPresentation(call: call, result: result)
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
