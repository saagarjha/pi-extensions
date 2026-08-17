import Foundation
import Virtualization
import DiskImageKit
import Darwin

struct Request: Codable { let command: String; let id: String?; let name: String?; let mounts: [Mount]?; let cpuCount: Int?; let ramMiB: Int?; let build: String?; let ipsw: String?; let network: Bool? }
struct Mount: Codable { let hostPath: String; let guestPath: String; let mode: String }
struct VM: Codable { let id: String; let name: String? }
struct Endpoint: Codable { let host: String; let port: Int; let user: String }
struct Reply: Codable {
    let ok: Bool
    let error: String?
    let event: String?
    let state: String?
    let vms: [VM]?
    let vm: VM?
    let endpoint: Endpoint?
    var build: String? = nil
}
struct VMMetadata: Codable { let id: String; let name: String?; let mac: String; let baseBuild: String; let sip: String }
struct BaseMetadata: Codable { let ipsw: String?; let installed: Bool; let minimumCPUCount: Int; let minimumMemorySize: UInt64 }
let baseIDPrefix = "pi-base-"

func emit(_ value: Reply) {
    let data = try! JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    fflush(stdout)
}
func oneShot(_ value: Reply) -> Never { emit(value); exit(value.ok ? 0 : 1) }
func fail(_ error: Error) -> Never { oneShot(Reply(ok: false, error: error.localizedDescription, event: nil, state: nil, vms: nil, vm: nil, endpoint: nil)) }
func success(vm: VM? = nil, vms: [VM]? = nil, build: String? = nil) -> Never { oneShot(Reply(ok: true, error: nil, event: nil, state: nil, vms: vms, vm: vm, endpoint: nil, build: build)) }

func requireHost() throws {
    guard #available(macOS 27.0, *), ProcessInfo.processInfo.isOperatingSystemAtLeast(.init(majorVersion: 27, minorVersion: 0, patchVersion: 0)) else {
        throw NSError(domain: "vm", code: 1, userInfo: [NSLocalizedDescriptionKey: "macOS VMs require macOS 27 or later"])
    }
#if !arch(arm64)
    throw NSError(domain: "vm", code: 2, userInfo: [NSLocalizedDescriptionKey: "macOS VMs require Apple Silicon"])
#endif
}
func cacheRoot() throws -> URL { try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("pi-macos-vms", isDirectory: true) }
func validatedBuild(_ build: String?) throws -> String {
    guard let build, !build.isEmpty, build.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) }) else {
        throw NSError(domain: "vm", code: 20, userInfo: [NSLocalizedDescriptionKey: "Missing or invalid base build"])
    }
    return build
}
func baseDirectory(_ build: String) throws -> URL { try cacheRoot().appendingPathComponent("bases", isDirectory: true).appendingPathComponent(validatedBuild(build), isDirectory: true) }
func vmDirectory(_ id: String) throws -> URL { try cacheRoot().appendingPathComponent("vms/\(id)", isDirectory: true) }
func baseFile(_ build: String, _ name: String) throws -> URL { try baseDirectory(build).appendingPathComponent(name) }
func vmFile(_ id: String, _ name: String) throws -> URL { try vmDirectory(id).appendingPathComponent(name) }

func macAddress(for id: String) -> String {
    var hash: UInt32 = 0x5049564d
    for byte in id.utf8 { hash = (hash &* 16777619) ^ UInt32(byte) }
    return String(format: "02:50:69:%02x:%02x:%02x", (hash >> 16) & 255, (hash >> 8) & 255, hash & 255)
}
func metadata(_ id: String) throws -> VMMetadata { try JSONDecoder().decode(VMMetadata.self, from: Data(contentsOf: try vmFile(id, "metadata.json"))) }
func isBaseReady(_ build: String) throws -> Bool {
    guard try isBaseStorageReady(build) else { return false }
    return (try? baseMetadata(build))?.installed == true
}
func baseMetadata(_ build: String) throws -> BaseMetadata { try JSONDecoder().decode(BaseMetadata.self, from: Data(contentsOf: try baseFile(build, "metadata.json"))) }
func markBaseInstalled(_ build: String) throws {
    let info = try baseMetadata(build)
    guard try isBaseStorageReady(build) else { throw NSError(domain: "vm", code: 6, userInfo: [NSLocalizedDescriptionKey: "Base storage is missing"]) }
    if let ipsw = info.ipsw, FileManager.default.fileExists(atPath: ipsw) { try FileManager.default.removeItem(atPath: ipsw) }
    try JSONEncoder().encode(BaseMetadata(ipsw: nil, installed: true, minimumCPUCount: info.minimumCPUCount, minimumMemorySize: info.minimumMemorySize)).write(to: try baseFile(build, "metadata.json"), options: .atomic)
}

