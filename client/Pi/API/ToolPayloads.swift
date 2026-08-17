import Foundation

// Observations of registered tool schemas, not executable requests. Optional fields
// preserve streaming arguments. Decode declared fields normally; additional keys
// do not affect presentation. Invalid known values use the passive fallback.
nonisolated struct PayloadKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// Observed arguments, not an execution request: SDK streaming tool calls may
/// contain an empty or incomplete object before required arguments arrive.
public nonisolated struct ReadArguments: Sendable, Codable, Equatable {
    public let target: String?
    public let path: String?
    public let offset: Int?
    public let limit: Int?
}

/// Observed streaming arguments; required execution fields may not yet exist.
public nonisolated struct BashArguments: Sendable, Codable, Equatable {
    public var cwd: String? = nil
    public var timeout: Double? = nil
    public let target: String?
    public let command: String?
    public let timeoutMs: Double?
}

public nonisolated struct WriteArguments: Sendable, Codable, Equatable {
    public let target: String?
    public let path: String?
    public let content: String?
    public let contents: String?
}

public nonisolated struct EditArguments: Sendable, Codable, Equatable {
    public let target: String?
    public let path: String?
    public let file_path: String?
    public let edits: [EditReplacement]?
    public let oldText: String?
    public let newText: String?
}

public nonisolated struct EditReplacement: Sendable, Codable, Equatable {
    public let oldText: String?
    public let newText: String?
}

public nonisolated struct CopyArguments: Sendable, Codable, Equatable {
    public let sourceTarget: String?
    public let sourcePath: String?
    public let destTarget: String?
    public let destPath: String?
    public let overwrite: Bool?
}

public nonisolated struct FindArguments: Sendable, Codable, Equatable {
    public let target: String?
    public let pattern: String?
    public let path: String?
    public let limit: Double?
}

public nonisolated struct GrepArguments: Sendable, Codable, Equatable {
    public let target: String?
    public let pattern: String?
    public let path: String?
    public let glob: String?
    public let ignoreCase: Bool?
    public let literal: Bool?
    public let context: Double?
    public let limit: Double?
}

public nonisolated struct LsArguments: Sendable, Codable, Equatable {
    public let target: String?
    public let path: String?
    public let limit: Double?
}

public nonisolated struct VMCreateArguments: Sendable, Codable, Equatable {
    public let os: String?
    public let name: String?
    public let base: String?
    public let network: Bool?
    public let options: VMBootOptions?
}

public nonisolated struct VMBootOptions: Sendable, Codable, Equatable {
    public let cpuCount: Int?
    public let ramMiB: Int?
}

public nonisolated struct VMStartArguments: Sendable, Codable, Equatable {
    public let vmId: String?
    public let network: Bool?
    public let sip: String?
    public let options: VMBootOptions?
}

public nonisolated struct TargetArguments: Sendable, Codable, Equatable {
    public let target: String?
}

public nonisolated struct VMIDArguments: Sendable, Codable, Equatable {
    public let vmId: String?
}

public nonisolated struct VMPublishArguments: Sendable, Codable, Equatable {
    public let target: String?
    public let name: String?
}

public nonisolated struct SpawnSubagentArguments: Sendable, Codable, Equatable {
    public let instructions: String?
    public let name: String?
    public let model: String?
    public let thinkingLevel: String?
}

public nonisolated struct ListSubagentsArguments: Sendable, Codable, Equatable {
    public let includeDismissed: Bool?
    public let includeDormant: Bool?
}

public nonisolated struct IDArguments: Sendable, Codable, Equatable {
    public let id: String?
}

public nonisolated struct MessageSubagentArguments: Sendable, Codable, Equatable {
    public let id: String?
    public let message: String?
    public let delivery: String?
}

public nonisolated struct NotifyParentArguments: Sendable, Codable, Equatable {
    public let message: String?
}

public nonisolated struct GoalReportArguments: Sendable, Codable, Equatable {
    public let report: String?
}

public nonisolated struct BackgroundListArguments: Sendable, Codable, Equatable {
    public let includeRead: Bool?
    public let markRead: Bool?
}

public nonisolated struct BackgroundStatusArguments: Sendable, Codable, Equatable {
    public let id: String?
    public let tailChars: Double?
}

public nonisolated struct EmptyToolPayload: Sendable, Codable, Equatable {
}

public nonisolated struct TruncationDetails: Sendable, Codable, Equatable {
    public let content: String?
    public let truncated: Bool?
    public let truncatedBy: String?
    public let totalLines: Double?
    public let totalBytes: Double?
    public let outputLines: Double?
    public let outputBytes: Double?
    public let lastLinePartial: Bool?
    public let firstLineExceedsLimit: Bool?
    public let maxLines: Double?
    public let maxBytes: Double?
}

public nonisolated struct ReadDetails: Sendable, Codable, Equatable {
    public let truncation: TruncationDetails?
}

