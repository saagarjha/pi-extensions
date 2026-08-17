import Foundation

/// Structured JSON values for SDK/extension fields not interpreted by this client.
public nonisolated enum LinkJSON: Codable, Sendable, Equatable {
    case object([String: LinkJSON]), array([LinkJSON]), string(String), number(Double), bool(Bool), null
    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: LinkJSON].self) { self = .object(v) }
        else { self = .array(try c.decode([LinkJSON].self)) }
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(_ key: String) -> LinkJSON? { if case .object(let v) = self { v[key] } else { nil } }
    var string: String? { if case .string(let v) = self { v } else { nil } }
    var integer: Int? { if case .number(let v) = self, v.isFinite, v.rounded() == v, v >= Double(Int.min), v < Double(Int.max) { Int(v) } else { nil } }
    var array: [LinkJSON]? { if case .array(let v) = self { v } else { nil } }
}

nonisolated struct LinkControl: Codable, Sendable, Equatable {
    let controllerClientId: String?
    let controlGeneration: Int
}
nonisolated struct LinkSession: Codable, Sendable, Identifiable {
    let id: String
    let sessionId: String
    let name: String?
    let cwd: String
    let agentDir: String?
    let status: String?
    /// Other attached clients, including watchers; absent on older daemons.
    let attachedClientCount: Int?
    let fileIdentity: String?
    let firstMessage: String?
    let streaming: Bool
    let control: LinkControl
    var modified: String? = nil
    var messageCount: Int? = nil
    var modifiedDate: Date? { Self.date(from: modified) }
    static func date(from timestamp: String?) -> Date? {
        guard let timestamp else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(timestamp))
            ?? (try? Date.ISO8601FormatStyle().parse(timestamp))
    }
    static func isUnnamed(_ name: String?) -> Bool {
        name?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
    }
    static func displayTitle(_ name: String?) -> String {
        guard let name, !isUnnamed(name) else { return "Untitled session" }
        return name
    }
    var title: String { Self.displayTitle(name) }
}
nonisolated struct LinkInteraction: Decodable, Sendable, Identifiable {
    enum Arguments: Sendable {
        case text(title: String, detail: String?)
        case select(title: String, choices: [String])
        case fallback([LinkJSON])
    }
    let id: String
    let kind: String
    let arguments: Arguments
    // Extension UI options are open-ended; they are never decoded into another model.
    let options: [String: LinkJSON]?
    var title: String? {
        switch arguments {
        case .text(let title, _), .select(let title, _): title
        case .fallback(let args): args.first?.string
        }
    }
    var detail: String? { if case .text(_, let detail) = arguments { detail } else { nil } }
    var choices: [String] { if case .select(_, let choices) = arguments { choices } else { [] } }
    private enum Keys: String, CodingKey { case id, kind, args, options }
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        options = try c.decodeIfPresent([String: LinkJSON].self, forKey: .options)
        switch kind {
        case "confirm", "input", "editor":
            var args = try c.nestedUnkeyedContainer(forKey: .args)
            let title = try args.decode(String.self)
            let detail = args.isAtEnd ? nil : try args.decodeIfPresent(String.self)
            arguments = .text(title: title, detail: detail)
        case "select":
            var args = try c.nestedUnkeyedContainer(forKey: .args)
            arguments = .select(title: try args.decode(String.self), choices: try args.decode([String].self))
        default: arguments = .fallback(try c.decode([LinkJSON].self, forKey: .args))
        }
    }
    init(id: String, kind: String, arguments: Arguments, options: [String: LinkJSON]? = nil) {
        self.id = id; self.kind = kind; self.arguments = arguments; self.options = options
    }
}
nonisolated struct LinkOperation: Decodable, Sendable, Identifiable {
    enum Value: Sendable {
        case background(LinkBackgroundTaskDetail)
        case child(ChildSummary)
        case submission(Submission)
        case queue(Queue)
        case fallback(LinkJSON)
    }
    struct Submission: Decodable, Sendable {
        let child: ChildSummary
        let delivery: String
        let reactivated: Bool
    }
    struct Queue: Decodable, Sendable {
        let steering: [String]
        let followUp: [String]
    }
    struct Handoff: Decodable, Sendable {
        enum Disposition: String, Decodable, Sendable { case started, queued, handled }
        let seq: Int
        let disposition: Disposition
        let steering: [String]
        let followUp: [String]
    }
    let operationId: String
    let submissionId: String?
    let handoff: Handoff?
    let command: String?
    let status: String?
    let value: Value?
    let error: String?
    var id: String { operationId }
    private enum Keys: String, CodingKey { case operationId, submissionId, handoff, command, status, value, error }
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        operationId = try c.decode(String.self, forKey: .operationId)
        submissionId = try c.decodeIfPresent(String.self, forKey: .submissionId)
        handoff = try c.decodeIfPresent(Handoff.self, forKey: .handoff)
        command = try c.decodeIfPresent(String.self, forKey: .command)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        guard c.contains(.value), try !c.decodeNil(forKey: .value) else { value = nil; return }
        switch command {
        case "service:background:stop": value = .background(try c.decode(LinkBackgroundTaskDetail.self, forKey: .value))
        case "service:subagents:spawn", "service:subagents:dismiss": value = .child(try c.decode(ChildSummary.self, forKey: .value))
        case "service:subagents:message": value = .submission(try c.decode(Submission.self, forKey: .value))
        case "service:subagents:interrupt", "service:subagents:dequeue": value = .queue(try c.decode(Queue.self, forKey: .value))
        // Native commands can be overridden; viewControl omits the nested method.
        // Without an actual result discriminator the value remains passive.
        default: value = .fallback(try c.decode(LinkJSON.self, forKey: .value))
        }
    }
}
/// Provider and model ID together identify a model; IDs can repeat across providers.
nonisolated struct LinkModelKey: Hashable, Sendable {
    let provider: String
    let id: String
    var selectionArgument: LinkJSON { .object(["provider": .string(provider), "id": .string(id)]) }
}
nonisolated struct LinkModel: Decodable, Equatable, Sendable {
    let provider: String
    let id: String
    let name: String?
    /// Absent capability is unknown (older owner), not evidence of text-only input.
    var input: [String]? = nil
    var key: LinkModelKey { LinkModelKey(provider: provider, id: id) }
}
/// Owner-resolved native model scope; thinking scope is not a picker concern.
nonisolated struct LinkScopedModel: Decodable, Equatable, Sendable {
    let model: LinkModel
    let thinkingLevel: String?
}
/// Counts from the same owner-side idle-status bridge used by the TUI.
/// Missing/invalid counts are unknown, never interpreted as zero.
nonisolated struct LinkAsyncWork: Decodable, Equatable, Sendable {
    let background: Int?
    let subagents: Int?
    let goal: Int?
    var isClear: Bool { background == 0 && subagents == 0 && goal == 0 }
    /// Positive evidence of work; false is not evidence of idle when a count is unknown.
    var hasKnownActivity: Bool {
        [background, subagents, goal].contains { count in count.map { $0 > 0 } == true }
    }
}

