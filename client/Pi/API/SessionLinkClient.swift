#if os(macOS)
import Foundation

/// Tiny transport cursor, not a second snapshot/history cache. Frames alone own state.
nonisolated struct LinkFrameCursor {
    private(set) var sessionID: String?
    private(set) var sequence: Int?
    mutating func apply(_ frame: LinkIncomingFrame) throws {
        let type = frame.type
        guard let id = frame.sessionId, let seq = frame.seq else { throw LinkFailure("Malformed daemon frame") }
        if type == "snapshot" { sessionID = id; sequence = seq; return }
        guard id == sessionID else { return }
        guard let sequence, seq == sequence + 1 else { throw LinkFailure("Sequence gap. Reconnect for a fresh snapshot; commands will not replay.") }
        self.sequence = seq
    }
}

/// SSE requires empty record delimiters and CR/LF-only splitting. Foundation's
/// AsyncLineSequence drops empty lines and also splits Unicode separators.
nonisolated struct LinkSSEDecoder {
    private static let lineFeed = UInt8(ascii: "\n")
    private static let carriageReturn = UInt8(ascii: "\r")
    private static let space = UInt8(ascii: " ")
    private static let dataField = Data("data".utf8)
    private static let dataPrefix = Data("data:".utf8)
    private static let appendBatchSize = 16 * 1024

    private var line = Data()
    // Batch Foundation appends without retaining an enormous Array capacity.
    private var pendingLineBytes: [UInt8] = []
    private var payload = Data()
    private var hasDataField = false
    private var skipLineFeed = false

    mutating func append(_ byte: UInt8) -> Data? {
        if skipLineFeed {
            skipLineFeed = false
            if byte == Self.lineFeed { return nil }
        }
        guard byte == Self.lineFeed || byte == Self.carriageReturn else {
            pendingLineBytes.append(byte)
            if pendingLineBytes.count == Self.appendBatchSize { flushLineBytes() }
            return nil
        }
        flushLineBytes()
        skipLineFeed = byte == Self.carriageReturn
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            guard hasDataField else { return nil }
            // Do not retain a snapshot-sized scratch buffer after dispatching it.
            line = Data()
            let event = payload
            payload = Data()
            hasDataField = false
            return event
        }
        // A field without a colon has an empty value; remove at most one space.
        if line == Self.dataField || line.starts(with: Self.dataPrefix) {
            var value = line.dropFirst(min(Self.dataPrefix.count, line.count))
            if value.first == Self.space { value = value.dropFirst() }
            if hasDataField { payload.append(Self.lineFeed) }
            payload.append(contentsOf: value)
            hasDataField = true
        }
        return nil
    }

    private mutating func flushLineBytes() {
        guard !pendingLineBytes.isEmpty else { return }
        line.append(contentsOf: pendingLineBytes)
        pendingLineBytes.removeAll(keepingCapacity: true)
    }
}