public nonisolated struct BashDetails: Sendable, Codable, Equatable {
    public let truncation: TruncationDetails?
    public let fullOutputPath: String?
}

public nonisolated struct EditDetails: Sendable, Codable, Equatable {
    public let diff: String?
    public let patch: String?
    public let firstChangedLine: Double?
}

public nonisolated struct FindDetails: Sendable, Codable, Equatable {
    public let truncation: TruncationDetails?
    public let resultLimitReached: Double?
    public let path: String?
    public let target: String?
    public let pattern: String?
    public let entries: [FileToolEntry]?
    public let returnedCount: Int?
    public let truncated: Bool?
}

public nonisolated struct LsDetails: Sendable, Codable, Equatable {
    public let truncation: TruncationDetails?
    public let entryLimitReached: Double?
    public let path: String?
    public let target: String?
    public let entries: [FileToolEntry]?
    public let returnedCount: Int?
    public let truncated: Bool?
}

public nonisolated struct GrepDetails: Sendable, Codable, Equatable {
    public let truncation: TruncationDetails?
    public let matchLimitReached: Double?
    public let linesTruncated: Bool?
    public let path: String?
    public let target: String?
    public let pattern: String?
    public let isDirectory: Bool?
    public let entries: [GrepToolEntry]?
    public let returnedCount: Int?
    public let truncated: Bool?
}

public nonisolated struct CopyDetails: Sendable, Codable, Equatable {
    public let display: String?
    public let source: CopyEndpoint?
    public let destination: CopyEndpoint?
    public let sourceIsDirectory: Bool?
    public let overwrite: Bool?
    public let permissionFiltered: Bool?
}

public nonisolated struct CopyEndpoint: Sendable, Codable, Equatable {
    public let target: String?
    public let path: String?
    public let requestedPath: String?
}

public nonisolated struct VMCreateDetails: Sendable, Codable, Equatable {
    public let vm: CreatedVM?
    public let target: CreatedTarget?
    public let parameters: VMCreateArguments?
    public let display: String?
}

public nonisolated struct CreatedVM: Sendable, Codable, Equatable {
    public let id: String?
    public let os: String?
}

public nonisolated struct CreatedTarget: Sendable, Codable, Equatable {
    public let id: String?
    public let network: Bool?
    public let execCapable: Bool?
}

public nonisolated struct DisplayToolDetails: Sendable, Codable, Equatable {
    public let display: String?
}

public nonisolated struct SubagentToolDetails: Sendable, Codable, Equatable {
    public let id: String?
    public let name: String?
    public let status: String?
    public let dormant: Bool?
    public let model: String?
    public let thinkingLevel: String?
    public let display: String?
    public let error: String?
    public let delivery: String?
    public let reactivated: Bool?
    public let message: String?
    public let instructions: String?
    public let queuedSteering: [String]?
    public let queuedFollowUp: [String]?
    public let recoveredInput: SubagentRecoveredInput?
}

public nonisolated struct SubagentRecoveredInput: Sendable, Codable, Equatable {
    public let steering: [String]?
    public let followUp: [String]?
}

public nonisolated struct ListSubagentsDetails: Sendable, Codable, Equatable {
    public let agents: [SubagentToolDetails]?
    public let display: String?
}

public nonisolated struct BackgroundListJob: Sendable, Codable, Equatable {
    public let id: String
    public let status: String
    public let target: String
    public let cwd: String
    public let command: String
    public let exitCode: Int?
    public let completionRead: Bool?
}

public nonisolated struct BackgroundListDetails: Sendable, Codable, Equatable {
    // Nil jobs denotes an older result with only textual content.
    public let jobs: [BackgroundListJob]?
    public let unreadCompletionIds: [String]?
}

public nonisolated struct GoalReportDetails: Sendable, Codable, Equatable {
    public let goalId: String?
    public let report: String?
}

public nonisolated struct CapabilitiesDetails: Sendable, Codable, Equatable {
    public let capabilities: ToolCapabilities?
    public let display: String?
}

public nonisolated struct ToolCapabilities: Sendable, Codable, Equatable {
    public let files: [PermissionsSnapshot.Scope]?
    public let systemPaths: [CapabilitySystemPath]?
    public let network: String?
    public let vms: [CapabilityVM]?
    public let sshTargets: [PermissionsSnapshot.SSHTarget]?
    public let execGrants: [PermissionsSnapshot.ExecGrant]?
    public let runningTargets: [CapabilityTarget]?
    public let tools: [String]?
}

public nonisolated struct CapabilitySystemPath: Sendable, Codable, Equatable {
    public let path: String?
    public let mode: String?
    public let label: String?
}

public nonisolated struct CapabilityVM: Sendable, Codable, Equatable {
    public let id: String?
    public let os: String?
    public let mode: String?
    public let networkGrant: Bool?
    public let attachment: String?
    public let execCapable: Bool?
    public let network: Bool?
}

