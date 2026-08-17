import Foundation

// Observations of registered tool schemas, not executable requests. Optional fields
// preserve streaming arguments. Unknown keys or invalid values use the passive
// fallback rather than losing diagnostics or rejecting an entire native message.
nonisolated protocol ObservedToolPayload: Codable { static var payloadKeys: Set<String> { get } }
nonisolated struct PayloadKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}
private nonisolated func decodePayload<T: ObservedToolPayload>(_ type: T.Type, from decoder: any Decoder) throws -> T {
    let container = try decoder.container(keyedBy: PayloadKey.self)
    let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(T.payloadKeys)
    guard unknown.isEmpty else {
        throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
    }
    return try T(from: decoder)
}

public nonisolated struct WriteArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let target: String?
    public let path: String?
    public let content: String?
    public let contents: String?
    static let payloadKeys: Set<String> = ["target", "path", "content", "contents"]
}

public nonisolated struct EditArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let target: String?
    public let path: String?
    public let file_path: String?
    public let edits: [EditReplacement]?
    public let oldText: String?
    public let newText: String?
    static let payloadKeys: Set<String> = ["target", "path", "file_path", "edits", "oldText", "newText"]
}

public nonisolated struct EditReplacement: Sendable, Codable, Equatable, ObservedToolPayload {
    public let oldText: String?
    public let newText: String?
    static let payloadKeys: Set<String> = ["oldText", "newText"]
}

public nonisolated struct CopyArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let sourceTarget: String?
    public let sourcePath: String?
    public let destTarget: String?
    public let destPath: String?
    public let overwrite: Bool?
    static let payloadKeys: Set<String> = ["sourceTarget", "sourcePath", "destTarget", "destPath", "overwrite"]
}

public nonisolated struct FindArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let target: String?
    public let pattern: String?
    public let path: String?
    public let limit: Double?
    static let payloadKeys: Set<String> = ["target", "pattern", "path", "limit"]
}

public nonisolated struct GrepArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let target: String?
    public let pattern: String?
    public let path: String?
    public let glob: String?
    public let ignoreCase: Bool?
    public let literal: Bool?
    public let context: Double?
    public let limit: Double?
    static let payloadKeys: Set<String> = ["target", "pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"]
}

public nonisolated struct LsArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let target: String?
    public let path: String?
    public let limit: Double?
    static let payloadKeys: Set<String> = ["target", "path", "limit"]
}

public nonisolated struct VMCreateArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let os: String?
    public let name: String?
    public let base: String?
    public let network: Bool?
    public let options: VMBootOptions?
    static let payloadKeys: Set<String> = ["os", "name", "base", "network", "options"]
}

public nonisolated struct VMBootOptions: Sendable, Codable, Equatable, ObservedToolPayload {
    public let cpuCount: Int?
    public let ramMiB: Int?
    static let payloadKeys: Set<String> = ["cpuCount", "ramMiB"]
}

public nonisolated struct VMStartArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let vmId: String?
    public let network: Bool?
    public let sip: String?
    public let options: VMBootOptions?
    static let payloadKeys: Set<String> = ["vmId", "network", "sip", "options"]
}

public nonisolated struct TargetArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let target: String?
    static let payloadKeys: Set<String> = ["target"]
}

public nonisolated struct VMIDArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let vmId: String?
    static let payloadKeys: Set<String> = ["vmId"]
}

public nonisolated struct VMPublishArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let target: String?
    public let name: String?
    static let payloadKeys: Set<String> = ["target", "name"]
}

public nonisolated struct SpawnSubagentArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let instructions: String?
    public let name: String?
    public let model: String?
    public let thinkingLevel: String?
    static let payloadKeys: Set<String> = ["instructions", "name", "model", "thinkingLevel"]
}

public nonisolated struct ListSubagentsArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let includeDormant: Bool?
    static let payloadKeys: Set<String> = ["includeDormant"]
}

public nonisolated struct IDArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let id: String?
    static let payloadKeys: Set<String> = ["id"]
}

public nonisolated struct MessageSubagentArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let id: String?
    public let message: String?
    public let delivery: String?
    static let payloadKeys: Set<String> = ["id", "message", "delivery"]
}

public nonisolated struct NotifyParentArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let message: String?
    static let payloadKeys: Set<String> = ["message"]
}

public nonisolated struct GoalReportArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let report: String?
    static let payloadKeys: Set<String> = ["report"]
}

