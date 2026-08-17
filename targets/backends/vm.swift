import Foundation
import Virtualization
import DiskImageKit
import Darwin

struct Request: Codable { let command: String; let id: String?; let name: String?; let mounts: [Mount]?; let ramMiB: Int? }
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
}
struct VMMetadata: Codable { let id: String; let name: String?; let mac: String; let baseDisk: String; let sip: String }
struct BaseMetadata: Codable { let ipsw: String; let installed: Bool }
let baseID = "pi-base"

func emit(_ value: Reply) {
    let data = try! JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    fflush(stdout)
}
func oneShot(_ value: Reply) -> Never { emit(value); exit(value.ok ? 0 : 1) }
func fail(_ error: Error) -> Never { oneShot(Reply(ok: false, error: error.localizedDescription, event: nil, state: nil, vms: nil, vm: nil, endpoint: nil)) }
func success(vm: VM? = nil, vms: [VM]? = nil) -> Never { oneShot(Reply(ok: true, error: nil, event: nil, state: nil, vms: vms, vm: vm, endpoint: nil)) }

func requireHost() throws {
    guard #available(macOS 27.0, *), ProcessInfo.processInfo.isOperatingSystemAtLeast(.init(majorVersion: 27, minorVersion: 0, patchVersion: 0)) else {
        throw NSError(domain: "PiMacVM", code: 1, userInfo: [NSLocalizedDescriptionKey: "macOS VMs require macOS 27 or later"])
    }
#if !arch(arm64)
    throw NSError(domain: "PiMacVM", code: 2, userInfo: [NSLocalizedDescriptionKey: "macOS VMs require Apple Silicon"])
#endif
}
func cacheRoot() throws -> URL { try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("pi-macos-vms", isDirectory: true) }
func baseDirectory() throws -> URL { try cacheRoot().appendingPathComponent("base", isDirectory: true) }
func vmDirectory(_ id: String) throws -> URL { try cacheRoot().appendingPathComponent("vms/\(id)", isDirectory: true) }
func baseFile(_ name: String) throws -> URL { try baseDirectory().appendingPathComponent(name) }
func vmFile(_ id: String, _ name: String) throws -> URL { try vmDirectory(id).appendingPathComponent(name) }

func macAddress(for id: String) -> String {
    var hash: UInt32 = 0x5049564d
    for byte in id.utf8 { hash = (hash &* 16777619) ^ UInt32(byte) }
    return String(format: "02:50:69:%02x:%02x:%02x", (hash >> 16) & 255, (hash >> 8) & 255, hash & 255)
}
func metadata(_ id: String) throws -> VMMetadata { try JSONDecoder().decode(VMMetadata.self, from: Data(contentsOf: try vmFile(id, "metadata.json"))) }
func isBaseReady() throws -> Bool {
    let fm = FileManager.default
    guard ["disk.asif", "metadata.json", "hardware-model", "machine-id", "auxiliary.storage"].allSatisfy({ fm.fileExists(atPath: (try! baseFile($0)).path) }) else { return false }
    return (try? JSONDecoder().decode(BaseMetadata.self, from: Data(contentsOf: try baseFile("metadata.json"))))?.installed == true
}
func baseMetadata() throws -> BaseMetadata { try JSONDecoder().decode(BaseMetadata.self, from: Data(contentsOf: try baseFile("metadata.json"))) }
func markBaseInstalled() throws {
    try JSONEncoder().encode(BaseMetadata(ipsw: try baseMetadata().ipsw, installed: true)).write(to: try baseFile("metadata.json"), options: .atomic)
}