func resolveBase(_ request: Request) async throws -> String {
    let url: URL
    if let ipsw = request.ipsw {
        guard let explicit = URL(string: ipsw), ["https", "http"].contains(explicit.scheme?.lowercased() ?? ""), explicit.host != nil else {
            throw NSError(domain: "vm", code: 3, userInfo: [NSLocalizedDescriptionKey: "Invalid IPSW URL"])
        }
        url = explicit
    } else {
        let latest = try await VZMacOSRestoreImage.latestSupported
        let build = try validatedBuild(latest.buildVersion)
        if try isBaseReady(build) { return build }
        if let info = try? baseMetadata(build), let ipsw = info.ipsw, FileManager.default.fileExists(atPath: ipsw) { return build }
        url = latest.url
    }
    let fm = FileManager.default
    let (temporary, response) = try await URLSession.shared.download(from: url)
    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw NSError(domain: "vm", code: 3, userInfo: [NSLocalizedDescriptionKey: "IPSW download failed"]) }
    let downloaded = temporary.deletingPathExtension().appendingPathExtension("ipsw")
    try fm.moveItem(at: temporary, to: downloaded)
    let restore = try await VZMacOSRestoreImage.image(from: downloaded)
    let build = try validatedBuild(restore.buildVersion)
    if try isBaseReady(build) { return build }
    guard let requirements = restore.mostFeaturefulSupportedConfiguration else { throw NSError(domain: "vm", code: 4, userInfo: [NSLocalizedDescriptionKey: "No supported macOS configuration"]) }
    try fm.createDirectory(at: baseDirectory(build), withIntermediateDirectories: true)
    let info = BaseMetadata(ipsw: downloaded.path, installed: false, minimumCPUCount: requirements.minimumSupportedCPUCount, minimumMemorySize: requirements.minimumSupportedMemorySize)
    try JSONEncoder().encode(info).write(to: try baseFile(build, "metadata.json"), options: .atomic)
    return build
}

func createBaseStorage(_ build: String) async throws {
    if try isBaseReady(build) { return }
    let info = try baseMetadata(build)
    guard let ipsw = info.ipsw else { throw NSError(domain: "vm", code: 6, userInfo: [NSLocalizedDescriptionKey: "Pending IPSW is missing; resolve base first"]) }
    let restore = try await VZMacOSRestoreImage.image(from: URL(fileURLWithPath: ipsw))
    guard restore.buildVersion == build, let requirements = restore.mostFeaturefulSupportedConfiguration else { throw NSError(domain: "vm", code: 4, userInfo: [NSLocalizedDescriptionKey: "No matching supported macOS configuration"]) }
    let fm = FileManager.default
    for file in ["disk.asif", "hardware-model", "machine-id", "auxiliary.storage"] {
        let url = try baseFile(build, file)
        if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
    }
    _ = try DiskImage(creating: .asif(url: try baseFile(build, "disk.asif"), blockCount: 167_772_160, blockSize: .bytes512))
    try requirements.hardwareModel.dataRepresentation.write(to: try baseFile(build, "hardware-model"), options: .atomic)
    try VZMacMachineIdentifier().dataRepresentation.write(to: try baseFile(build, "machine-id"), options: .atomic)
    _ = try VZMacAuxiliaryStorage(creatingStorageAt: try baseFile(build, "auxiliary.storage"), hardwareModel: requirements.hardwareModel)
}
@MainActor
func graphics() -> VZMacGraphicsDeviceConfiguration {
    let device = VZMacGraphicsDeviceConfiguration()
    device.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1920, heightInPixels: 1080, pixelsPerInch: 80)]
    return device
}
@MainActor
func platform(machineURL: URL, auxiliaryURL: URL, modelURL: URL) throws -> VZMacPlatformConfiguration {
    guard let machine = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: machineURL)), let model = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: modelURL)) else { throw NSError(domain: "vm", code: 5, userInfo: [NSLocalizedDescriptionKey: "Invalid macOS platform state"]) }
    let configuration = VZMacPlatformConfiguration()
    configuration.hardwareModel = model
    configuration.machineIdentifier = machine
    configuration.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: auxiliaryURL)
    return configuration
}