public nonisolated struct BackgroundListArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let includeRead: Bool?
    public let markRead: Bool?
    static let payloadKeys: Set<String> = ["includeRead", "markRead"]
}

public nonisolated struct BackgroundStatusArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    public let id: String?
    public let tailChars: Double?
    static let payloadKeys: Set<String> = ["id", "tailChars"]
}

public nonisolated struct EmptyToolPayload: Sendable, Codable, Equatable, ObservedToolPayload {
    static let payloadKeys: Set<String> = []
}

public nonisolated struct TruncationDetails: Sendable, Codable, Equatable, ObservedToolPayload {
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
    static let payloadKeys: Set<String> = ["content", "truncated", "truncatedBy", "totalLines", "totalBytes", "outputLines", "outputBytes", "lastLinePartial", "firstLineExceedsLimit", "maxLines", "maxBytes"]
}

public nonisolated struct ReadDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let truncation: TruncationDetails?
    static let payloadKeys: Set<String> = ["truncation"]
}

public nonisolated struct BashDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let truncation: TruncationDetails?
    public let fullOutputPath: String?
    static let payloadKeys: Set<String> = ["truncation", "fullOutputPath"]
}

public nonisolated struct EditDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let diff: String?
    public let patch: String?
    public let firstChangedLine: Double?
    static let payloadKeys: Set<String> = ["diff", "patch", "firstChangedLine"]
}

public nonisolated struct FindDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let truncation: TruncationDetails?
    public let resultLimitReached: Double?
    public let path: String?
    public let target: String?
    public let pattern: String?
    public let entries: [FileToolEntry]?
    public let returnedCount: Int?
    public let truncated: Bool?
    static let payloadKeys: Set<String> = ["truncation", "resultLimitReached", "path", "target", "pattern", "entries", "returnedCount", "truncated"]
}

public nonisolated struct LsDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let truncation: TruncationDetails?
    public let entryLimitReached: Double?
    public let path: String?
    public let target: String?
    public let entries: [FileToolEntry]?
    public let returnedCount: Int?
    public let truncated: Bool?
    static let payloadKeys: Set<String> = ["truncation", "entryLimitReached", "path", "target", "entries", "returnedCount", "truncated"]
}

public nonisolated struct GrepDetails: Sendable, Codable, Equatable, ObservedToolPayload {
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
    static let payloadKeys: Set<String> = ["truncation", "matchLimitReached", "linesTruncated", "path", "target", "pattern", "isDirectory", "entries", "returnedCount", "truncated"]
}

public nonisolated struct CopyDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let display: String?
    public let source: CopyEndpoint?
    public let destination: CopyEndpoint?
    public let sourceIsDirectory: Bool?
    public let overwrite: Bool?
    public let permissionFiltered: Bool?
    static let payloadKeys: Set<String> = ["display", "source", "destination", "sourceIsDirectory", "overwrite", "permissionFiltered"]
}

public nonisolated struct CopyEndpoint: Sendable, Codable, Equatable, ObservedToolPayload {
    public let target: String?
    public let path: String?
    public let requestedPath: String?
    static let payloadKeys: Set<String> = ["target", "path", "requestedPath"]
}

public nonisolated struct VMCreateDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let vm: CreatedVM?
    public let target: CreatedTarget?
    public let parameters: VMCreateArguments?
    public let display: String?
    static let payloadKeys: Set<String> = ["vm", "target", "parameters", "display"]
}

public nonisolated struct CreatedVM: Sendable, Codable, Equatable, ObservedToolPayload {
    public let id: String?
    public let os: String?
    static let payloadKeys: Set<String> = ["id", "os"]
}

public nonisolated struct CreatedTarget: Sendable, Codable, Equatable, ObservedToolPayload {
    public let id: String?
    public let network: Bool?
    public let execCapable: Bool?
    static let payloadKeys: Set<String> = ["id", "network", "execCapable"]
}

public nonisolated struct DisplayToolDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let display: String?
    static let payloadKeys: Set<String> = ["display"]
}

public nonisolated struct SubagentToolDetails: Sendable, Codable, Equatable, ObservedToolPayload {
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
    static let payloadKeys: Set<String> = ["id", "name", "status", "dormant", "model", "thinkingLevel", "display", "error", "delivery", "reactivated", "message", "instructions", "queuedSteering", "queuedFollowUp", "recoveredInput"]
}

public nonisolated struct SubagentRecoveredInput: Sendable, Codable, Equatable, ObservedToolPayload {
    public let steering: [String]?
    public let followUp: [String]?
    static let payloadKeys: Set<String> = ["steering", "followUp"]
}

