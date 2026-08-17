#if os(macOS)
import Foundation
import Darwin

nonisolated struct DaemonDescriptor: Decodable, Sendable {
    let `protocol`: Int
    let uid: UInt32
    let pid: Int
    let socketPath: String
    let token: String
    let instanceId: String
    let origin: String
}

/// Discover the same-UID daemon first; only absence permits a login-shell bootstrap.
nonisolated enum DaemonDiscovery {
    struct MissingDaemon: LocalizedError {
        var errorDescription: String? { "Pi isn’t running." }
    }
    @MainActor static var launchers: [Process] = []
    static var userHome: URL {
        // HOME is a launch profile value, not daemon discovery authority.
        guard let home = getpwuid(getuid())?.pointee.pw_dir else { return FileManager.default.homeDirectoryForCurrentUser }
        return URL(fileURLWithPath: String(cString: home), isDirectory: true)
    }
    // Fixed OS runtime path, independent of HOME, launch profile, and GUI defaults.
    static var socketPath: String { "/tmp/pi-session-link-\(getuid())/daemon.sock" }

    static func validateSocket(_ path: String) throws {
        guard path == socketPath else { throw LinkFailure("Daemon broker socket required") }
        var directory = stat()
        guard lstat(URL(fileURLWithPath: path).deletingLastPathComponent().path, &directory) == 0 else {
            if errno == ENOENT { throw MissingDaemon() }
            throw LinkFailure("Cannot inspect the daemon runtime directory")
        }
        guard directory.st_uid == getuid(), (directory.st_mode & S_IFMT) == S_IFDIR,
              (directory.st_mode & 0o777) == 0o700 else { throw LinkFailure("Unsafe daemon runtime directory") }
        var info = stat()
        guard lstat(path, &info) == 0 else {
            if errno == ENOENT { throw MissingDaemon() }
            throw LinkFailure("Cannot inspect the daemon broker socket")
        }
        guard info.st_uid == getuid(), (info.st_mode & S_IFMT) == S_IFSOCK,
              (info.st_mode & 0o777) == 0o600 else { throw LinkFailure("Unsafe daemon broker socket") }
    }

    /// Discovery metadata and credentials exist only in memory on an OS-owned socket.
    static func discover() async throws -> DaemonDescriptor {
        let probe = LocalDiscoveryClient()
        do {
            let descriptor = try await probe.discover()
            await probe.close()
            return descriptor
        } catch {
            await probe.close(error: error)
            throw error
        }
    }

    /// The configured account shell supplies Pi's login environment; the command
    /// and its arguments are fixed, with no user text interpolated into shell code.
    @MainActor static func bootstrap() async throws -> DaemonDescriptor {
        guard let configured = getpwuid(getuid())?.pointee.pw_shell else {
            throw LinkFailure("No login shell is configured for this account")
        }
        let shell = String(cString: configured)
        guard shell.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: shell) else {
            throw LinkFailure("The configured login shell is unavailable")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-l", "-c", "pi --no-session --mode rpc --daemon"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        launchers.removeAll { !$0.isRunning }
        launchers.append(process)
        // The daemon owns its lifetime. Never terminate it when a window closes.
        let deadline = ContinuousClock.now + .seconds(15)
        while ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
            do {
                let descriptor = try await discover()
                // The broker socket is published before the loopback HTTP listener;
                // during that brief startup window discover() returns an empty origin.
                if !descriptor.origin.isEmpty {
                    let probe = SessionLinkClient()
                    do {
                        try await probe.connect(descriptor)
                        await probe.close()
                        return descriptor
                    } catch {
                        await probe.close()
                        throw error // Auth, identity, protocol, and transport failures are not readiness.
                    }
                }
            } catch is MissingDaemon {
                // The shell may still be starting Pi; never mask an unsafe or
                // malformed existing broker as an absent daemon.
            }
            if !process.isRunning && process.terminationStatus != 0 {
                throw LinkFailure("Pi couldn’t start from your login shell (exit status \(process.terminationStatus)).")
            }
        }
        throw LinkFailure("Pi took too long to start from your login shell.")
    }
}
#endif
