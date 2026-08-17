import Foundation

/// Known SDK file-entry fields. Extension data and provider-owned payloads are
/// intentionally ignored by this display model; the daemon owns original history.
public nonisolated struct NativeRecord: Sendable, Codable, Equatable {
    public let type: String
    public let id: String
    public let parentId: String?
    public let timestamp: String
    public let message: NativeMessage?
    public let version: Int?
    public let cwd: String?
    public let parentSession: String?
    public let customType: String?
    public let display: Bool?
    public let content: NativeMessageContent?
    public let thinkingLevel: String?
    public let provider: String?
    public let modelId: String?
    public let summary: String?
    public let firstKeptEntryId: String?
    public let tokensBefore: Double?
    public let fromId: String?
    public let fromHook: Bool?
    public let usage: NativeUsage?
    public let targetId: String?
    public let label: String?
    public let name: String?
}

/// The SDK's message roles share this set of known fields. Optional fields also
/// allow streaming partials and the server's omitted-message marker.
public nonisolated struct NativeMessage: Sendable, Codable, Equatable {
    public let role: String?
    public let content: NativeMessageContent?
    public let timestamp: Double?
    public let api: String?
    public let provider: String?
    public let model: String?
    public let responseModel: String?
    public let responseId: String?
    public let usage: NativeUsage?
    public let stopReason: String?
    public let errorMessage: String?
    public let rawStopReason: String?
    public let endTurn: Bool?
    public let toolCallId: String?
    public let toolName: String?
    public let isError: Bool?
    public let addedToolNames: [String]?
    public let customType: String?
    public let display: Bool?
    public let command: String?
    public let output: String?
    public let exitCode: Int?
    public let cancelled: Bool?
    public let truncated: Bool?
    public let fullOutputPath: String?
    public let excludeFromContext: Bool?
    public let summary: String?
    public let fromId: String?
    public let tokensBefore: Double?
    public let omitted: OmittedValue?
    // Tool-owned result metadata, including authoritative edit diffs and capability snapshots.
    var details: ToolDetails? = nil
    // Unknown extension fields alone cross the passive JSON boundary.
    public var extensionFields: [String: LinkJSON] = [:]
}

/// Native user/custom content is a string or a content-block array on the wire.
public nonisolated enum NativeMessageContent: Sendable, Codable, Equatable {
    case text(String)
    case blocks([NativeContent])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) {
            self = .text(text)
        } else {
            self = .blocks(try container.decode([NativeContent].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let text): try container.encode(text)
        case .blocks(let blocks): try container.encode(blocks)
        }
    }
}

public nonisolated struct TextContent: Sendable, Codable, Equatable {
    public let text: String
    public let textSignature: String?
}

public nonisolated struct ThinkingContent: Sendable, Codable, Equatable {
    public let thinking: String
    public let thinkingSignature: String?
    public let redacted: Bool?
}

public nonisolated struct ImageContent: Sendable, Codable, Equatable {
    public let data: String
    public let mimeType: String
}

/// Arguments are decoded directly with the native tool-name discriminator.
public nonisolated struct ToolCall: Sendable, Codable, Equatable {
    public let id: String
    public let name: String
    public let arguments: ToolArguments?
    public let thoughtSignature: String?
    public let namespace: String?
    private nonisolated enum CodingKeys: String, CodingKey { case id, name, arguments, thoughtSignature, namespace }
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        thoughtSignature = try container.decodeIfPresent(String.self, forKey: .thoughtSignature)
        namespace = try container.decodeIfPresent(String.self, forKey: .namespace)
        arguments = container.contains(.arguments) ? try ToolArguments(toolName: name, from: container.superDecoder(forKey: .arguments)) : nil
    }
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        if encoder.userInfo[.toolPresentation] as? Bool != true {
            try container.encodeIfPresent(thoughtSignature, forKey: .thoughtSignature)
        }
        try container.encodeIfPresent(namespace, forKey: .namespace)
        try container.encodeIfPresent(arguments, forKey: .arguments)
    }
}

/// Observed arguments, not an execution request: SDK streaming tool calls may
/// contain an empty or incomplete object before required arguments arrive.
public nonisolated struct ReadArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    static let payloadKeys: Set<String> = ["target", "path", "offset", "limit"]
    public let target: String?
    public let path: String?
    public let offset: Int?
    public let limit: Int?
}

/// Observed streaming arguments; required execution fields may not yet exist.
public nonisolated struct BashArguments: Sendable, Codable, Equatable, ObservedToolPayload {
    static let payloadKeys: Set<String> = ["target", "command", "timeoutMs", "timeout", "cwd"]
    public var cwd: String? = nil
    public var timeout: Double? = nil
    public let target: String?
    public let command: String?
    public let timeoutMs: Double?
}