func latestIPSW() async throws -> URL {
    let directory = try cacheRoot().appendingPathComponent("ipsw", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let latest = try await VZMacOSRestoreImage.latestSupported
    // Guest provisioning requires macOS 27. Until it ships, latestSupported
    // still returns macOS 26 (Darwin build 25), so use the current seed URL.
    let url: URL
    let fileName: String
    if latest.buildVersion.hasPrefix("25") {
        url = URL(string: "https://updates.cdn-apple.com/2026FallFCS/afcfc88e-bbe6-44bf-a5da-07c56eebc06c/UniversalMac_27.0_26A428_Restore.ipsw")!
        fileName = "UniversalMac_27.0_26A428_Restore.ipsw"
    } else {
        url = latest.url
        fileName = "macos-\(latest.buildVersion).ipsw"
    }
    let destination = directory.appendingPathComponent(fileName)
    if FileManager.default.fileExists(atPath: destination.path) { return destination }
    let (temporary, response) = try await URLSession.shared.download(from: url)
    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw NSError(domain: "PiMacVM", code: 3, userInfo: [NSLocalizedDescriptionKey: "IPSW download failed"]) }
    try FileManager.default.moveItem(at: temporary, to: destination)
    return destination
}

func createBaseStorage() async throws {
    if try isBaseReady() { return }
    let base = try baseDirectory(), fm = FileManager.default
    if fm.fileExists(atPath: base.path) { try fm.removeItem(at: base) }
    try fm.createDirectory(at: base, withIntermediateDirectories: true)
    let ipsw = try await latestIPSW()
    let restore = try await VZMacOSRestoreImage.image(from: ipsw)
    guard let requirements = restore.mostFeaturefulSupportedConfiguration else { throw NSError(domain: "PiMacVM", code: 4, userInfo: [NSLocalizedDescriptionKey: "No supported macOS configuration"]) }
    _ = try DiskImage(creating: .asif(url: try baseFile("disk.asif"), blockCount: 167_772_160, blockSize: .bytes512))
    try requirements.hardwareModel.dataRepresentation.write(to: try baseFile("hardware-model"), options: .atomic)
    let metadata = BaseMetadata(ipsw: ipsw.path, installed: false)
    try JSONEncoder().encode(metadata).write(to: try baseFile("metadata.json"), options: .atomic)
    try VZMacMachineIdentifier().dataRepresentation.write(to: try baseFile("machine-id"), options: .atomic)
    _ = try VZMacAuxiliaryStorage(creatingStorageAt: try baseFile("auxiliary.storage"), hardwareModel: requirements.hardwareModel)
}
@MainActor
func graphics() -> VZMacGraphicsDeviceConfiguration {
    let device = VZMacGraphicsDeviceConfiguration()
    device.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1920, heightInPixels: 1080, pixelsPerInch: 80)]
    return device
}
@MainActor
func platform(machineURL: URL, auxiliaryURL: URL, modelURL: URL) throws -> VZMacPlatformConfiguration {
    guard let machine = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: machineURL)), let model = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: modelURL)) else { throw NSError(domain: "PiMacVM", code: 5, userInfo: [NSLocalizedDescriptionKey: "Invalid macOS platform state"]) }
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
func installBase() async throws {
    let fm = FileManager.default
    guard fm.fileExists(atPath: try baseFile("disk.asif").path), fm.fileExists(atPath: try baseFile("hardware-model").path), fm.fileExists(atPath: try baseFile("machine-id").path), fm.fileExists(atPath: try baseFile("auxiliary.storage").path) else { throw NSError(domain: "PiMacVM", code: 6, userInfo: [NSLocalizedDescriptionKey: "Base storage is missing"]) }
    if (try? baseMetadata())?.installed == true { return }
    let disk = try DiskImage(opening: .open(url: try baseFile("disk.asif")))
    let configuration = VZVirtualMachineConfiguration()
    configuration.bootLoader = VZMacOSBootLoader()
    configuration.platform = try platform(machineURL: baseFile("machine-id"), auxiliaryURL: baseFile("auxiliary.storage"), modelURL: baseFile("hardware-model"))
    let minimums = try await baseMinimums()
    configuration.cpuCount = minimums.cpuCount; configuration.memorySize = minimums.memorySize; configuration.graphicsDevices = [graphics()]
    configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(diskImage: disk))]
    try configuration.validate()
    let runtime = Runtime(configuration: configuration, disks: [disk])
    let ipsw = try await latestIPSW()
    try await VZMacOSInstaller(virtualMachine: runtime.vm, restoringFromImageAt: ipsw).install()
    try JSONEncoder().encode(BaseMetadata(ipsw: ipsw.path, installed: false)).write(to: try baseFile("metadata.json"), options: .atomic)
}