public nonisolated struct CapabilityTarget: Sendable, Codable, Equatable {
    public let id: String?
    public let kind: String?
    public let execCapable: Bool?
    public let network: Bool?
    public let vmId: String?
    public let vmExec: CapabilityVMExecution?
    public let mounts: [PermissionsSnapshot.Mount]?
}

public nonisolated struct CapabilityVMExecution: Sendable, Codable, Equatable {
    public let status: String?
    public let blockedReason: String?
}

/// Shared by find and ls; moved out of their private renderer models.
public nonisolated struct FileToolEntry: Sendable, Codable, Equatable {
    public let name: String
    public let path: String
    public let kind: String
    var symbol: String {
        switch kind { case "directory": "folder"; case "file": "doc"; case "symlink": "link"; default: "questionmark.square" }
    }
}
public nonisolated struct GrepToolEntry: Sendable, Codable, Equatable {
    public let name: String
    public let path: String
    public let line: Int
    public let text: String
    public let match: Bool
}

public nonisolated enum ToolArguments: Sendable, Equatable, Encodable {
    case read(ReadArguments)
    case bash(BashArguments)
    case bgStart(BashArguments)
    case write(WriteArguments)
    case edit(EditArguments)
    case copy(CopyArguments)
    case find(FindArguments)
    case grep(GrepArguments)
    case ls(LsArguments)
    case vmCreate(VMCreateArguments)
    case vmStart(VMStartArguments)
    case vmStop(TargetArguments)
    case vmDestroy(VMIDArguments)
    case vmPublish(VMPublishArguments)
    case vmList(EmptyToolPayload)
    case capabilities(EmptyToolPayload)
    case spawnSubagent(SpawnSubagentArguments)
    case listSubagents(ListSubagentsArguments)
    case inspectSubagent(IDArguments)
    case dismissSubagent(IDArguments)
    case messageSubagent(MessageSubagentArguments)
    case notifyParent(NotifyParentArguments)
    case goalReport(GoalReportArguments)
    case bgList(BackgroundListArguments)
    case bgStatus(BackgroundStatusArguments)
    case bgStop(IDArguments)
    case fallback(LinkJSON, diagnostic: String?)

    public init(toolName: String?, from decoder: any Decoder) throws {
        do {
            switch toolName {
            case "read": self = .read(try ReadArguments(from: decoder))
            case "bash": self = .bash(try BashArguments(from: decoder))
            case "bg_start": self = .bgStart(try BashArguments(from: decoder))
            case "write": self = .write(try WriteArguments(from: decoder))
            case "edit": self = .edit(try EditArguments(from: decoder))
            case "copy": self = .copy(try CopyArguments(from: decoder))
            case "find": self = .find(try FindArguments(from: decoder))
            case "grep": self = .grep(try GrepArguments(from: decoder))
            case "ls": self = .ls(try LsArguments(from: decoder))
            case "vm_create": self = .vmCreate(try VMCreateArguments(from: decoder))
            case "vm_start": self = .vmStart(try VMStartArguments(from: decoder))
            case "vm_stop": self = .vmStop(try TargetArguments(from: decoder))
            case "vm_destroy": self = .vmDestroy(try VMIDArguments(from: decoder))
            case "vm_publish": self = .vmPublish(try VMPublishArguments(from: decoder))
            case "vm_list": self = .vmList(try EmptyToolPayload(from: decoder))
            case "capabilities": self = .capabilities(try EmptyToolPayload(from: decoder))
            case "spawn_subagent": self = .spawnSubagent(try SpawnSubagentArguments(from: decoder))
            case "list_subagents": self = .listSubagents(try ListSubagentsArguments(from: decoder))
            case "inspect_subagent": self = .inspectSubagent(try IDArguments(from: decoder))
            case "dismiss_subagent": self = .dismissSubagent(try IDArguments(from: decoder))
            case "message_subagent": self = .messageSubagent(try MessageSubagentArguments(from: decoder))
            case "notify_parent": self = .notifyParent(try NotifyParentArguments(from: decoder))
            case "goal_report": self = .goalReport(try GoalReportArguments(from: decoder))
            case "bg_list": self = .bgList(try BackgroundListArguments(from: decoder))
            case "bg_status": self = .bgStatus(try BackgroundStatusArguments(from: decoder))
            case "bg_stop": self = .bgStop(try IDArguments(from: decoder))
            default: self = .fallback(try LinkJSON(from: decoder), diagnostic: nil)
            }
        } catch {
            self = .fallback(try LinkJSON(from: decoder), diagnostic: String(describing: error))
        }
    }
    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .read(let value): try value.encode(to: encoder)
        case .bash(let value): try value.encode(to: encoder)
        case .bgStart(let value): try value.encode(to: encoder)
        case .write(let value): try value.encode(to: encoder)
        case .edit(let value): try value.encode(to: encoder)
        case .copy(let value): try value.encode(to: encoder)
        case .find(let value): try value.encode(to: encoder)
        case .grep(let value): try value.encode(to: encoder)
        case .ls(let value): try value.encode(to: encoder)
        case .vmCreate(let value): try value.encode(to: encoder)
        case .vmStart(let value): try value.encode(to: encoder)
        case .vmStop(let value): try value.encode(to: encoder)
        case .vmDestroy(let value): try value.encode(to: encoder)
        case .vmPublish(let value): try value.encode(to: encoder)
        case .vmList(let value): try value.encode(to: encoder)
        case .capabilities(let value): try value.encode(to: encoder)
        case .spawnSubagent(let value): try value.encode(to: encoder)
        case .listSubagents(let value): try value.encode(to: encoder)
        case .inspectSubagent(let value): try value.encode(to: encoder)
        case .dismissSubagent(let value): try value.encode(to: encoder)
        case .messageSubagent(let value): try value.encode(to: encoder)
        case .notifyParent(let value): try value.encode(to: encoder)
        case .goalReport(let value): try value.encode(to: encoder)
        case .bgList(let value): try value.encode(to: encoder)
        case .bgStatus(let value): try value.encode(to: encoder)
        case .bgStop(let value): try value.encode(to: encoder)
        case .fallback(let value, _):
            try (encoder.userInfo[.toolPresentation] as? Bool == true ? value.presentationRedacted : value).encode(to: encoder)
        }
    }
    var isFallback: Bool { if case .fallback = self { true } else { false } }
    var readValue: ReadArguments? { if case .read(let value) = self { value } else { nil } }
    var bashValue: BashArguments? { if case .bash(let value) = self { value } else { nil } }
    var bgStartValue: BashArguments? { if case .bgStart(let value) = self { value } else { nil } }
    var writeValue: WriteArguments? { if case .write(let value) = self { value } else { nil } }
    var editValue: EditArguments? { if case .edit(let value) = self { value } else { nil } }
    var copyValue: CopyArguments? { if case .copy(let value) = self { value } else { nil } }
    var findValue: FindArguments? { if case .find(let value) = self { value } else { nil } }
    var grepValue: GrepArguments? { if case .grep(let value) = self { value } else { nil } }
    var lsValue: LsArguments? { if case .ls(let value) = self { value } else { nil } }
    var vmCreateValue: VMCreateArguments? { if case .vmCreate(let value) = self { value } else { nil } }
    var vmStartValue: VMStartArguments? { if case .vmStart(let value) = self { value } else { nil } }
    var vmStopValue: TargetArguments? { if case .vmStop(let value) = self { value } else { nil } }
    var vmDestroyValue: VMIDArguments? { if case .vmDestroy(let value) = self { value } else { nil } }
    var vmPublishValue: VMPublishArguments? { if case .vmPublish(let value) = self { value } else { nil } }
    var vmListValue: EmptyToolPayload? { if case .vmList(let value) = self { value } else { nil } }
    var capabilitiesValue: EmptyToolPayload? { if case .capabilities(let value) = self { value } else { nil } }
    var spawnSubagentValue: SpawnSubagentArguments? { if case .spawnSubagent(let value) = self { value } else { nil } }
    var listSubagentsValue: ListSubagentsArguments? { if case .listSubagents(let value) = self { value } else { nil } }
    var inspectSubagentValue: IDArguments? { if case .inspectSubagent(let value) = self { value } else { nil } }
    var dismissSubagentValue: IDArguments? { if case .dismissSubagent(let value) = self { value } else { nil } }
    var messageSubagentValue: MessageSubagentArguments? { if case .messageSubagent(let value) = self { value } else { nil } }
    var notifyParentValue: NotifyParentArguments? { if case .notifyParent(let value) = self { value } else { nil } }
    var goalReportValue: GoalReportArguments? { if case .goalReport(let value) = self { value } else { nil } }
    var bgListValue: BackgroundListArguments? { if case .bgList(let value) = self { value } else { nil } }
    var bgStatusValue: BackgroundStatusArguments? { if case .bgStatus(let value) = self { value } else { nil } }
    var bgStopValue: IDArguments? { if case .bgStop(let value) = self { value } else { nil } }
}