public nonisolated struct ListSubagentsDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let agents: [SubagentToolDetails]?
    public let display: String?
    static let payloadKeys: Set<String> = ["agents", "display"]
}

public nonisolated struct GoalReportDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let goalId: String?
    public let report: String?
    static let payloadKeys: Set<String> = ["goalId", "report"]
}

public nonisolated struct CapabilitiesDetails: Sendable, Codable, Equatable, ObservedToolPayload {
    public let capabilities: ToolCapabilities?
    public let display: String?
    static let payloadKeys: Set<String> = ["capabilities", "display"]
}

public nonisolated struct ToolCapabilities: Sendable, Codable, Equatable, ObservedToolPayload {
    public let files: [PermissionsSnapshot.Scope]?
    public let systemPaths: [CapabilitySystemPath]?
    public let network: String?
    public let vms: [CapabilityVM]?
    public let sshTargets: [PermissionsSnapshot.SSHTarget]?
    public let execGrants: [PermissionsSnapshot.ExecGrant]?
    public let runningTargets: [CapabilityTarget]?
    public let tools: [String]?
    static let payloadKeys: Set<String> = ["files", "systemPaths", "network", "vms", "sshTargets", "execGrants", "runningTargets", "tools"]
}

public nonisolated struct CapabilitySystemPath: Sendable, Codable, Equatable, ObservedToolPayload {
    public let path: String?
    public let mode: String?
    public let label: String?
    static let payloadKeys: Set<String> = ["path", "mode", "label"]
}

public nonisolated struct CapabilityVM: Sendable, Codable, Equatable, ObservedToolPayload {
    public let id: String?
    public let os: String?
    public let mode: String?
    public let networkGrant: Bool?
    public let attachment: String?
    public let execCapable: Bool?
    public let network: Bool?
    static let payloadKeys: Set<String> = ["id", "os", "mode", "networkGrant", "attachment", "execCapable", "network"]
}

public nonisolated struct CapabilityTarget: Sendable, Codable, Equatable, ObservedToolPayload {
    public let id: String?
    public let kind: String?
    public let execCapable: Bool?
    public let network: Bool?
    public let vmId: String?
    public let vmExec: CapabilityVMExecution?
    public let mounts: [PermissionsSnapshot.Mount]?
    static let payloadKeys: Set<String> = ["id", "kind", "execCapable", "network", "vmId", "vmExec", "mounts"]
}

