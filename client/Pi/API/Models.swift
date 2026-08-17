import Foundation

// Archived snapshot/cache value models only. Active control uses SessionLinkModels.

public nonisolated struct SessionDescriptor: Sendable, Codable, Equatable, Identifiable {
    public let id: String
    public let parentId: String?
    public let nativeIdentity: String
    public let title: String?
}

public nonisolated struct Catalog: Sendable, Codable {
    public let version: Int
    public let hostId: String
    public let ownerId: String
    public let revision: Int
    public let domains: CatalogDomains
    public let sessions: [SessionDescriptor]
    public let next: Int?
}

public nonisolated struct CatalogDomains: Sendable, Codable {
    public let observes: String
    public let rootInputTracking: String
    public let events: String
}

public nonisolated struct Observation: Sendable, Codable, Equatable {
    public let nativeIdentity: String
    public let record: NativeRecord
}

public nonisolated struct Snapshot: Sendable, Codable {
    public let version: Int
    public let hostId: String
    public let ownerId: String
    public let revision: Int
    public let cutId: String
    public let descriptor: SessionDescriptor
    public let current: SessionCurrent
    public let currentMetadata: CurrentMetadata?
    public let observations: [Observation]
    public var observationCount: Int = 0
    public let history: HistoryRange?
    public let error: String?

    public var rootCurrent: RootState? { current.root }
    public var currentDomains: ServiceDomains? { current.domains }
    public var childCurrent: ChildSummary? { current.child }
}

/// Known fields published by server/root.ts.
public nonisolated struct RootState: Sendable, Codable {
    public let contextId: String
    public let sessionId: String
    public let leafId: String?
    public let cwd: String
    public let mode: String
    public let idle: Bool
    public let hasPendingMessages: Bool
    public let runId: String?
    public let runTracking: String
    public let model: Model?
    public let thinkingLevel: String
    public let activeTools: [String]
    public let contextUsage: ContextUsage?
    public let toolObservations: ToolObservations
    public let partial: PartialMessage?
    public let lastEvent: String?
    public let completionTracking: String

    public nonisolated struct Model: Sendable, Codable, Equatable {
        public let provider: String
        public let id: String
        public let name: String
    }
}

/// The server's `Range`: a pinned history generation and its hash-chain root.
public nonisolated struct HistoryRange: Sendable, Codable, Equatable {
    public let generation: String
    public let count: Int
    public let root: String
}

/// The server's `RecordRef`; bytes counts UTF-8 bytes, not Swift characters.
public nonisolated struct RecordReference: Sendable, Codable, Equatable {
    public let index: Int
    public let hash: String
    public let bytes: Int
    public let root: String
}

public nonisolated struct HistoryPage: Sendable, Codable {
    public let cutId: String
    public let sessionId: String
    public let start: Int
    public let end: Int
    public let prefixRoot: String
    public let endRoot: String
    public let records: [RecordReference]
}

public nonisolated struct BodyChunk: Sendable, Codable {
    public let hash: String
    public let offset: Int
    public let total: Int
    /// Foundation decodes the wire's base64 string into record bytes.
    public let data: Data
}

/// Root fences require leafId even when it is null. Service actions additionally
/// carry the generation of the owner from actionState.serviceGenerations.
public nonisolated struct ControlFence: Sendable, Codable, Equatable {
    public let contextId: String
    public let sessionId: String
    public let leafId: String?
    public let runId: String?
    public let serviceGeneration: String?

    public init(contextId: String, sessionId: String, leafId: String?, runId: String? = nil, serviceGeneration: String? = nil) {
        self.contextId = contextId
        self.sessionId = sessionId
        self.leafId = leafId
        self.runId = runId
        self.serviceGeneration = serviceGeneration
    }

    private nonisolated enum CodingKeys: String, CodingKey {
        case contextId, sessionId, leafId, runId, serviceGeneration
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        contextId = try container.decode(String.self, forKey: .contextId)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        // Unlike decodeIfPresent, this requires the key but accepts JSON null.
        leafId = try container.decode(String?.self, forKey: .leafId)
        runId = try container.decodeIfPresent(String.self, forKey: .runId)
        serviceGeneration = try container.decodeIfPresent(String.self, forKey: .serviceGeneration)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(contextId, forKey: .contextId)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(leafId, forKey: .leafId)
        try container.encodeIfPresent(runId, forKey: .runId)
        try container.encodeIfPresent(serviceGeneration, forKey: .serviceGeneration)
    }
}