public nonisolated enum ToolDetails: Sendable, Equatable, Encodable {
    case read(ReadDetails)
    case bash(BashDetails)
    case write(EmptyToolPayload)
    case edit(EditDetails)
    case copy(CopyDetails)
    case find(FindDetails)
    case grep(GrepDetails)
    case ls(LsDetails)
    case vmCreate(VMCreateDetails)
    case vmStart(DisplayToolDetails)
    case vmPublish(DisplayToolDetails)
    case vmStop(EmptyToolPayload)
    case vmDestroy(EmptyToolPayload)
    case vmList(EmptyToolPayload)
    case bgStart(DisplayToolDetails)
    case bgList(BackgroundListDetails)
    case bgStatus(EmptyToolPayload)
    case bgStop(EmptyToolPayload)
    case spawnSubagent(SubagentToolDetails)
    case inspectSubagent(SubagentToolDetails)
    case dismissSubagent(SubagentToolDetails)
    case messageSubagent(SubagentToolDetails)
    case listSubagents(ListSubagentsDetails)
    case notifyParent(NotifyParentArguments)
    case goalReport(GoalReportDetails)
    case capabilities(CapabilitiesDetails)
    case fallback(LinkJSON, diagnostic: String?)

    public init(toolName: String?, from decoder: any Decoder) throws {
        do {
            switch toolName {
            case "read": self = .read(try ReadDetails(from: decoder))
            case "bash": self = .bash(try BashDetails(from: decoder))
            case "write": self = .write(try EmptyToolPayload(from: decoder))
            case "edit": self = .edit(try EditDetails(from: decoder))
            case "copy": self = .copy(try CopyDetails(from: decoder))
            case "find": self = .find(try FindDetails(from: decoder))
            case "grep": self = .grep(try GrepDetails(from: decoder))
            case "ls": self = .ls(try LsDetails(from: decoder))
            case "vm_create": self = .vmCreate(try VMCreateDetails(from: decoder))
            case "vm_start": self = .vmStart(try DisplayToolDetails(from: decoder))
            case "vm_publish": self = .vmPublish(try DisplayToolDetails(from: decoder))
            case "vm_stop": self = .vmStop(try EmptyToolPayload(from: decoder))
            case "vm_destroy": self = .vmDestroy(try EmptyToolPayload(from: decoder))
            case "vm_list": self = .vmList(try EmptyToolPayload(from: decoder))
            case "bg_start": self = .bgStart(try DisplayToolDetails(from: decoder))
            case "bg_list": self = .bgList(try BackgroundListDetails(from: decoder))
            case "bg_status": self = .bgStatus(try EmptyToolPayload(from: decoder))
            case "bg_stop": self = .bgStop(try EmptyToolPayload(from: decoder))
            case "spawn_subagent": self = .spawnSubagent(try SubagentToolDetails(from: decoder))
            case "inspect_subagent": self = .inspectSubagent(try SubagentToolDetails(from: decoder))
            case "dismiss_subagent": self = .dismissSubagent(try SubagentToolDetails(from: decoder))
            case "message_subagent": self = .messageSubagent(try SubagentToolDetails(from: decoder))
            case "list_subagents": self = .listSubagents(try ListSubagentsDetails(from: decoder))
            case "notify_parent": self = .notifyParent(try NotifyParentArguments(from: decoder))
            case "goal_report": self = .goalReport(try GoalReportDetails(from: decoder))
            case "capabilities": self = .capabilities(try CapabilitiesDetails(from: decoder))
            default: self = .fallback(try LinkJSON(from: decoder), diagnostic: nil)
            }
        } catch {
            self = .fallback(try LinkJSON(from: decoder), diagnostic: String(describing: error))
        }
    }
    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .read(let value): try value.encode(to: encoder)
        case .bash(let value): try value.encode(to: encoder)
        case .write(let value): try value.encode(to: encoder)
        case .edit(let value): try value.encode(to: encoder)
        case .copy(let value): try value.encode(to: encoder)
        case .find(let value): try value.encode(to: encoder)
        case .grep(let value): try value.encode(to: encoder)
        case .ls(let value): try value.encode(to: encoder)
        case .vmCreate(let value): try value.encode(to: encoder)
        case .vmStart(let value): try value.encode(to: encoder)
        case .vmPublish(let value): try value.encode(to: encoder)
        case .vmStop(let value): try value.encode(to: encoder)
        case .vmDestroy(let value): try value.encode(to: encoder)
        case .vmList(let value): try value.encode(to: encoder)
        case .bgStart(let value): try value.encode(to: encoder)
        case .bgList(let value): try value.encode(to: encoder)
        case .bgStatus(let value): try value.encode(to: encoder)
        case .bgStop(let value): try value.encode(to: encoder)
        case .spawnSubagent(let value): try value.encode(to: encoder)
        case .inspectSubagent(let value): try value.encode(to: encoder)
        case .dismissSubagent(let value): try value.encode(to: encoder)
        case .messageSubagent(let value): try value.encode(to: encoder)
        case .listSubagents(let value): try value.encode(to: encoder)
        case .notifyParent(let value): try value.encode(to: encoder)
        case .goalReport(let value): try value.encode(to: encoder)
        case .capabilities(let value): try value.encode(to: encoder)
        case .fallback(let value, _):
            try (encoder.userInfo[.toolPresentation] as? Bool == true ? value.presentationRedacted : value).encode(to: encoder)
        }
    }
    var isFallback: Bool { if case .fallback = self { true } else { false } }
    var readValue: ReadDetails? { if case .read(let value) = self { value } else { nil } }
    var bashValue: BashDetails? { if case .bash(let value) = self { value } else { nil } }
    var writeValue: EmptyToolPayload? { if case .write(let value) = self { value } else { nil } }
    var editValue: EditDetails? { if case .edit(let value) = self { value } else { nil } }
    var copyValue: CopyDetails? { if case .copy(let value) = self { value } else { nil } }
    var findValue: FindDetails? { if case .find(let value) = self { value } else { nil } }
    var grepValue: GrepDetails? { if case .grep(let value) = self { value } else { nil } }
    var lsValue: LsDetails? { if case .ls(let value) = self { value } else { nil } }
    var vmCreateValue: VMCreateDetails? { if case .vmCreate(let value) = self { value } else { nil } }
    var vmStartValue: DisplayToolDetails? { if case .vmStart(let value) = self { value } else { nil } }
    var vmPublishValue: DisplayToolDetails? { if case .vmPublish(let value) = self { value } else { nil } }
    var vmStopValue: EmptyToolPayload? { if case .vmStop(let value) = self { value } else { nil } }
    var vmDestroyValue: EmptyToolPayload? { if case .vmDestroy(let value) = self { value } else { nil } }
    var vmListValue: EmptyToolPayload? { if case .vmList(let value) = self { value } else { nil } }
    var bgStartValue: DisplayToolDetails? { if case .bgStart(let value) = self { value } else { nil } }
    var bgListValue: BackgroundListDetails? { if case .bgList(let value) = self { value } else { nil } }
    var bgStatusValue: EmptyToolPayload? { if case .bgStatus(let value) = self { value } else { nil } }
    var bgStopValue: EmptyToolPayload? { if case .bgStop(let value) = self { value } else { nil } }
    var spawnSubagentValue: SubagentToolDetails? { if case .spawnSubagent(let value) = self { value } else { nil } }
    var inspectSubagentValue: SubagentToolDetails? { if case .inspectSubagent(let value) = self { value } else { nil } }
    var dismissSubagentValue: SubagentToolDetails? { if case .dismissSubagent(let value) = self { value } else { nil } }
    var messageSubagentValue: SubagentToolDetails? { if case .messageSubagent(let value) = self { value } else { nil } }
    var listSubagentsValue: ListSubagentsDetails? { if case .listSubagents(let value) = self { value } else { nil } }
    var notifyParentValue: NotifyParentArguments? { if case .notifyParent(let value) = self { value } else { nil } }
    var goalReportValue: GoalReportDetails? { if case .goalReport(let value) = self { value } else { nil } }
    var capabilitiesValue: CapabilitiesDetails? { if case .capabilities(let value) = self { value } else { nil } }
}