@MainActor
final class Runtime: NSObject, VZVirtualMachineDelegate {
    let vm: VZVirtualMachine
    // Every layer is retained for the lifetime of the VZ attachment.
    let disks: [DiskImage]
    init(configuration: VZVirtualMachineConfiguration, disks: [DiskImage]) {
        self.disks = disks
        self.vm = VZVirtualMachine(configuration: configuration)
        super.init()
        vm.delegate = self
    }
    nonisolated func guestDidStop(_ virtualMachine: VZVirtualMachine) {}
    nonisolated func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { fputs("macOS guest stopped: \(error)\n", stderr) }
}

@MainActor
func installBase(_ build: String) async throws {
    guard try isBaseStorageReady(build) else { throw NSError(domain: "vm", code: 6, userInfo: [NSLocalizedDescriptionKey: "Base storage is missing"]) }
    let info = try baseMetadata(build)
    if info.installed { return }
    guard let ipsw = info.ipsw else { throw NSError(domain: "vm", code: 6, userInfo: [NSLocalizedDescriptionKey: "Pending IPSW is missing; resolve base first"]) }
    let disk = try DiskImage(opening: .open(url: try baseFile(build, "disk.asif")))
    let configuration = VZVirtualMachineConfiguration()
    configuration.bootLoader = VZMacOSBootLoader()
    configuration.platform = try platform(machineURL: baseFile(build, "machine-id"), auxiliaryURL: baseFile(build, "auxiliary.storage"), modelURL: baseFile(build, "hardware-model"))
    let minimums = try baseMinimums(build)
    configuration.cpuCount = minimums.cpuCount; configuration.memorySize = minimums.memorySize; configuration.graphicsDevices = [graphics()]
    configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(diskImage: disk))]
    try configuration.validate()
    let runtime = Runtime(configuration: configuration, disks: [disk])
    try await VZMacOSInstaller(virtualMachine: runtime.vm, restoringFromImageAt: URL(fileURLWithPath: ipsw)).install()
}

func baseMinimums(_ build: String) throws -> (cpuCount: Int, memorySize: UInt64) {
    let info = try baseMetadata(build)
    return (info.minimumCPUCount, info.minimumMemorySize)
}

func createDerivative(_ request: Request) async throws -> VM {
    guard let id = request.id else { throw NSError(domain: "vm", code: 7, userInfo: [NSLocalizedDescriptionKey: "Missing VM id"]) }
    let build = try validatedBuild(request.build)
    guard !id.hasPrefix(baseIDPrefix) else { throw NSError(domain: "vm", code: 7, userInfo: [NSLocalizedDescriptionKey: "VM id uses reserved base prefix"]) }
    guard try isBaseReady(build) else { throw NSError(domain: "vm", code: 8, userInfo: [NSLocalizedDescriptionKey: "Base is not installed"]) }
    let directory = try vmDirectory(id), fm = FileManager.default
    guard !fm.fileExists(atPath: directory.path) else { throw NSError(domain: "vm", code: 9, userInfo: [NSLocalizedDescriptionKey: "VM already exists: \(id)"]) }
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    // Platform state is copied per derivative; disk state is a COW ASIF overlay.
    for file in ["machine-id", "auxiliary.storage", "hardware-model"] { try fm.copyItem(at: try baseFile(build, file), to: try vmFile(id, file)) }
    let base = try DiskImage(opening: .open(url: try baseFile(build, "disk.asif"), mode: .readOnly))
    _ = try base.appending(.asifLayer(url: try vmFile(id, "overlay.asif"), type: .overlay))
    let info = VMMetadata(id: id, name: request.name, mac: macAddress(for: id), baseBuild: build, sip: "enabled")
    try JSONEncoder().encode(info).write(to: try vmFile(id, "metadata.json"), options: .atomic)
    return VM(id: id, name: request.name)
}

