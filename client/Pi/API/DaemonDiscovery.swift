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

/// GUI bootstrap runs only an explicitly selected executable. No HTTP or local-session fallback.
nonisolated enum DaemonDiscovery {
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
        guard lstat(URL(fileURLWithPath: path).deletingLastPathComponent().path, &directory) == 0,
              directory.st_uid == getuid(), (directory.st_mode & S_IFMT) == S_IFDIR,
              (directory.st_mode & 0o777) == 0o700 else { throw LinkFailure("Unsafe or absent daemon runtime directory") }
        var info = stat()
        guard lstat(path, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & S_IFMT) == S_IFSOCK, (info.st_mode & 0o777) == 0o600 else {
            throw LinkFailure("No private daemon socket at \(path). Start Pi or select its executable.")
        }
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

    /// GUI launch services often omit Homebrew from PATH. Selecting a script does not
    /// remove its /usr/bin/env interpreter lookup; provide an explicit inherited PATH.
    /// No shell, login scripts, or environment persistence is involved.
    static func launchEnvironment(executable: URL?, base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var result = base
        var paths: [String] = []
        if let executable { paths.append(executable.deletingLastPathComponent().path) }
        paths += (base["PATH"] ?? "").split(separator: ":").map(String.init)
        for path in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            var directory: ObjCBool = false
            if FileManager.default.fileExists(atPath: path, isDirectory: &directory), directory.boolValue { paths.append(path) }
        }
        var seen = Set<String>()
        result["PATH"] = paths.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
        return result
    }

    @MainActor static func bootstrap(executable: URL, environment: [String: String]) async throws -> DaemonDescriptor {
        guard executable.isFileURL, FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw LinkFailure("Select an executable Pi launcher")
        }
        let process = Process()
        process.executableURL = executable
        process.environment = launchEnvironment(executable: executable, base: environment)
        process.arguments = ["--no-session", "--mode", "rpc", "--daemon"]
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
            if let descriptor = try? await discover() {
                let probe = SessionLinkClient()
                do {
                    try await probe.connect(descriptor)
                    await probe.close()
                    return descriptor
                } catch { await probe.close() }
            }
            if !process.isRunning && process.terminationStatus != 0 {
                throw LinkFailure("Pi daemon startup exited with status \(process.terminationStatus). Check the selected launcher's runtime environment.")
            }
        }
        throw LinkFailure("Timed out waiting for daemon runtime socket. No fallback session was created.")
    }
}
#endif