nonisolated extension CodingUserInfoKey {
    static let toolPresentation = CodingUserInfoKey(rawValue: "Pi.toolPresentation")!
}
nonisolated extension LinkJSON {
    var presentationRedacted: LinkJSON {
        switch self {
        case .object(let object):
            var fields = object.mapValues(\.presentationRedacted)
            for key in ["thinkingSignature", "thoughtSignature", "textSignature"] { fields.removeValue(forKey: key) }
            if fields["redacted"] == .bool(true) { fields["thinking"] = .string(ThinkingContent.redactedPlaceholder) }
            return .object(fields)
        case .array(let values): return .array(values.map(\.presentationRedacted))
        default: return self
        }
    }
}

nonisolated extension WriteArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        content = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "content")!)
        contents = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "contents")!)
    }
}

nonisolated extension EditArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        file_path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "file_path")!)
        edits = try container.decodeIfPresent([EditReplacement].self, forKey: PayloadKey(stringValue: "edits")!)
        oldText = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "oldText")!)
        newText = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "newText")!)
    }
}

nonisolated extension EditReplacement {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        oldText = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "oldText")!)
        newText = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "newText")!)
    }
}

nonisolated extension CopyArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        sourceTarget = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "sourceTarget")!)
        sourcePath = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "sourcePath")!)
        destTarget = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "destTarget")!)
        destPath = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "destPath")!)
        overwrite = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "overwrite")!)
    }
}