func leaseIP(for mac: String) -> String? {
    guard let leases = try? String(contentsOfFile: "/var/db/dhcpd_leases", encoding: .utf8) else { return nil }
    let leaseMAC = mac.split(separator: ":").compactMap { UInt8($0, radix: 16) }.map { String($0, radix: 16) }.joined(separator: ":")
    guard let lease = leases.split(separator: "}").first(where: { $0.lowercased().contains("hw_address=1,\(leaseMAC)") }) else { return nil }
    let text = String(lease), regex = try? NSRegularExpression(pattern: "ip_address=([0-9.]+)")
    guard let match = regex?.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
    return (text as NSString).substring(with: match.range(at: 1))
}

func shareDirectory(for mount: Mount, vmID: String, index: Int) throws -> URL {
    let source = URL(fileURLWithPath: mount.hostPath)
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: source.path, isDirectory: &isDirectory) else {
        throw NSError(domain: "vm", code: 15, userInfo: [NSLocalizedDescriptionKey: "Mount \(index) host path does not exist: \(mount.hostPath)"])
    }
    if isDirectory.boolValue { return source }
    let staging = FileManager.default.temporaryDirectory.appendingPathComponent("pi-macos-mounts/\(vmID)/\(index)", isDirectory: true)
    let fm = FileManager.default
    if fm.fileExists(atPath: staging.path) { try fm.removeItem(at: staging) }
    try fm.createDirectory(at: staging, withIntermediateDirectories: true)
    // VirtioFS shares directories only. A hardlink preserves the exact granted
    // file boundary and, for rw mounts, writes through to the host inode.
    try fm.linkItem(at: source, to: staging.appendingPathComponent(source.lastPathComponent))
    return staging
}

func removeStagedMounts(for vmID: String) {
    try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("pi-macos-mounts/\(vmID)", isDirectory: true))
}

struct BootSpec { let build: String; let disk: URL; let overlay: URL?; let machine: URL; let auxiliary: URL; let model: URL; let mac: String }
func bootSpec(_ id: String) throws -> BootSpec {
    if id.hasPrefix(baseIDPrefix) {
        let build = try validatedBuild(String(id.dropFirst(baseIDPrefix.count)))
        guard try isBaseStorageReady(build) else { throw NSError(domain: "vm", code: 19, userInfo: [NSLocalizedDescriptionKey: "Base storage is missing"]) }
        return BootSpec(build: build, disk: try baseFile(build, "disk.asif"), overlay: nil, machine: try baseFile(build, "machine-id"), auxiliary: try baseFile(build, "auxiliary.storage"), model: try baseFile(build, "hardware-model"), mac: macAddress(for: id))
    }
    let info = try metadata(id)
    return BootSpec(build: info.baseBuild, disk: try baseFile(info.baseBuild, "disk.asif"), overlay: try vmFile(id, "overlay.asif"), machine: try vmFile(id, "machine-id"), auxiliary: try vmFile(id, "auxiliary.storage"), model: try vmFile(id, "hardware-model"), mac: info.mac)
}
func isBaseStorageReady(_ build: String) throws -> Bool {
    let directory = try baseDirectory(build), fm = FileManager.default
    return ["disk.asif", "metadata.json", "hardware-model", "machine-id", "auxiliary.storage"].allSatisfy { fm.fileExists(atPath: directory.appendingPathComponent($0).path) }
}