/// Both local and remote clients use precisely this authenticated HTTP/SSE transport.
actor SessionLinkClient {
    private(set) var clientID = UUID().uuidString
    private let transportID = UUID().uuidString
    nonisolated let frames: AsyncThrowingStream<LinkIncomingFrame, Error>
    private let continuation: AsyncThrowingStream<LinkIncomingFrame, Error>.Continuation
    private var session: URLSession?
    private var origin: URL?
    private var token = ""
    private var eventTask: Task<Void, Never>?
    private var cursor = LinkFrameCursor()
    private var closed = false
    private var nextID = 0
    private var conditionalAttach = false
    private var supportsSessionActivity = false
    private var registeredProfile: LinkJSON?
    private var profileID: String?

    init() {
        let pair = AsyncThrowingStream<LinkIncomingFrame, Error>.makeStream()
        frames = pair.stream; continuation = pair.continuation
    }
    func connect(_ descriptor: DaemonDescriptor) async throws {
        guard let url = URL(string: descriptor.origin), url.scheme == "http", url.host == "127.0.0.1",
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw LinkFailure("Discovery requires a loopback HTTP origin") }
        try await connect(origin: url, token: descriptor.token, certificate: nil, instanceID: descriptor.instanceId)
    }
    func connect(_ profile: RemoteConnectionProfile) async throws {
        try profile.validate()
        try await connect(origin: URL(string: profile.origin)!, token: profile.token, certificate: profile.certificateData, instanceID: profile.instanceId)
    }
    private func connect(origin: URL, token: String, certificate: Data?, instanceID: String?) async throws {
        guard session == nil, !closed else { throw LinkFailure("Connection already used") }
        self.origin = origin; self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil
        configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForResource = 86400
        session = URLSession(configuration: configuration, delegate: LinkTLSDelegate(certificate: certificate, host: origin.host!), delegateQueue: nil)
        let hello = try await send(makeRequest("/v1/hello"), as: LinkHello.self)
        guard hello.protocol == 1,
              instanceID == nil || hello.instanceId == instanceID else { throw LinkFailure("Daemon identity mismatch") }
        clientID = hello.clientId
        conditionalAttach = hello.capabilities?.conditionalAttach == true
        supportsSessionActivity = hello.capabilities?.sessionActivity == true
        guard let session else { throw LinkFailure("Disconnected") }
        var request = try makeRequest("/v1/events")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 86400
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/event-stream") == true else { throw LinkFailure("SSE connection rejected") }
        eventTask = Task { [weak self] in
            do {
                var decoder = LinkSSEDecoder()
                var bytesUntilCancellationCheck = 0
                for try await byte in bytes {
                    // Bound cancellation latency without a task lookup for every byte.
                    if bytesUntilCancellationCheck == 0 {
                        try Task.checkCancellation()
                        bytesUntilCancellationCheck = 4096
                    }
                    bytesUntilCancellationCheck -= 1
                    if let payload = decoder.append(byte) {
                        try Task.checkCancellation()
                        let frame = try JSONDecoder().decode(LinkIncomingFrame.self, from: payload)
                        try Task.checkCancellation()
                        try await self?.received(frame)
                    }
                }
                await self?.close(error: LinkFailure("Event stream disconnected. Accepted operations may continue; reconnect and reattach to reconcile. Never replayed."))
            } catch { await self?.close(error: error) }
        }
    }
    private func received(_ frame: LinkIncomingFrame) throws {
        // Global sidebar metadata is independent of the attached transcript's cursor.
        if frame.type != "sessionActivity" { try cursor.apply(frame) }
        continuation.yield(frame)
    }
    private func makeRequest(_ path: String) throws -> URLRequest {
        guard let origin, !closed else { throw LinkFailure("Disconnected; uncertain commands are never replayed") }
        var request = URLRequest(url: origin.appendingPathComponent(String(path.dropFirst())))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(transportID, forHTTPHeaderField: "X-Pi-Client")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }
    private func send<Value: Decodable & Sendable>(_ request: URLRequest, as type: Value.Type) async throws -> Value {
        guard let session, !closed else { throw LinkFailure("Disconnected") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw LinkFailure("Invalid HTTP response") }
        let value = try JSONDecoder().decode(LinkHTTPValue<Value>.self, from: data).value
        guard (200..<300).contains(response.statusCode) else { throw LinkFailure("HTTP \(response.statusCode); command outcome may be uncertain. Not replayed.") }
        return value
    }
    func request<Result: Decodable & Sendable>(_ method: String, _ params: [String: LinkJSON] = [:], as type: Result.Type, timeout: Duration = .seconds(30)) async throws -> Result {
        try Task.checkCancellation()
        if method == "attach", params["ifUnoccupied"] == .bool(true), !conditionalAttach {
            throw LinkFailure("DAEMON_RESTART_REQUIRED: Restart daemon before resuming safely.", code: "DAEMON_RESTART_REQUIRED")
        }
        if method == "subscribeActivity", !supportsSessionActivity {
            throw LinkFailure("Restart the daemon to enable live sidebar activity.", code: "ACTIVITY_UNSUPPORTED")
        }
        var params = params
        if ["list", "subscribeActivity"].contains(method), let profile = params.removeValue(forKey: "profile") {
            if profile != registeredProfile || profileID == nil {
                let result = try await request("registerProfile", ["profile": profile], as: LinkProfileRegistration.self)
                registeredProfile = profile; profileID = result.profileId
            }
            params["profileId"] = .string(profileID!)
        }
        let readMethods: Set<String> = ["list", "get", "snapshot", "operation", "serviceRead"]
        if readMethods.contains(method) {
            var request = try makeRequest("/v1/state")
            var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            url.queryItems = [URLQueryItem(name: "method", value: method), URLQueryItem(name: "params", value: String(decoding: try JSONEncoder().encode(LinkJSON.object(params)), as: UTF8.self))]
            request.url = url.url
            return try await send(request, as: LinkRPCReply<Result>.self).result
        }
        nextID += 1
        let requestID = nextID
        var request = try makeRequest("/v1/rpc")
        request.httpMethod = "POST"
        request.timeoutInterval = Double(timeout.components.seconds) + Double(timeout.components.attoseconds) / 1e18
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(LinkJSON.object(["id": .number(Double(requestID)), "method": .string(method), "params": .object(params)]))
        let reply = try await send(request, as: LinkRPCReply<Result>.self)
        guard reply.replyTo == requestID else { throw LinkFailure("Malformed RPC reply") }
        // SSE and HTTP are independently scheduled. Store waits for canonical attachment frame.
        return reply.result
    }
    func close(error: Error = LinkFailure("Disconnected; command outcome may be uncertain. Not replayed.")) {
        guard !closed else { return }
        closed = true; eventTask?.cancel(); eventTask = nil
        session?.invalidateAndCancel(); session = nil; token = ""
        continuation.finish(throwing: error)
    }
}
#endif
