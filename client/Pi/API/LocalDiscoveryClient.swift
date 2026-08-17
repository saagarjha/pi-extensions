#if os(macOS)
import Foundation
import Network

/// The Unix socket only discloses loopback HTTP credentials to this OS user.
actor LocalDiscoveryClient {
    private var connection: NWConnection?
    private var waiter: CheckedContinuation<DaemonDescriptor, Error>?
    private var timeout: Task<Void, Never>?
    private var buffer = Data()
    func discover() async throws -> DaemonDescriptor {
        try DaemonDiscovery.validateSocket(DaemonDiscovery.socketPath)
        let c = NWConnection(to: .unix(path: DaemonDiscovery.socketPath), using: .tcp)
        connection = c
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { pending in
                waiter = pending
                c.stateUpdateHandler = { [weak self] state in
                    if case .failed(let error) = state { Task { await self?.close(error: error) } }
                }
                c.start(queue: DispatchQueue(label: "dev.pi.discovery"))
                c.send(content: Data("{\"id\":1,\"method\":\"discover\",\"params\":{}}\n".utf8), completion: .contentProcessed { [weak self] error in
                    if let error { Task { await self?.close(error: error) } }
                })
                timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                    await self?.close(error: LinkFailure("Daemon discovery timed out"))
                }
                receive(c)
            }
        } onCancel: { Task { await self.close(error: CancellationError()) } }
    }
    private func receive(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, complete, error in
            Task { await self?.received(data, complete: complete, error: error, connection: c) }
        }
    }
    private func received(_ data: Data?, complete: Bool, error: NWError?, connection c: NWConnection) {
        guard waiter != nil else { return }
        buffer.append(data ?? Data())
        do {
            guard buffer.count < 65536 else { throw LinkFailure("Oversized discovery response") }
            if let end = buffer.firstIndex(of: 10) {
                let frame = try JSONDecoder().decode(LinkHTTPValue<LinkRPCReply<DaemonDescriptor>>.self, from: buffer[..<end]).value
                let descriptor = frame.result
                guard descriptor.protocol == 1, descriptor.uid == getuid(), descriptor.pid > 0,
                      descriptor.socketPath == DaemonDiscovery.socketPath, !descriptor.token.isEmpty,
                      !descriptor.instanceId.isEmpty else { throw LinkFailure("Invalid daemon identity") }
                let pending = waiter; waiter = nil
                pending?.resume(returning: descriptor)
                close()
            } else if let error { throw error }
            else if complete { throw LinkFailure("Discovery disconnected") }
            else { receive(c) }
        } catch { close(error: error) }
    }
    func close(error: Error = LinkFailure("Discovery closed")) {
        timeout?.cancel(); timeout = nil
        connection?.cancel(); connection = nil
        let pending = waiter; waiter = nil
        pending?.resume(throwing: error)
    }
}
#endif
