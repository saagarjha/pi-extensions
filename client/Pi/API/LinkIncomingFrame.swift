import Foundation

/// Decoded once on the transport actor. Known payloads use the original Foundation
/// decoder; only extension-defined/unknown payloads retain passive JSON values.
nonisolated struct LinkIncomingFrame: Decodable, Sendable {
    let type: String
    let sessionId: String?
    let seq: Int?
    let payload: Payload

    private enum Keys: String, CodingKey { case type, sessionId, seq }
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        type = try c.decode(String.self, forKey: .type)
        if type == "sessionActivity" { sessionId = nil; seq = nil }
        else {
            sessionId = try c.decode(String.self, forKey: .sessionId)
            seq = try c.decode(Int.self, forKey: .seq)
        }
        payload = try Payload(from: decoder)
    }

    indirect enum Payload: Decodable, Sendable {
        case snapshot(LinkSnapshot)
        case append(NativeRecord)
        case leaf(String?)
        case live(LinkLive)
        case control(LinkControl)
        case interaction(LinkInteraction)
        case interactionResolved(String)
        case operation(LinkOperation)
        case event(SDKEvent)
        case ui(UIAction)
        case presentationChanged(String)
        case childFrame(ChildFrame)
        case childEvent(ChildEvent)
        case backgroundEvent(BackgroundEvent)
        case sessionActivity(ActivityEvent)
        case unknown(LinkJSON)

        private enum Keys: String, CodingKey {
            case type, entry, leafId, live, control, request, requestId, operation, event
        }
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            switch try c.decode(String.self, forKey: .type) {
            case "snapshot": self = .snapshot(try LinkSnapshot(from: decoder))
            case "append": self = .append(try c.decode(NativeRecord.self, forKey: .entry))
            case "leaf": self = .leaf(try c.decode(String?.self, forKey: .leafId))
            case "live": self = .live(try c.decode(LinkLive.self, forKey: .live))
            case "control": self = .control(try c.decode(LinkControl.self, forKey: .control))
            case "interaction": self = .interaction(try c.decode(LinkInteraction.self, forKey: .request))
            case "interactionResolved": self = .interactionResolved(try c.decode(String.self, forKey: .requestId))
            case "operation": self = .operation(try c.decode(LinkOperation.self, forKey: .operation))
            case "event": self = .event(try c.decode(SDKEvent.self, forKey: .event))
            case "ui": self = .ui(try UIAction(from: decoder))
            case "presentationChanged": self = .presentationChanged(try c.decode(String.self, forKey: .requestId))
            case "childFrame": self = .childFrame(try c.decode(ChildFrame.self, forKey: .event))
            case "childEvent": self = .childEvent(try c.decode(ChildEvent.self, forKey: .event))
            case "backgroundEvent": self = .backgroundEvent(try c.decode(BackgroundEvent.self, forKey: .event))
            case "sessionActivity": self = .sessionActivity(try ActivityEvent(from: decoder))
            default: self = .unknown(try LinkJSON(from: decoder))
            }
        }
    }
    enum SDKEvent: Decodable, Sendable {
        case agentStart, agentSettled
        case ignored(String)
        case unknown(type: String, payload: LinkJSON)
        var type: String {
            switch self {
            case .agentStart: "agent_start"
            case .agentSettled: "agent_settled"
            case .ignored(let type), .unknown(let type, _): type
            }
        }
        private enum Keys: String, CodingKey { case type }
        init(from decoder: any Decoder) throws {
            let type = try decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .type)
            switch type {
            case "agent_start": self = .agentStart
            case "agent_settled": self = .agentSettled
            // SDK 0.86 notifications deliberately not consumed by this UI. The
            // canonical append/live frames already provide their displayed state;
            // do not allocate duplicate messages or tool payloads here.
            case "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end",
                 "tool_execution_start", "tool_execution_update", "tool_execution_end", "queue_update",
                 "compaction_start", "compaction_end", "entry_appended", "session_info_changed",
                 "thinking_level_changed", "auto_retry_start", "auto_retry_end",
                 "summarization_retry_scheduled", "summarization_retry_attempt_start",
                 "summarization_retry_finished", "bash_execution_update":
                self = .ignored(type)
            default: self = .unknown(type: type, payload: try LinkJSON(from: decoder))
            }
        }
    }
    struct UIAction: Decodable, Sendable {
        enum Arguments: Sendable {
            case text([String?])
            case flag(Bool)
            case indicator(Indicator?)
            case widget(key: String, content: [String]?, options: WidgetOptions?)
            case fallback(LinkJSON)
        }
        struct Indicator: Decodable, Sendable { let frames: [String]?; let intervalMs: Double? }
        struct WidgetOptions: Decodable, Sendable { let placement: String? }
        let method: String
        let arguments: Arguments
        var workingMessage: String? {
            guard method == "setWorkingMessage", case .text(let values) = arguments else { return nil }
            return values.first ?? nil
        }
        private enum Keys: String, CodingKey { case method, args }
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            method = try c.decode(String.self, forKey: .method)
            switch method {
            case "notify", "setTitle", "setEditorText", "pasteToEditor", "setWorkingMessage",
                 "setHiddenThinkingLabel", "setStatus", "installClientEditor":
                arguments = .text(try c.decode([String?].self, forKey: .args))
            case "setWorkingVisible", "setToolsExpanded":
                var args = try c.nestedUnkeyedContainer(forKey: .args)
                arguments = .flag(try args.decode(Bool.self))
            case "setWorkingIndicator":
                var args = try c.nestedUnkeyedContainer(forKey: .args)
                arguments = .indicator(args.isAtEnd ? nil : try args.decodeIfPresent(Indicator.self))
            case "setWidget":
                var args = try c.nestedUnkeyedContainer(forKey: .args)
                let key = try args.decode(String.self)
                let content = args.isAtEnd ? nil : try args.decodeIfPresent([String].self)
                let options = args.isAtEnd ? nil : try args.decodeIfPresent(WidgetOptions.self)
                arguments = .widget(key: key, content: content, options: options)
            default: arguments = .fallback(try c.decode(LinkJSON.self, forKey: .args))
            }
        }
    }
    struct ChildFrame: Decodable, Sendable {
        let serviceGeneration: String
        let childId: String
        let nativeIdentity: String
        let frame: LinkIncomingFrame
    }
    struct ChildEvent: Decodable, Sendable {
        let serviceGeneration: String
        let childId: String
        let event: SDKEvent
    }
    struct BackgroundEvent: Decodable, Sendable {
        let serviceGeneration: String
        let job: LinkBackgroundTaskDetail
    }
    struct ActivityEvent: Decodable, Sendable {
        let subscriptionId: String
        let activity: LinkSessionActivity
        let baseline: Bool?
    }
}