@MainActor
func startRuntime(_ id: String, mounts: [Mount], cpuCount: Int?, ramMiB: Int?, network: Bool = true) async throws -> (Runtime, Endpoint) {
    let spec = try bootSpec(id)
    let minimums = try baseMinimums(spec.build)
    let minimumCPUCount = max(minimums.cpuCount, VZVirtualMachineConfiguration.minimumAllowedCPUCount)
    let maximumCPUCount = VZVirtualMachineConfiguration.maximumAllowedCPUCount
    let selectedCPUCount = cpuCount ?? minimumCPUCount
    guard selectedCPUCount >= minimumCPUCount, selectedCPUCount <= maximumCPUCount else {
        throw NSError(domain: "vm", code: 16, userInfo: [NSLocalizedDescriptionKey: "cpuCount must be between \(minimumCPUCount) and \(maximumCPUCount)"])
    }
    let minimumMemorySize = max(minimums.memorySize, VZVirtualMachineConfiguration.minimumAllowedMemorySize)
    let maximumMemorySize = VZVirtualMachineConfiguration.maximumAllowedMemorySize
    let bytesPerMiB: UInt64 = 1024 * 1024
    var selectedMemorySize = minimumMemorySize
    if let ramMiB {
        // Round the lower bound up without overflowing; bound MiB before converting to bytes.
        let minimumMiB = minimumMemorySize / bytesPerMiB + (minimumMemorySize % bytesPerMiB == 0 ? 0 : 1)
        let maximumMiB = maximumMemorySize / bytesPerMiB
        guard ramMiB > 0, let value = UInt64(exactly: ramMiB), value >= minimumMiB, value <= maximumMiB else {
            throw NSError(domain: "vm", code: 16, userInfo: [NSLocalizedDescriptionKey: "ramMiB must be between \(minimumMiB) and \(maximumMiB)"])
        }
        selectedMemorySize = value * bytesPerMiB
    }
    guard selectedMemorySize <= maximumMemorySize else {
        throw NSError(domain: "vm", code: 16, userInfo: [NSLocalizedDescriptionKey: "Restore image minimum memory exceeds the VZ allowed maximum"])
    }
    var layers: [DiskImage] = []
    let attachment: DiskImage
    if let overlayURL = spec.overlay {
        let base = try DiskImage(opening: .open(url: spec.disk, mode: .readOnly))
        let overlay = try DiskImage(opening: .open(url: overlayURL))
        let stack = try base.appending(overlay)
        layers = [base, overlay, stack]; attachment = stack
    } else {
        let disk = try DiskImage(opening: .open(url: spec.disk))
        layers = [disk]; attachment = disk
    }
    let configuration = VZVirtualMachineConfiguration()
    configuration.bootLoader = VZMacOSBootLoader()
    configuration.platform = try platform(machineURL: spec.machine, auxiliaryURL: spec.auxiliary, modelURL: spec.model)
    configuration.cpuCount = selectedCPUCount; configuration.memorySize = selectedMemorySize; configuration.graphicsDevices = [graphics()]
    configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(diskImage: attachment))]
    if network {
        let device = VZVirtioNetworkDeviceConfiguration()
        device.macAddress = VZMACAddress(string: spec.mac)!
        device.attachment = VZNATNetworkDeviceAttachment()
        configuration.networkDevices = [device]
    }
    guard mounts.count <= 1 else { throw NSError(domain: "vm", code: 15, userInfo: [NSLocalizedDescriptionKey: "Expected one host filesystem share"]) }
    if let mount = mounts.first {
        let directory = try shareDirectory(for: mount, vmID: id, index: 0)
        let device = VZVirtioFileSystemDeviceConfiguration(tag: VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag)
        device.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: directory, readOnly: mount.mode == "ro"))
        configuration.directorySharingDevices = [device]
    }
    let console = VZVirtioConsoleDeviceConfiguration()
    let port = VZVirtioConsolePortConfiguration()
    port.name = "pi-control"
    port.isConsole = false
    port.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: FileHandle(fileDescriptor: 3, closeOnDealloc: false), fileHandleForWriting: FileHandle(fileDescriptor: 4, closeOnDealloc: false))
    console.ports[0] = port
    configuration.consoleDevices = [console]
    do {
        try configuration.validate()
    } catch {
        fputs("VZ configuration validation failed with \(mounts.count) VirtioFS mount(s): \(error)\n", stderr)
        throw error
    }
    let runtime = Runtime(configuration: configuration, disks: layers)
    let options = VZMacOSVirtualMachineStartOptions()
    let provisioning = VZMacGuestProvisioningOptions(); provisioning.fullName = "Pi"; provisioning.username = "pi"; provisioning.password = "pi-local"; provisioning.logsInAutomatically = true; provisioning.enablesRemoteLogin = true
    try options.setGuestProvisioning(provisioning)
    do {
        try await runtime.vm.start(options: options)
        if !network {
            return (runtime, Endpoint(host: id, port: 22, user: "pi"))
        }
        for _ in 0..<180 {
            if let ip = leaseIP(for: spec.mac) {
                return (runtime, Endpoint(host: ip, port: 22, user: "pi"))
            }
            try await Task.sleep(for: .seconds(1))
        }
        throw NSError(domain: "vm", code: 10, userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for NAT DHCP lease"])
    } catch {
        try? await runtime.vm.stop()
        throw error
    }
}