nonisolated extension FindArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        pattern = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "pattern")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        limit = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "limit")!)
    }
}

nonisolated extension GrepArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        pattern = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "pattern")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        glob = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "glob")!)
        ignoreCase = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "ignoreCase")!)
        literal = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "literal")!)
        context = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "context")!)
        limit = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "limit")!)
    }
}

nonisolated extension LsArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        limit = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "limit")!)
    }
}

nonisolated extension VMCreateArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        os = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "os")!)
        name = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "name")!)
        base = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "base")!)
        network = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "network")!)
        options = try container.decodeIfPresent(VMBootOptions.self, forKey: PayloadKey(stringValue: "options")!)
    }
}

nonisolated extension VMBootOptions {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        cpuCount = try container.decodeIfPresent(Int.self, forKey: PayloadKey(stringValue: "cpuCount")!)
        ramMiB = try container.decodeIfPresent(Int.self, forKey: PayloadKey(stringValue: "ramMiB")!)
    }
}

nonisolated extension VMStartArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        vmId = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "vmId")!)
        network = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "network")!)
        sip = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "sip")!)
        options = try container.decodeIfPresent(VMBootOptions.self, forKey: PayloadKey(stringValue: "options")!)
    }
}

nonisolated extension TargetArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
    }
}