public nonisolated enum NativeContent: Sendable, Codable, Equatable {
    case text(TextContent)
    case thinking(ThinkingContent)
    case image(ImageContent)
    case toolCall(ToolCall)
    case unsupported(type: UnsupportedContent)

    private nonisolated enum CodingKeys: String, CodingKey { case type }

    public init(from decoder: any Decoder) throws {
        let type = (try? decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .type)) ?? "unknown"
        do {
            switch type {
            case "text": self = .text(try TextContent(from: decoder))
            case "thinking": self = .thinking(try ThinkingContent(from: decoder))
            case "image": self = .image(try ImageContent(from: decoder))
            case "toolCall": self = .toolCall(try ToolCall(from: decoder))
            default: self = .unsupported(type: UnsupportedContent(type: type, payload: try LinkJSON(from: decoder), diagnostic: nil))
            }
        } catch {
            self = .unsupported(type: UnsupportedContent(type: type, payload: try LinkJSON(from: decoder), diagnostic: String(describing: error)))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case .unsupported(let value) = self {
            try (encoder.userInfo[.toolPresentation] as? Bool == true ? value.payload.presentationRedacted : value.payload).encode(to: encoder)
            return
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let value):
            try container.encode("text", forKey: .type)
            try (encoder.userInfo[.toolPresentation] as? Bool == true ? TextContent(text: value.text, textSignature: nil) : value).encode(to: encoder)
        case .thinking(let value):
            try container.encode("thinking", forKey: .type)
            try (encoder.userInfo[.toolPresentation] as? Bool == true ? ThinkingContent(thinking: value.redacted == true ? "[Redacted thinking]" : value.thinking, thinkingSignature: nil, redacted: value.redacted) : value).encode(to: encoder)
        case .image(let value):
            try container.encode("image", forKey: .type)
            try value.encode(to: encoder)
        case .toolCall(let value):
            try container.encode("toolCall", forKey: .type)
            try value.encode(to: encoder)
        case .unsupported: break // Encoded above without creating a second container.
        }
    }
}

/// SDK result envelope shared by native history and tool execution events.
/// The tool name belongs to the containing message/event, not this envelope.
public nonisolated struct ToolResult: Sendable, Codable, Equatable {
    public let content: [NativeContent]
    public var details: ToolDetails? = nil
    public var isError: Bool? = nil
    public var terminate: Bool? = nil

    private nonisolated enum CodingKeys: String, CodingKey { case content, details, isError, terminate }

    public init(content: [NativeContent], details: ToolDetails? = nil, isError: Bool? = nil, terminate: Bool? = nil) {
        self.content = content
        self.details = details
        self.isError = isError
        self.terminate = terminate
    }

    public init(from decoder: any Decoder) throws {
        try self.init(toolName: nil, from: decoder)
    }

    public init(toolName: String?, from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        content = try container.decode([NativeContent].self, forKey: .content)
        isError = try container.decodeIfPresent(Bool.self, forKey: .isError)
        terminate = try container.decodeIfPresent(Bool.self, forKey: .terminate)
        if container.contains(.details), try !container.decodeNil(forKey: .details) {
            details = try ToolDetails(toolName: toolName, from: container.superDecoder(forKey: .details))
        }
    }
}

public nonisolated struct OmittedValue: Sendable, Codable, Equatable {
    public let reason: String
}

public nonisolated struct NativeUsage: Sendable, Codable, Equatable {
    public let input: Double
    public let output: Double
    public let cacheRead: Double
    public let cacheWrite: Double
    public let cacheWrite1h: Double?
    public let reasoning: Double?
    public let totalTokens: Double
    public let cost: Cost

    public nonisolated struct Cost: Sendable, Codable, Equatable {
        public let input: Double
        public let output: Double
        public let cacheRead: Double
        public let cacheWrite: Double
        public let total: Double
    }
}