@MainActor
func serve() async throws {
    var runtime: Runtime?
    var stagedMountVMID: String?
    do {
        for try await line in FileHandle.standardInput.bytes.lines {
            guard let data = line.data(using: .utf8) else { continue }
            let request: Request
            do { request = try JSONDecoder().decode(Request.self, from: data) } catch { emit(Reply(ok: false, error: "Invalid control JSON", event: nil, state: nil, vms: nil, vm: nil, endpoint: nil)); continue }
            do {
                switch request.command {
                case "start":
                    guard runtime == nil, let id = request.id else { throw NSError(domain: "vm", code: 12, userInfo: [NSLocalizedDescriptionKey: "Service is already started or VM id is missing"]) }
                    let started: (Runtime, Endpoint)
                    do {
                        stagedMountVMID = id
                        started = try await startRuntime(id, mounts: request.mounts ?? [], cpuCount: request.cpuCount, ramMiB: request.ramMiB, network: request.network ?? true)
                        runtime = started.0
                    } catch {
                        runtime = nil; stagedMountVMID = nil
                        removeStagedMounts(for: id)
                        throw error
                    }
                    emit(Reply(ok: true, error: nil, event: "started", state: "running", vms: nil, vm: nil, endpoint: started.1))
                case "status": emit(Reply(ok: true, error: nil, event: "status", state: runtime == nil ? "idle" : (runtime!.vm.state == .running ? "running" : (runtime!.vm.state == .stopped ? "stopped" : "transitioning")), vms: nil, vm: nil, endpoint: nil))
                case "stop":
                    if let active = runtime { try? await active.vm.stop(); runtime = nil }
                    if let id = stagedMountVMID { removeStagedMounts(for: id); stagedMountVMID = nil }
                    emit(Reply(ok: true, error: nil, event: "stopped", state: "stopped", vms: nil, vm: nil, endpoint: nil)); return
                default: throw NSError(domain: "vm", code: 14, userInfo: [NSLocalizedDescriptionKey: "Unknown control command"])
                }
            } catch {
                let event: String?
                switch request.command { case "start": event = "started"; case "status": event = "status"; case "stop": event = "stopped"; default: event = nil }
                emit(Reply(ok: false, error: error.localizedDescription, event: event, state: nil, vms: nil, vm: nil, endpoint: nil))
            }
        }
    } catch {
        // A broken control pipe must not leave VZ resources and ASIF layers live.
        if let active = runtime { try? await active.vm.stop() }
        if let id = stagedMountVMID { removeStagedMounts(for: id) }
        throw error
    }
    if let active = runtime { try? await active.vm.stop() }
    if let id = stagedMountVMID { removeStagedMounts(for: id) }
}

@main @MainActor struct Main {
    static func main() async {
        do {
            try requireHost()
            if CommandLine.arguments.dropFirst().contains("--serve") { try await serve(); return }
            let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
            switch request.command {
            case "resolve-base": success(build: try await resolveBase(request))
            case "base-status": success(vms: try isBaseReady(validatedBuild(request.build)) ? [VM(id: "base-ready", name: nil)] : [])
            case "create-base-storage": try await createBaseStorage(validatedBuild(request.build)); success()
            case "install-base": try await installBase(validatedBuild(request.build)); success()
            case "mark-base-installed": try markBaseInstalled(validatedBuild(request.build)); success()
            case "create-derivative": success(vm: try await createDerivative(request))
            case "list":
                let directory = try cacheRoot().appendingPathComponent("vms", isDirectory: true)
                let vms = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil))?.compactMap { try? metadata($0.lastPathComponent) }.map { VM(id: $0.id, name: $0.name) } ?? []
                success(vms: vms)
            case "destroy": guard let id = request.id else { throw NSError(domain: "vm", code: 11, userInfo: [NSLocalizedDescriptionKey: "Missing VM id"]) }; try FileManager.default.removeItem(at: vmDirectory(id)); success()
            default: throw NSError(domain: "vm", code: 14, userInfo: [NSLocalizedDescriptionKey: "Unknown command"])
            }
        } catch { fail(error) }
    }
}