nonisolated extension VMIDArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        vmId = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "vmId")!)
    }
}

nonisolated extension VMPublishArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        name = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "name")!)
    }
}

nonisolated extension SpawnSubagentArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        instructions = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "instructions")!)
        name = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "name")!)
        model = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "model")!)
        thinkingLevel = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "thinkingLevel")!)
    }
}

nonisolated extension ListSubagentsArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        includeDismissed = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "includeDismissed")!)
        includeDormant = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "includeDormant")!)
    }
}

nonisolated extension IDArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
    }
}

nonisolated extension MessageSubagentArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        message = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "message")!)
        delivery = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "delivery")!)
    }
}

nonisolated extension NotifyParentArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        message = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "message")!)
    }
}

nonisolated extension GoalReportArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        report = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "report")!)
    }
}

nonisolated extension BackgroundListArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        includeRead = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "includeRead")!)
        markRead = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "markRead")!)
    }
}

nonisolated extension BackgroundStatusArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        tailChars = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "tailChars")!)
    }
}

nonisolated extension EmptyToolPayload {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
    }
}

nonisolated extension TruncationDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        content = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "content")!)
        truncated = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "truncated")!)
        truncatedBy = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "truncatedBy")!)
        totalLines = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "totalLines")!)
        totalBytes = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "totalBytes")!)
        outputLines = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "outputLines")!)
        outputBytes = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "outputBytes")!)
        lastLinePartial = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "lastLinePartial")!)
        firstLineExceedsLimit = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "firstLineExceedsLimit")!)
        maxLines = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "maxLines")!)
        maxBytes = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "maxBytes")!)
    }
}

nonisolated extension ReadDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        truncation = try container.decodeIfPresent(TruncationDetails.self, forKey: PayloadKey(stringValue: "truncation")!)
    }
}

nonisolated extension BashDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        truncation = try container.decodeIfPresent(TruncationDetails.self, forKey: PayloadKey(stringValue: "truncation")!)
        fullOutputPath = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "fullOutputPath")!)
    }
}

nonisolated extension EditDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        diff = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "diff")!)
        patch = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "patch")!)
        firstChangedLine = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "firstChangedLine")!)
    }
}

nonisolated extension FindDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        truncation = try container.decodeIfPresent(TruncationDetails.self, forKey: PayloadKey(stringValue: "truncation")!)
        resultLimitReached = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "resultLimitReached")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        pattern = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "pattern")!)
        entries = try container.decodeIfPresent([FileToolEntry].self, forKey: PayloadKey(stringValue: "entries")!)
        returnedCount = try container.decodeIfPresent(Int.self, forKey: PayloadKey(stringValue: "returnedCount")!)
        truncated = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "truncated")!)
    }
}

nonisolated extension LsDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        truncation = try container.decodeIfPresent(TruncationDetails.self, forKey: PayloadKey(stringValue: "truncation")!)
        entryLimitReached = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "entryLimitReached")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        entries = try container.decodeIfPresent([FileToolEntry].self, forKey: PayloadKey(stringValue: "entries")!)
        returnedCount = try container.decodeIfPresent(Int.self, forKey: PayloadKey(stringValue: "returnedCount")!)
        truncated = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "truncated")!)
    }
}

nonisolated extension GrepDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        truncation = try container.decodeIfPresent(TruncationDetails.self, forKey: PayloadKey(stringValue: "truncation")!)
        matchLimitReached = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "matchLimitReached")!)
        linesTruncated = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "linesTruncated")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        pattern = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "pattern")!)
        isDirectory = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "isDirectory")!)
        entries = try container.decodeIfPresent([GrepToolEntry].self, forKey: PayloadKey(stringValue: "entries")!)
        returnedCount = try container.decodeIfPresent(Int.self, forKey: PayloadKey(stringValue: "returnedCount")!)
        truncated = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "truncated")!)
    }
}

nonisolated extension CopyDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        display = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "display")!)
        source = try container.decodeIfPresent(CopyEndpoint.self, forKey: PayloadKey(stringValue: "source")!)
        destination = try container.decodeIfPresent(CopyEndpoint.self, forKey: PayloadKey(stringValue: "destination")!)
        sourceIsDirectory = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "sourceIsDirectory")!)
        overwrite = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "overwrite")!)
        permissionFiltered = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "permissionFiltered")!)
    }
}

nonisolated extension CopyEndpoint {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        requestedPath = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "requestedPath")!)
    }
}

nonisolated extension VMCreateDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        vm = try container.decodeIfPresent(CreatedVM.self, forKey: PayloadKey(stringValue: "vm")!)
        target = try container.decodeIfPresent(CreatedTarget.self, forKey: PayloadKey(stringValue: "target")!)
        parameters = try container.decodeIfPresent(VMCreateArguments.self, forKey: PayloadKey(stringValue: "parameters")!)
        display = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "display")!)
    }
}