public nonisolated struct CapabilityVMExecution: Sendable, Codable, Equatable, ObservedToolPayload {
    public let status: String?
    public let blockedReason: String?
    static let payloadKeys: Set<String> = ["status", "blockedReason"]
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
            case "read": self = .read(try decodePayload(ReadArguments.self, from: decoder))
            case "bash": self = .bash(try decodePayload(BashArguments.self, from: decoder))
            case "bg_start": self = .bgStart(try decodePayload(BashArguments.self, from: decoder))
            case "write": self = .write(try decodePayload(WriteArguments.self, from: decoder))
            case "edit": self = .edit(try decodePayload(EditArguments.self, from: decoder))
            case "copy": self = .copy(try decodePayload(CopyArguments.self, from: decoder))
            case "find": self = .find(try decodePayload(FindArguments.self, from: decoder))
            case "grep": self = .grep(try decodePayload(GrepArguments.self, from: decoder))
            case "ls": self = .ls(try decodePayload(LsArguments.self, from: decoder))
            case "vm_create": self = .vmCreate(try decodePayload(VMCreateArguments.self, from: decoder))
            case "vm_start": self = .vmStart(try decodePayload(VMStartArguments.self, from: decoder))
            case "vm_stop": self = .vmStop(try decodePayload(TargetArguments.self, from: decoder))
            case "vm_destroy": self = .vmDestroy(try decodePayload(VMIDArguments.self, from: decoder))
            case "vm_publish": self = .vmPublish(try decodePayload(VMPublishArguments.self, from: decoder))
            case "vm_list": self = .vmList(try decodePayload(EmptyToolPayload.self, from: decoder))
            case "capabilities": self = .capabilities(try decodePayload(EmptyToolPayload.self, from: decoder))
            case "spawn_subagent": self = .spawnSubagent(try decodePayload(SpawnSubagentArguments.self, from: decoder))
            case "list_subagents": self = .listSubagents(try decodePayload(ListSubagentsArguments.self, from: decoder))
            case "inspect_subagent": self = .inspectSubagent(try decodePayload(IDArguments.self, from: decoder))
            case "dismiss_subagent": self = .dismissSubagent(try decodePayload(IDArguments.self, from: decoder))
            case "message_subagent": self = .messageSubagent(try decodePayload(MessageSubagentArguments.self, from: decoder))
            case "notify_parent": self = .notifyParent(try decodePayload(NotifyParentArguments.self, from: decoder))
            case "goal_report": self = .goalReport(try decodePayload(GoalReportArguments.self, from: decoder))
            case "bg_list": self = .bgList(try decodePayload(BackgroundListArguments.self, from: decoder))
            case "bg_status": self = .bgStatus(try decodePayload(BackgroundStatusArguments.self, from: decoder))
            case "bg_stop": self = .bgStop(try decodePayload(IDArguments.self, from: decoder))
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
    case bgList(EmptyToolPayload)
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
            case "read": self = .read(try decodePayload(ReadDetails.self, from: decoder))
            case "bash": self = .bash(try decodePayload(BashDetails.self, from: decoder))
            case "write": self = .write(try decodePayload(EmptyToolPayload.self, from: decoder))
            case "edit": self = .edit(try decodePayload(EditDetails.self, from: decoder))
            case "copy": self = .copy(try decodePayload(CopyDetails.self, from: decoder))
            case "find": self = .find(try decodePayload(FindDetails.self, from: decoder))
            case "grep": self = .grep(try decodePayload(GrepDetails.self, from: decoder))
            case "ls": self = .ls(try decodePayload(LsDetails.self, from: decoder))
            case "vm_create": self = .vmCreate(try decodePayload(VMCreateDetails.self, from: decoder))
            case "vm_start": self = .vmStart(try decodePayload(DisplayToolDetails.self, from: decoder))
            case "vm_publish": self = .vmPublish(try decodePayload(DisplayToolDetails.self, from: decoder))
            case "vm_stop": self = .vmStop(try decodePayload(EmptyToolPayload.self, from: decoder))
            case "vm_destroy": self = .vmDestroy(try decodePayload(EmptyToolPayload.self, from: decoder))
            case "vm_list": self = .vmList(try decodePayload(EmptyToolPayload.self, from: decoder))
            case "bg_start": self = .bgStart(try decodePayload(DisplayToolDetails.self, from: decoder))
            case "bg_list": self = .bgList(try decodePayload(EmptyToolPayload.self, from: decoder))
            case "bg_status": self = .bgStatus(try decodePayload(EmptyToolPayload.self, from: decoder))
            case "bg_stop": self = .bgStop(try decodePayload(EmptyToolPayload.self, from: decoder))
            case "spawn_subagent": self = .spawnSubagent(try decodePayload(SubagentToolDetails.self, from: decoder))
            case "inspect_subagent": self = .inspectSubagent(try decodePayload(SubagentToolDetails.self, from: decoder))
            case "dismiss_subagent": self = .dismissSubagent(try decodePayload(SubagentToolDetails.self, from: decoder))
            case "message_subagent": self = .messageSubagent(try decodePayload(SubagentToolDetails.self, from: decoder))
            case "list_subagents": self = .listSubagents(try decodePayload(ListSubagentsDetails.self, from: decoder))
            case "notify_parent": self = .notifyParent(try decodePayload(NotifyParentArguments.self, from: decoder))
            case "goal_report": self = .goalReport(try decodePayload(GoalReportDetails.self, from: decoder))
            case "capabilities": self = .capabilities(try decodePayload(CapabilitiesDetails.self, from: decoder))
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
    var bgListValue: EmptyToolPayload? { if case .bgList(let value) = self { value } else { nil } }
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
            if fields["redacted"] == .bool(true) { fields["thinking"] = .string("[Redacted thinking]") }
            return .object(fields)
        case .array(let values): return .array(values.map(\.presentationRedacted))
        default: return self
        }
    }
}

nonisolated extension WriteArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        content = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "content")!)
        contents = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "contents")!)
    }
}

nonisolated extension EditArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        oldText = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "oldText")!)
        newText = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "newText")!)
    }
}

nonisolated extension CopyArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        pattern = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "pattern")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        limit = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "limit")!)
    }
}

nonisolated extension GrepArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        limit = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "limit")!)
    }
}