nonisolated extension NativeMessage {
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case role, content, timestamp, api, provider, model, responseModel, responseId, usage, stopReason, errorMessage, rawStopReason, endTurn, toolCallId, toolName, isError, addedToolNames, customType, display, command, output, exitCode, cancelled, truncated, fullOutputPath, excludeFromContext, summary, fromId, tokensBefore, omitted, details
    }
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = try container.decodeIfPresent(String.self, forKey: .role)
        content = try container.decodeIfPresent(NativeMessageContent.self, forKey: .content)
        timestamp = try container.decodeIfPresent(Double.self, forKey: .timestamp)
        api = try container.decodeIfPresent(String.self, forKey: .api)
        provider = try container.decodeIfPresent(String.self, forKey: .provider)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        responseModel = try container.decodeIfPresent(String.self, forKey: .responseModel)
        responseId = try container.decodeIfPresent(String.self, forKey: .responseId)
        usage = try container.decodeIfPresent(NativeUsage.self, forKey: .usage)
        stopReason = try container.decodeIfPresent(String.self, forKey: .stopReason)
        errorMessage = try container.decodeIfPresent(String.self, forKey: .errorMessage)
        rawStopReason = try container.decodeIfPresent(String.self, forKey: .rawStopReason)
        endTurn = try container.decodeIfPresent(Bool.self, forKey: .endTurn)
        toolCallId = try container.decodeIfPresent(String.self, forKey: .toolCallId)
        toolName = try container.decodeIfPresent(String.self, forKey: .toolName)
        isError = try container.decodeIfPresent(Bool.self, forKey: .isError)
        addedToolNames = try container.decodeIfPresent([String].self, forKey: .addedToolNames)
        customType = try container.decodeIfPresent(String.self, forKey: .customType)
        display = try container.decodeIfPresent(Bool.self, forKey: .display)
        command = try container.decodeIfPresent(String.self, forKey: .command)
        output = try container.decodeIfPresent(String.self, forKey: .output)
        exitCode = try container.decodeIfPresent(Int.self, forKey: .exitCode)
        cancelled = try container.decodeIfPresent(Bool.self, forKey: .cancelled)
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated)
        fullOutputPath = try container.decodeIfPresent(String.self, forKey: .fullOutputPath)
        excludeFromContext = try container.decodeIfPresent(Bool.self, forKey: .excludeFromContext)
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
        fromId = try container.decodeIfPresent(String.self, forKey: .fromId)
        tokensBefore = try container.decodeIfPresent(Double.self, forKey: .tokensBefore)
        omitted = try container.decodeIfPresent(OmittedValue.self, forKey: .omitted)
        if container.contains(.details), try !container.decodeNil(forKey: .details) {
            details = try ToolDetails(toolName: toolName, from: container.superDecoder(forKey: .details))
        } else {
            details = nil
        }
        let extensionContainer = try decoder.container(keyedBy: PayloadKey.self)
        let known = Set(CodingKeys.allCases.map(\.rawValue))
        for key in extensionContainer.allKeys where !known.contains(key.stringValue) {
            extensionFields[key.stringValue] = try extensionContainer.decode(LinkJSON.self, forKey: key)
        }
    }
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(role, forKey: .role)
        try container.encodeIfPresent(content, forKey: .content)
        try container.encodeIfPresent(timestamp, forKey: .timestamp)
        try container.encodeIfPresent(api, forKey: .api)
        try container.encodeIfPresent(provider, forKey: .provider)
        try container.encodeIfPresent(model, forKey: .model)
        try container.encodeIfPresent(responseModel, forKey: .responseModel)
        try container.encodeIfPresent(responseId, forKey: .responseId)
        try container.encodeIfPresent(usage, forKey: .usage)
        try container.encodeIfPresent(stopReason, forKey: .stopReason)
        try container.encodeIfPresent(errorMessage, forKey: .errorMessage)
        try container.encodeIfPresent(rawStopReason, forKey: .rawStopReason)
        try container.encodeIfPresent(endTurn, forKey: .endTurn)
        try container.encodeIfPresent(toolCallId, forKey: .toolCallId)
        try container.encodeIfPresent(toolName, forKey: .toolName)
        try container.encodeIfPresent(isError, forKey: .isError)
        try container.encodeIfPresent(addedToolNames, forKey: .addedToolNames)
        try container.encodeIfPresent(customType, forKey: .customType)
        try container.encodeIfPresent(display, forKey: .display)
        try container.encodeIfPresent(command, forKey: .command)
        try container.encodeIfPresent(output, forKey: .output)
        try container.encodeIfPresent(exitCode, forKey: .exitCode)
        try container.encodeIfPresent(cancelled, forKey: .cancelled)
        try container.encodeIfPresent(truncated, forKey: .truncated)
        try container.encodeIfPresent(fullOutputPath, forKey: .fullOutputPath)
        try container.encodeIfPresent(excludeFromContext, forKey: .excludeFromContext)
        try container.encodeIfPresent(summary, forKey: .summary)
        try container.encodeIfPresent(fromId, forKey: .fromId)
        try container.encodeIfPresent(tokensBefore, forKey: .tokensBefore)
        try container.encodeIfPresent(omitted, forKey: .omitted)
        try container.encodeIfPresent(details, forKey: .details)
        var extensionContainer = encoder.container(keyedBy: PayloadKey.self)
        let values: [String: LinkJSON]
        if encoder.userInfo[.toolPresentation] as? Bool == true,
           case .object(let redacted) = LinkJSON.object(extensionFields).presentationRedacted {
            values = redacted
        } else { values = extensionFields }
        for (key, value) in values {
            // An extension cannot shadow a typed field or inject alternate identities.
            guard CodingKeys(rawValue: key) == nil else { continue }
            try extensionContainer.encode(value, forKey: PayloadKey(stringValue: key)!)
        }
    }
}

/// A genuinely unknown (or invalid known) content schema stays passive and visible.
/// String literal support preserves existing production previews of unsupported blocks.
public nonisolated struct UnsupportedContent: Sendable, Equatable, ExpressibleByStringLiteral, CustomStringConvertible {
    public let type: String
    public let payload: LinkJSON
    public let diagnostic: String?
    public var description: String { type }
    public init(stringLiteral value: String) {
        self.init(type: value, payload: .object(["type": .string(value)]), diagnostic: nil)
    }
    public init(type: String, payload: LinkJSON, diagnostic: String?) {
        self.type = type
        self.payload = payload
        self.diagnostic = diagnostic
    }
}
