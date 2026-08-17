import Foundation

nonisolated struct LinkBackgroundTask: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let target: String
    let command: String
    let cwd: String
    let status: String
    let timeoutMs: Double?
    let exitCode: Int?
    let error: String?
    let startedAt: Double?
    let updatedAt: Double?
    let revision: Int

    var title: String { command.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? id }
    var isRunning: Bool { status == "running" }
}

nonisolated struct LinkBackgroundTaskDetail: Decodable, Identifiable, Sendable {
    let id: String
    let target: String
    let command: String
    let cwd: String
    let status: String
    let timeoutMs: Double?
    let exitCode: Int?
    let error: String?
    let startedAt: Double?
    let updatedAt: Double?
    let revision: Int
    let output: String

    var summary: LinkBackgroundTask {
        LinkBackgroundTask(id: id, target: target, command: command, cwd: cwd, status: status,
            timeoutMs: timeoutMs, exitCode: exitCode, error: error, startedAt: startedAt,
            updatedAt: updatedAt, revision: revision)
    }
}

nonisolated struct LinkSubagent: Decodable, Identifiable, Sendable, Equatable {
    struct Model: Decodable, Sendable, Equatable {
        let provider: String
        let id: String
    }
    let id: String
    let name: String
    let status: String
    let dormant: Bool
    let controlRevision: Int
    let nativeIdentity: String?
    let sourceFile: String?
    let model: Model?
    let thinkingLevel: String?
    let error: String?

    var modelLabel: String { model.map { "\($0.provider)/\($0.id)" } ?? "Model unavailable" }
}

/// Typed user edits; results use the existing revisioned PermissionState snapshot.
nonisolated enum LinkPermissionMutation: Sendable {
    enum Mode: String, Sendable, CaseIterable {
        case deny, ro, rw
        case askRO = "ask-ro", askRW = "ask-rw", roAskRW = "ro-ask-rw"
    }
    enum NetworkMode: String, Sendable, CaseIterable { case deny, ask, allow }
    enum ExecMode: String, Sendable, CaseIterable { case ask, allow }
    case setFile(path: String, mode: Mode)
    case setFiles(paths: [String], mode: Mode)
    case removeFile(path: String)
    case setVM(vmId: String, mode: Mode)
    case removeVM(vmId: String)
    case setNetwork(mode: NetworkMode)
    case setVMNetwork(vmId: String, enabled: Bool)
    case setExec(target: String, command: String, mode: ExecMode)
    case removeExec(target: String, command: String)
    /// destination uses the TUI's destination[:port] syntax. Enable network explicitly first.
    case setSSH(id: String, destination: String)
    case removeSSH(id: String)

    var json: LinkJSON {
        switch self {
        case let .setFile(path, mode):
            return .object(["kind": .string("file"), "action": .string("set"), "path": .string(path), "mode": .string(mode.rawValue)])
        case let .setFiles(paths, mode):
            return .object(["kind": .string("files"), "action": .string("set"), "paths": .array(paths.map(LinkJSON.string)), "mode": .string(mode.rawValue)])
        case let .removeFile(path):
            return .object(["kind": .string("file"), "action": .string("remove"), "path": .string(path)])
        case let .setVM(vmId, mode):
            return .object(["kind": .string("vm"), "action": .string("set"), "vmId": .string(vmId), "mode": .string(mode.rawValue)])
        case let .removeVM(vmId):
            return .object(["kind": .string("vm"), "action": .string("remove"), "vmId": .string(vmId)])
        case let .setNetwork(mode):
            return .object(["kind": .string("network"), "action": .string("set"), "mode": .string(mode.rawValue)])
        case let .setVMNetwork(vmId, enabled):
            return .object(["kind": .string("vmNetwork"), "action": .string("set"), "vmId": .string(vmId), "enabled": .bool(enabled)])
        case let .setExec(target, command, mode):
            return .object(["kind": .string("exec"), "action": .string("set"), "target": .string(target), "command": .string(command), "mode": .string(mode.rawValue)])
        case let .removeExec(target, command):
            return .object(["kind": .string("exec"), "action": .string("remove"), "target": .string(target), "command": .string(command)])
        case let .setSSH(id, destination):
            return .object(["kind": .string("ssh"), "action": .string("set"), "id": .string(id), "destination": .string(destination)])
        case let .removeSSH(id):
            return .object(["kind": .string("ssh"), "action": .string("remove"), "id": .string(id)])
        }
    }
}

nonisolated struct LinkActivityServices: Decodable, Sendable, Equatable {
    struct Background: Decodable, Sendable, Equatable {
        let serviceGeneration: String
        let jobs: [LinkBackgroundTask]?
    }
    struct Subagents: Decodable, Sendable, Equatable {
        let serviceGeneration: String
        let children: [LinkSubagent]
    }
    struct Permissions: Decodable, Sendable, Equatable {
        let serviceGeneration: String?
        let value: PermissionState
    }
    let background: Background?
    let subagents: Subagents?
    let permissions: Permissions?
    let unknown: [String: LinkJSON]

    private struct Key: CodingKey {
        let stringValue: String
        let intValue: Int? = nil
        init(_ value: String) { stringValue = value }
        init?(stringValue: String) { self.init(stringValue) }
        init?(intValue: Int) { return nil }
    }
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        background = try c.decodeIfPresent(Background.self, forKey: Key("background"))
        subagents = try c.decodeIfPresent(Subagents.self, forKey: Key("subagents"))
        permissions = try c.decodeIfPresent(Permissions.self, forKey: Key("permissions"))
        var unknown: [String: LinkJSON] = [:]
        for key in c.allKeys where !["background", "subagents", "permissions"].contains(key.stringValue) {
            unknown[key.stringValue] = try c.decode(LinkJSON.self, forKey: key)
        }
        self.unknown = unknown
    }
}