nonisolated extension CreatedVM {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        os = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "os")!)
    }
}

nonisolated extension CreatedTarget {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        network = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "network")!)
        execCapable = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "execCapable")!)
    }
}

nonisolated extension DisplayToolDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        display = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "display")!)
    }
}

nonisolated extension SubagentToolDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        name = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "name")!)
        status = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "status")!)
        dormant = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "dormant")!)
        model = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "model")!)
        thinkingLevel = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "thinkingLevel")!)
        display = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "display")!)
        error = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "error")!)
        delivery = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "delivery")!)
        reactivated = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "reactivated")!)
        message = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "message")!)
        instructions = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "instructions")!)
        queuedSteering = try container.decodeIfPresent([String].self, forKey: PayloadKey(stringValue: "queuedSteering")!)
        queuedFollowUp = try container.decodeIfPresent([String].self, forKey: PayloadKey(stringValue: "queuedFollowUp")!)
        recoveredInput = try container.decodeIfPresent(SubagentRecoveredInput.self, forKey: PayloadKey(stringValue: "recoveredInput")!)
    }
}

nonisolated extension SubagentRecoveredInput {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        steering = try container.decodeIfPresent([String].self, forKey: PayloadKey(stringValue: "steering")!)
        followUp = try container.decodeIfPresent([String].self, forKey: PayloadKey(stringValue: "followUp")!)
    }
}

nonisolated extension ListSubagentsDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        agents = try container.decodeIfPresent([SubagentToolDetails].self, forKey: PayloadKey(stringValue: "agents")!)
        display = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "display")!)
    }
}

nonisolated extension BackgroundListJob {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        id = try container.decode(String.self, forKey: PayloadKey(stringValue: "id")!)
        status = try container.decode(String.self, forKey: PayloadKey(stringValue: "status")!)
        target = try container.decode(String.self, forKey: PayloadKey(stringValue: "target")!)
        cwd = try container.decode(String.self, forKey: PayloadKey(stringValue: "cwd")!)
        command = try container.decode(String.self, forKey: PayloadKey(stringValue: "command")!)
        exitCode = try container.decodeIfPresent(Int.self, forKey: PayloadKey(stringValue: "exitCode")!)
        completionRead = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "completionRead")!)
    }
}

nonisolated extension BackgroundListDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        jobs = try container.decodeIfPresent([BackgroundListJob].self, forKey: PayloadKey(stringValue: "jobs")!)
        unreadCompletionIds = try container.decodeIfPresent([String].self, forKey: PayloadKey(stringValue: "unreadCompletionIds")!)
    }
}

nonisolated extension GoalReportDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        goalId = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "goalId")!)
        report = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "report")!)
    }
}

nonisolated extension CapabilitiesDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        capabilities = try container.decodeIfPresent(ToolCapabilities.self, forKey: PayloadKey(stringValue: "capabilities")!)
        display = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "display")!)
    }
}

nonisolated extension ToolCapabilities {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        files = try container.decodeIfPresent([PermissionsSnapshot.Scope].self, forKey: PayloadKey(stringValue: "files")!)
        systemPaths = try container.decodeIfPresent([CapabilitySystemPath].self, forKey: PayloadKey(stringValue: "systemPaths")!)
        network = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "network")!)
        vms = try container.decodeIfPresent([CapabilityVM].self, forKey: PayloadKey(stringValue: "vms")!)
        sshTargets = try container.decodeIfPresent([PermissionsSnapshot.SSHTarget].self, forKey: PayloadKey(stringValue: "sshTargets")!)
        execGrants = try container.decodeIfPresent([PermissionsSnapshot.ExecGrant].self, forKey: PayloadKey(stringValue: "execGrants")!)
        runningTargets = try container.decodeIfPresent([CapabilityTarget].self, forKey: PayloadKey(stringValue: "runningTargets")!)
        tools = try container.decodeIfPresent([String].self, forKey: PayloadKey(stringValue: "tools")!)
    }
}

nonisolated extension CapabilitySystemPath {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        mode = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "mode")!)
        label = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "label")!)
    }
}

nonisolated extension CapabilityVM {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        os = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "os")!)
        mode = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "mode")!)
        networkGrant = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "networkGrant")!)
        attachment = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "attachment")!)
        execCapable = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "execCapable")!)
        network = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "network")!)
    }
}

nonisolated extension CapabilityTarget {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        kind = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "kind")!)
        execCapable = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "execCapable")!)
        network = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "network")!)
        vmId = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "vmId")!)
        vmExec = try container.decodeIfPresent(CapabilityVMExecution.self, forKey: PayloadKey(stringValue: "vmExec")!)
        mounts = try container.decodeIfPresent([PermissionsSnapshot.Mount].self, forKey: PayloadKey(stringValue: "mounts")!)
    }
}

nonisolated extension CapabilityVMExecution {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        status = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "status")!)
        blockedReason = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "blockedReason")!)
    }
}