nonisolated struct LinkCommand: Decodable, Equatable, Sendable {
    let name: String
    let description: String?
    let invocationName: String?
    let argumentCompletions: Bool?
    var invokedAs: String { invocationName ?? name }
}

nonisolated struct LinkCompletionItem: Decodable, Sendable {
    let value: String
    let label: String
    let description: String?
}

nonisolated struct LinkLive: Decodable, Equatable, Sendable {
    let sessionName: String?
    let leafId: String?
    let streaming: Bool
    let idle: Bool
    var partial: NativeMessage?
    var toolExecutions: [LinkToolExecution]? = nil
    let model: LinkModel?
    /// SDK ModelRuntime.getAvailableSnapshot(): readonly Model<Api>[].
    var catalog: [LinkModel]? = nil
    /// AgentSession.scopedModels, not persisted enabledModels patterns.
    var scopedModels: [LinkScopedModel] = []
    /// Match SDK 1.0.2 ModelSelectorComponent's initial scope: explicit empty
    /// scope means all available models. Decoding requires the owner scope field.
    var selectableModels: [LinkModel] {
        let available = catalog ?? []
        if scopedModels.isEmpty { return available }
        return scopedModels.map { scope in
            available.first(where: { $0.key == scope.model.key }) ?? scope.model
        }
    }
    var thinking: String? = nil
    var thinkingLevels: [String]? = nil
    var compacting: Bool? = nil
    var pendingTools: [String]? = nil
    /// Owner-reported SDK queues, not canonical native history or client outbox entries.
    var steering: [String]? = nil
    var followUp: [String]? = nil
    var asyncWork: LinkAsyncWork? = nil
    var services: LinkActivityServices? = nil
    var commands: [LinkCommand]? = nil
    /// Native owner stats, already memoized before publication. No client replay.
    var stats: LinkSessionStats? = nil
    var contextUsage: LinkContextUsage? = nil

    /// Activity-only cuts still update canonical live state and synchronously
    /// reach ActivityStore. They do not change root/pinned transcript, permission,
    /// or target presentation. Compare every remaining live/service field so
    /// commands, model capabilities, counts, unknown data, and generations retain
    /// their ordinary immediate publication. New consumers of activity values
    /// must use that activity-frame observation path too.
    func isActivityServiceOnlyUpdate(from previous: Self) -> Bool {
        guard let services, let prior = previous.services,
              let normalizedServices = prior.replacingSameGenerationActivityValues(from: services) else { return false }
        var normalized = previous
        normalized.services = normalizedServices
        return self == normalized
    }

    /// Pace only assistant partials or established tool update bodies. Compare the
    /// complete remaining value so future live fields cannot silently be delayed.
    func isStreamingPartialUpdate(from previous: LinkLive) -> Bool {
        guard streaming, previous.streaming else { return false }
        var normalized = previous
        if toolExecutions != previous.toolExecutions {
            guard let tools = toolExecutions, let oldTools = previous.toolExecutions,
                  tools.count == oldTools.count,
                  zip(tools, oldTools).allSatisfy({ next, old in
                      next.isConsistent && old.isConsistent && next.start == old.start && next.end == nil && old.end == nil &&
                      next.update != nil && old.update != nil && next.update?.args == old.update?.args
                  }) else { return false }
            normalized.toolExecutions = tools
        }
        if partial == previous.partial { return self == normalized }
        guard
              let partial, let old = previous.partial,
              partial.role == "assistant", old.role == partial.role,
              old.timestamp == partial.timestamp, old.responseId == partial.responseId,
              old.api == partial.api, old.provider == partial.provider,
              old.model == partial.model, old.responseModel == partial.responseModel,
              old.stopReason == partial.stopReason, old.rawStopReason == partial.rawStopReason,
              old.endTurn == partial.endTurn, old.errorMessage == partial.errorMessage,
              old.isError == partial.isError else { return false }
        normalized.partial = partial
        return self == normalized
    }

    var isNotificationIdle: Bool {
        idle && !streaming && compacting == false && pendingTools?.isEmpty == true && asyncWork?.isClear == true
    }
    var isNotificationBusy: Bool {
        !idle || streaming || compacting == true || pendingTools?.isEmpty == false || asyncWork?.hasKnownActivity == true
    }
}
nonisolated struct LinkSnapshot: Decodable, Sendable {
    let sessionId: String
    var ownerIncarnation: String? = nil
    let seq: Int
    let header: NativeRecord?
    var entries: [NativeRecord]
    var entryJSON: [String] = []
    struct ImmutableCut: Decodable, Sendable {
        let entryKeys: [String]
        let missingKeys: [String]
    }
    var immutable: ImmutableCut? = nil
    let leafId: String?
    let live: LinkLive
    /// Latest owner UI values; lets attachments recover the active working label.
    var uiState: [LinkIncomingFrame.UIAction]? = nil
    let pendingRequests: [LinkInteraction]
    let operations: [LinkOperation]
    let control: LinkControl
    let cwd: String
}
nonisolated struct LinkFailure: LocalizedError, Sendable {
    let message: String
    let code: String?
    var errorDescription: String? { message }
    init(_ message: String, code: String? = nil) { self.message = message; self.code = code }
    var isContextOccupied: Bool { code == "CONTEXT_OCCUPIED" || message == "CONTEXT_OCCUPIED" || message.hasPrefix("CONTEXT_OCCUPIED:") }
}


extension LinkSnapshot {
    nonisolated private enum Keys: String, CodingKey {
        case sessionId, ownerIncarnation, seq, header, entries, immutable, leafId, live, uiState, pendingRequests, operations, control, cwd
    }
    nonisolated init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        ownerIncarnation = try c.decodeIfPresent(String.self, forKey: .ownerIncarnation)
        seq = try c.decode(Int.self, forKey: .seq)
        header = try c.decodeIfPresent(NativeRecord.self, forKey: .header)
        entryJSON = try c.decode([String].self, forKey: .entries)
        entries = try LinkWireRecords.decode(entryJSON)
        immutable = try c.decode(ImmutableCut.self, forKey: .immutable)
        leafId = try c.decodeIfPresent(String.self, forKey: .leafId)
        live = try c.decode(LinkLive.self, forKey: .live)
        uiState = try c.decodeIfPresent([LinkIncomingFrame.UIAction].self, forKey: .uiState)
        pendingRequests = try c.decode([LinkInteraction].self, forKey: .pendingRequests)
        operations = try c.decode([LinkOperation].self, forKey: .operations)
        control = try c.decode(LinkControl.self, forKey: .control)
        cwd = try c.decode(String.self, forKey: .cwd)
    }
}