public nonisolated struct PendingInteraction: Sendable, Codable, Equatable, Identifiable {
    public let id: String
    public let sessionId: String
    public let generation: String
    public let kind: String
    public let title: String
    public let message: String
    public let choices: [Bool]
}

public nonisolated struct SessionCurrent: Sendable, Codable {
    public let root: RootState?
    public let domains: ServiceDomains?
    public let child: ChildSummary?
    public let available: Bool?
    public let error: String?
    public let header: NativeRecord?
    public let leafId: String?
    public let partial: NativeMessage?
    public let control: String?
    public let availability: String?
    public let activation: String?
}

/// Snapshot metadata has root control fields, but not the service generations
/// advertised by the separate /v1/control ActionState.
public nonisolated struct CurrentMetadata: Sendable, Codable {
    public let fence: ControlFence?
    public let operations: [String]?
    public let inputFormat: String?
    public let dispatchTracking: String?
    public let ownerId: String?
    public let persistence: String?
}

public nonisolated struct ContextUsage: Sendable, Codable {
    public let tokens: Double?
    public let contextWindow: Double
    public let percent: Double?
}

public nonisolated struct PartialMessage: Sendable, Codable {
    public let state: String
    public let message: NativeMessage
}

public nonisolated struct ToolObservations: Sendable, Codable {
    public let state: String
    public let persistence: String
    public let entries: [ToolObservation]
}

public nonisolated struct ToolObservation: Sendable, Codable {
    public let toolCallId: String
    public let toolName: String
    public let partialResult: ToolResult?
    public let omitted: OmittedValue?
}

public nonisolated struct ServiceDomains: Sendable, Codable {
    public let subagents: SubagentsDomain?
    public let permissions: PermissionsDomain?

    public nonisolated struct SubagentsDomain: Sendable, Codable {
        public let generation: String
        public let value: [ChildSummary]
    }
    public nonisolated struct PermissionsDomain: Sendable, Codable {
        public let generation: String
        public let value: PermissionState
    }
}

public nonisolated struct ChildSummary: Sendable, Codable, Equatable, Identifiable {
    public let controlRevision: Int
    public let nativeIdentity: String?
    public let sourceFile: String?
    public let id: String
    public let name: String
    public let status: String
    public let dormant: Bool
    public let createdAt: Double
    public let updatedAt: Double
    public let model: Model?
    public let thinkingLevel: String?
    public let error: String?

    public nonisolated struct Model: Sendable, Codable, Equatable {
        public let provider: String
        public let id: String
    }
}

public nonisolated struct PermissionState: Sendable, Codable, Equatable {
    public let revision: Int
    public let permissions: PermissionsSnapshot
}

public nonisolated struct PermissionsSnapshot: Sendable, Codable, Equatable {
    public let scopes: [Scope]
    public let vms: [VMScope]
    public let execGrants: [ExecGrant]
    public let sshTargets: [SSHTarget]
    public let network: String?
    public let targets: [RunningTarget]

    public nonisolated struct Scope: Sendable, Codable, Equatable {
        public let path: String
        public let mode: String
    }
    public nonisolated struct VMScope: Sendable, Codable, Equatable {
        public let vmId: String
        public let mode: String
        public let network: Bool?
    }
    public nonisolated struct ExecGrant: Sendable, Codable, Equatable {
        public let target: String
        public let command: String
        public let mode: String
    }
    public nonisolated struct SSHTarget: Sendable, Codable, Equatable {
        public let id: String
        public let destination: String
        public let port: Int?
    }
    public nonisolated struct RunningTarget: Sendable, Codable, Equatable {
        public let id: String
        public let kind: String
        public let vm: VM?
        public let mounts: [Mount]
        public let network: Bool
        public let exec: Bool
        public var hostFilesystem: HostFilesystem? = nil
    }
    public nonisolated struct HostFilesystem: Sendable, Codable, Equatable {
        public let kind: String
        public let root: String
    }
    public nonisolated struct VM: Sendable, Codable, Equatable {
        public let id: String
        public let name: String?
        public let kind: String?
        public let sip: String?
        public let published: Bool?
    }
    public nonisolated struct Mount: Sendable, Codable, Equatable {
        public let hostPath: String
        public let guestPath: String
        public let mode: String
        public let logicalHostPath: String?
        public let permissionSession: String?
    }
}