nonisolated extension VMCreateArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        cpuCount = try container.decodeIfPresent(Int.self, forKey: PayloadKey(stringValue: "cpuCount")!)
        ramMiB = try container.decodeIfPresent(Int.self, forKey: PayloadKey(stringValue: "ramMiB")!)
    }
}

nonisolated extension VMStartArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        vmId = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "vmId")!)
        network = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "network")!)
        sip = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "sip")!)
        options = try container.decodeIfPresent(VMBootOptions.self, forKey: PayloadKey(stringValue: "options")!)
    }
}

nonisolated extension TargetArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
    }
}

nonisolated extension VMIDArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        vmId = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "vmId")!)
    }
}

nonisolated extension VMPublishArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        name = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "name")!)
    }
}

nonisolated extension SpawnSubagentArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        instructions = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "instructions")!)
        name = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "name")!)
        model = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "model")!)
        thinkingLevel = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "thinkingLevel")!)
    }
}

nonisolated extension ListSubagentsArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        includeDormant = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "includeDormant")!)
    }
}

nonisolated extension IDArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
    }
}

nonisolated extension MessageSubagentArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        message = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "message")!)
        delivery = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "delivery")!)
    }
}

nonisolated extension NotifyParentArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        message = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "message")!)
    }
}

nonisolated extension GoalReportArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        report = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "report")!)
    }
}

nonisolated extension BackgroundListArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        includeRead = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "includeRead")!)
        markRead = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "markRead")!)
    }
}

nonisolated extension BackgroundStatusArguments {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        tailChars = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "tailChars")!)
    }
}

nonisolated extension EmptyToolPayload {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
    }
}

nonisolated extension TruncationDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        truncation = try container.decodeIfPresent(TruncationDetails.self, forKey: PayloadKey(stringValue: "truncation")!)
    }
}

nonisolated extension BashDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        truncation = try container.decodeIfPresent(TruncationDetails.self, forKey: PayloadKey(stringValue: "truncation")!)
        fullOutputPath = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "fullOutputPath")!)
    }
}

nonisolated extension EditDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        diff = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "diff")!)
        patch = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "patch")!)
        firstChangedLine = try container.decodeIfPresent(Double.self, forKey: PayloadKey(stringValue: "firstChangedLine")!)
    }
}

nonisolated extension FindDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        target = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "target")!)
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        requestedPath = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "requestedPath")!)
    }
}

nonisolated extension VMCreateDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        vm = try container.decodeIfPresent(CreatedVM.self, forKey: PayloadKey(stringValue: "vm")!)
        target = try container.decodeIfPresent(CreatedTarget.self, forKey: PayloadKey(stringValue: "target")!)
        parameters = try container.decodeIfPresent(VMCreateArguments.self, forKey: PayloadKey(stringValue: "parameters")!)
        display = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "display")!)
    }
}

nonisolated extension CreatedVM {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        os = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "os")!)
    }
}

nonisolated extension CreatedTarget {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        id = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "id")!)
        network = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "network")!)
        execCapable = try container.decodeIfPresent(Bool.self, forKey: PayloadKey(stringValue: "execCapable")!)
    }
}

nonisolated extension DisplayToolDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        display = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "display")!)
    }
}

nonisolated extension SubagentToolDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        steering = try container.decodeIfPresent([String].self, forKey: PayloadKey(stringValue: "steering")!)
        followUp = try container.decodeIfPresent([String].self, forKey: PayloadKey(stringValue: "followUp")!)
    }
}

nonisolated extension ListSubagentsDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        agents = try container.decodeIfPresent([SubagentToolDetails].self, forKey: PayloadKey(stringValue: "agents")!)
        display = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "display")!)
    }
}

nonisolated extension GoalReportDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        goalId = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "goalId")!)
        report = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "report")!)
    }
}

nonisolated extension CapabilitiesDetails {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        capabilities = try container.decodeIfPresent(ToolCapabilities.self, forKey: PayloadKey(stringValue: "capabilities")!)
        display = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "display")!)
    }
}

nonisolated extension ToolCapabilities {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        path = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "path")!)
        mode = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "mode")!)
        label = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "label")!)
    }
}

nonisolated extension CapabilityVM {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: PayloadKey.self)
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
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
        let unknown = Set(container.allKeys.map(\.stringValue)).subtracting(Self.payloadKeys)
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unrecognized tool fields: " + unknown.sorted().joined(separator: ", ")))
        }
        status = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "status")!)
        blockedReason = try container.decodeIfPresent(String.self, forKey: PayloadKey(stringValue: "blockedReason")!)
    }
}