func baseMinimums() async throws -> (cpuCount: Int, memorySize: UInt64) {
    let metadata = try baseMetadata()
    let restore = try await VZMacOSRestoreImage.image(from: URL(fileURLWithPath: metadata.ipsw))
    guard let requirements = restore.mostFeaturefulSupportedConfiguration else {
        throw NSError(domain: "PiMacVM", code: 17, userInfo: [NSLocalizedDescriptionKey: "No supported macOS configuration"])
    }
    return (requirements.minimumSupportedCPUCount, requirements.minimumSupportedMemorySize)
}

func createDerivative(_ request: Request) async throws -> VM {
    guard let id = request.id else { throw NSError(domain: "PiMacVM", code: 7, userInfo: [NSLocalizedDescriptionKey: "Missing VM id"]) }
    guard try isBaseReady() else { throw NSError(domain: "PiMacVM", code: 8, userInfo: [NSLocalizedDescriptionKey: "Base is not installed"]) }
    let directory = try vmDirectory(id), fm = FileManager.default
    guard !fm.fileExists(atPath: directory.path) else { throw NSError(domain: "PiMacVM", code: 9, userInfo: [NSLocalizedDescriptionKey: "VM already exists: \(id)"]) }
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    // Platform state is copied per derivative; disk state is a COW ASIF overlay.
    for file in ["machine-id", "auxiliary.storage", "hardware-model"] { try fm.copyItem(at: try baseFile(file), to: try vmFile(id, file)) }
    let base = try DiskImage(opening: .open(url: try baseFile("disk.asif"), mode: .readOnly))
    _ = try base.appending(.asifLayer(url: try vmFile(id, "overlay.asif"), type: .overlay))
    let info = VMMetadata(id: id, name: request.name, mac: macAddress(for: id), baseDisk: try baseFile("disk.asif").path, sip: "enabled")
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
        throw NSError(domain: "PiMacVM", code: 15, userInfo: [NSLocalizedDescriptionKey: "Mount \(index) host path does not exist: \(mount.hostPath)"])
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

struct BootSpec { let disk: URL; let overlay: URL?; let machine: URL; let auxiliary: URL; let model: URL; let mac: String }
func bootSpec(_ id: String) throws -> BootSpec {
    if id == baseID {
        guard try isBaseStorageReady() else { throw NSError(domain: "PiMacVM", code: 19, userInfo: [NSLocalizedDescriptionKey: "Base storage is missing"]) }
        return BootSpec(disk: try baseFile("disk.asif"), overlay: nil, machine: try baseFile("machine-id"), auxiliary: try baseFile("auxiliary.storage"), model: try baseFile("hardware-model"), mac: macAddress(for: baseID))
    }
    let info = try metadata(id)
    return BootSpec(disk: URL(fileURLWithPath: info.baseDisk), overlay: try vmFile(id, "overlay.asif"), machine: try vmFile(id, "machine-id"), auxiliary: try vmFile(id, "auxiliary.storage"), model: try vmFile(id, "hardware-model"), mac: info.mac)
}
func isBaseStorageReady() throws -> Bool {
    let fm = FileManager.default
    return ["disk.asif", "metadata.json", "hardware-model", "machine-id", "auxiliary.storage"].allSatisfy { fm.fileExists(atPath: (try! baseFile($0)).path) }
}

@MainActor
func startRuntime(_ id: String, mounts: [Mount], ramMiB: Int?) async throws -> (Runtime, Endpoint) {
    let spec = try bootSpec(id)
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
    let minimums = try await baseMinimums()
    if let ramMiB, ramMiB <= 0 { throw NSError(domain: "PiMacVM", code: 16, userInfo: [NSLocalizedDescriptionKey: "ramMiB must be positive"]) }
    configuration.cpuCount = minimums.cpuCount; configuration.memorySize = ramMiB.map { UInt64($0) * 1024 * 1024 } ?? minimums.memorySize; configuration.graphicsDevices = [graphics()]
    configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(diskImage: attachment))]
    let network = VZVirtioNetworkDeviceConfiguration(); network.macAddress = VZMACAddress(string: spec.mac)!; network.attachment = VZNATNetworkDeviceAttachment(); configuration.networkDevices = [network]
    let shareDirectories = try mounts.enumerated().map { index, mount in try shareDirectory(for: mount, vmID: id, index: index) }
    // macOS guests recognize this special tag and mount the share at
    // /Volumes/My Shared Files without a guest-side mount_virtiofs bootstrap.
    // Numeric names are stable per start and keep the policy's host-to-guest
    // translation unambiguous even when host directory names collide.
    let directories = Dictionary(uniqueKeysWithValues: mounts.enumerated().map { index, mount in
        (String(index), VZSharedDirectory(url: shareDirectories[index], readOnly: mount.mode == "ro"))
    })
    if !directories.isEmpty {
        let device = VZVirtioFileSystemDeviceConfiguration(tag: VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag)
        device.share = VZMultipleDirectoryShare(directories: directories)
        configuration.directorySharingDevices = [device]
    }
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
    try await runtime.vm.start(options: options)
    for _ in 0..<180 { if let ip = leaseIP(for: spec.mac) { return (runtime, Endpoint(host: ip, port: 22, user: "pi")) }; try await Task.sleep(for: .seconds(1)) }
    try? await runtime.vm.stop()
    throw NSError(domain: "PiMacVM", code: 10, userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for NAT DHCP lease"])
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
                    guard runtime == nil, let id = request.id else { throw NSError(domain: "PiMacVM", code: 12, userInfo: [NSLocalizedDescriptionKey: "Service is already started or VM id is missing"]) }
                    let started: (Runtime, Endpoint)
                    do {
                        started = try await startRuntime(id, mounts: request.mounts ?? [], ramMiB: request.ramMiB)
                        runtime = started.0; stagedMountVMID = id
                    } catch {
                        removeStagedMounts(for: id)
                        throw error
                    }
                    emit(Reply(ok: true, error: nil, event: "started", state: "running", vms: nil, vm: nil, endpoint: started.1))
                case "status": emit(Reply(ok: true, error: nil, event: "status", state: runtime == nil ? "idle" : (runtime!.vm.state == .running ? "running" : (runtime!.vm.state == .stopped ? "stopped" : "transitioning")), vms: nil, vm: nil, endpoint: nil))
                case "stop":
                    if let active = runtime { try? await active.vm.stop(); runtime = nil }
                    if let id = stagedMountVMID { removeStagedMounts(for: id); stagedMountVMID = nil }
                    emit(Reply(ok: true, error: nil, event: "stopped", state: "stopped", vms: nil, vm: nil, endpoint: nil)); return
                default: throw NSError(domain: "PiMacVM", code: 14, userInfo: [NSLocalizedDescriptionKey: "Unknown control command"])
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
            case "base-status": success(vms: try isBaseReady() ? [VM(id: "base-ready", name: nil)] : [])
            case "download-ipsw": _ = try await latestIPSW(); success()
            case "create-base-storage": try await createBaseStorage(); success()
            case "install-base": try await installBase(); success()
            case "mark-base-installed": try markBaseInstalled(); success()
            case "create-derivative": success(vm: try await createDerivative(request))
            case "list":
                let directory = try cacheRoot().appendingPathComponent("vms", isDirectory: true)
                let vms = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil))?.compactMap { try? metadata($0.lastPathComponent) }.map { VM(id: $0.id, name: $0.name) } ?? []
                success(vms: vms)
            case "destroy": guard let id = request.id else { throw NSError(domain: "PiMacVM", code: 11, userInfo: [NSLocalizedDescriptionKey: "Missing VM id"]) }; try FileManager.default.removeItem(at: vmDirectory(id)); success()
            default: throw NSError(domain: "PiMacVM", code: 14, userInfo: [NSLocalizedDescriptionKey: "Unknown command"])
            }
        } catch { fail(error) }
    }
}
