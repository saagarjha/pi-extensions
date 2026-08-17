import Darwin
import ExtensionFoundation
import FSKit
import Foundation
import os

// The controller/mount integration remains opt-in and is not installed by this
// module. A generic resource identifies the session; -s names its absolute
// controller socket path. Entitlements permit backing-file and Unix-socket access.
private let log = Logger(subsystem: "pi.permissions.fskit", category: "filesystem")
private func failure(_ code: Int32 = errno) -> Error {
  NSError(domain: NSPOSIXErrorDomain, code: Int(code))
}
private func failure(_ code: Int32, reason: String) -> Error {
  NSError(
    domain: NSPOSIXErrorDomain, code: Int(code),
    userInfo: [NSLocalizedFailureReasonErrorKey: reason])
}
@discardableResult private func checked<T: SignedInteger>(_ result: T) throws -> T {
  guard result >= 0 else { throw failure() }
  return result
}
private func synchronizeBackingVolume(_ fd: Int32, flags: Int32) throws {
  // This API returns an errno value directly, not -1 with errno set.
  let error = fsync_volume_np(fd, flags)
  guard error == 0 else { throw failure(error) }
}
private func configureDescriptorLimit() throws {
  // VM sharing services can legitimately cache many open files. Respect the
  // inherited hard limit and the kernel ceiling rather than evicting handles.
  var limits = rlimit()
  try checked(getrlimit(RLIMIT_NOFILE, &limits))
  var ceiling: Int32 = 0
  var size = MemoryLayout.size(ofValue: ceiling)
  try checked(sysctlbyname("kern.maxfilesperproc", &ceiling, &size, nil, 0))
  guard ceiling > 0 else { throw failure(EINVAL) }
  let target = min(limits.rlim_max, rlim_t(ceiling))
  guard target > limits.rlim_cur else { return }
  let previous = limits.rlim_cur
  limits.rlim_cur = target
  try checked(setrlimit(RLIMIT_NOFILE, &limits))
  log.info("Raised open-file soft limit from \(previous) to \(target)")
}
private func required<T>(_ value: T?) throws -> T {
  guard let value else { throw failure(EIO) }
  return value
}
private func validPath(_ path: String) -> Bool {
  path == "/"
    || (path.hasPrefix("/") && !path.hasSuffix("/") && !path.contains("\0")
      && path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy {
        !$0.isEmpty && $0 != "." && $0 != ".."
      })
}
private func covers(_ scope: String, _ path: String) -> Bool {
  scope == "/" || path == scope || path.hasPrefix(scope + "/")
}
private func childPath(_ parent: String, _ name: String) throws -> String {
  guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\0")
  else { throw failure(EINVAL) }
  return (parent == "/" ? "" : parent) + "/" + name
}

private struct Access: OptionSet, Sendable {
  let rawValue: UInt8
  static let read = Access(rawValue: 1)
  static let write = Access(rawValue: 2)
}
private enum Decision { case allow, deny, ask }
private enum Mode: String, Decodable, Sendable {
  case deny
  case askRead = "ask-ro"
  case askReadWrite = "ask-rw"
  case read = "ro"
  case readAskWrite = "ro-ask-rw"
  case readWrite = "rw"
  func decision(_ access: Access) -> Decision {
    if access.isEmpty { return .allow }
    switch self {
    case .deny: return .deny
    case .readWrite: return .allow
    case .read: return access.contains(.write) ? .deny : .allow
    case .askRead: return access.contains(.write) ? .deny : .ask
    case .askReadWrite: return .ask
    case .readAskWrite: return access.contains(.write) ? .ask : .allow
    }
  }
}
// Value snapshot of a set-attributes request. The FSKit request itself stays
// with its witness; only these values cross into the item actor.
private struct AttributeChanges: Sendable {
  let consumed: FSItem.Attribute
  let mode: UInt32?
  let uid: UInt32?
  let gid: UInt32?
  let flags: UInt32?
  let size: UInt64?
  let accessTime: timespec?
  let modifyTime: timespec?
  let birthTime: timespec?
  init(_ request: FSItem.SetAttributesRequest, creating: Bool = false) throws {
    let supported: [FSItem.Attribute] = [
      .mode, .uid, .gid, .flags, .size, .accessTime, .modifyTime, .birthTime,
    ]
    let readOnly: [FSItem.Attribute] = [
      .changeTime, .allocSize, .fileID, .parentID, .type, .linkCount,
    ]
    guard creating || !readOnly.contains(where: request.isValid) else { throw failure(EINVAL) }
    // Optional attributes not implemented here remain unconsumed. FSKit
    // explicitly asks the module to let its upper layer detect those fields.
    if request.isValid(.mode), request.mode & ~0o7777 != 0 { throw failure(EINVAL) }
    consumed = supported.reduce(into: []) { if request.isValid($1) { $0.insert($1) } }
    mode = request.isValid(.mode) ? request.mode : nil
    uid = request.isValid(.uid) ? request.uid : nil
    gid = request.isValid(.gid) ? request.gid : nil
    flags = request.isValid(.flags) ? request.flags : nil
    size = request.isValid(.size) ? request.size : nil
    accessTime = request.isValid(.accessTime) ? request.accessTime : nil
    modifyTime = request.isValid(.modifyTime) ? request.modifyTime : nil
    birthTime = request.isValid(.birthTime) ? request.birthTime : nil
  }
}

private struct Scope: Decodable, Sendable {
  let path: String
  let mode: Mode
}
private struct ControlMessage: Decodable, Sendable {
  let type: String
  var generation: Int?
  var scopes: [Scope]?
  var id: String?
  var allow: Bool?
}
// Internal suspension request for the link resolver, not an IPC/error protocol.
private struct LinkNeedsApproval: Error {
  let path: String
  let traversal: Bool
}
private struct Policy {
  // Pi canonicalizes policy paths to NFC. Normalize only the matching view;
  // backing syscall names retain their actual spelling and inode identity.
  // Case comes from backing F_GETPATH resolution, never blanket case folding.
  let scopes: [Scope]
  init(_ scopes: [Scope] = []) {
    self.scopes = scopes.map {
      Scope(path: $0.path.precomposedStringWithCanonicalMapping, mode: $0.mode)
    }.sorted {
      $0.path.split(separator: "/").count > $1.path.split(separator: "/").count
    }
  }
  func mode(_ path: String) -> Mode {
    let canonical = path.precomposedStringWithCanonicalMapping
    return scopes.first { covers($0.path, canonical) }?.mode ?? .deny
  }
  func projectedMode(_ backing: mode_t, at path: String) -> UInt32 {
    let bits = UInt32(backing & 0o7777)
    let kind = backing & S_IFMT
    if kind == S_IFLNK { return bits }
    let mode = mode(path)
    if kind == S_IFDIR {
      guard traversable(path) else { return 0 }
      let childMayWrite = scopes.contains {
        covers(path.precomposedStringWithCanonicalMapping, $0.path)
          && $0.mode.decision(.write) != .deny
      }
      return mode.decision(.write) != .deny || childMayWrite ? bits : bits & ~0o222
    }
    switch mode {
    case .deny: return 0
    case .read, .askRead: return bits & ~0o222
    case .readWrite, .askReadWrite, .readAskWrite: return bits
    }
  }
  func traversable(_ path: String) -> Bool {
    let canonical = path.precomposedStringWithCanonicalMapping
    return mode(canonical) != .deny
      || scopes.contains { covers(canonical, $0.path) && $0.mode != .deny }
  }
}

// All descriptors, directory cursors, FSItems and attribute snapshots are owned
// by VolumeState. No FSKit callback is assumed to run on a particular executor.
private final class Descriptor {
  let value: Int32
  init(_ value: Int32) { self.value = value }
  @discardableResult
  func withFD<T>(_ body: (Int32) throws -> T) rethrows -> T {
    try withExtendedLifetime(self) { try body(value) }
  }
  deinit { Darwin.close(value) }
}
// A request owns a duplicate descriptor through its complete backing IO. The
// Foundation FileHandle is Sendable; the actor's own descriptors never escape.
private struct DataAccess: Sendable {
  let token: UUID
  let itemID: UInt64
  let path: String
  let handle: FileHandle
}
private struct VolumeSync: Sendable {
  let device: dev_t
  let revision: UInt64?
  let handle: FileHandle
}
private struct DirectoryEntry {
  let name: String
  let id: UInt64
  let nextCookie: UInt64
  let type: FSItem.ItemType
  let attributes: FSItem.Attributes?
}
private struct Enumeration: Sendable {
  let id: UInt64
  let path: String
  let verifier: UInt64
  let names: [String]
}
private final class Item: FSItem {
  let id: UInt64
  init(_ id: UInt64) {
    self.id = id
    super.init()
  }
}
private struct BackingIdentity: Hashable {
  let device: dev_t
  let inode: ino_t
}
private final class Record {
  let item: Item
  var path: String
  var parent: UInt64
  var parentFileID: UInt64 = 2
  var hasAliases: Bool
  var unlinked = false
  let device: dev_t
  let inode: ino_t
  // Metadata handles are temporary until publication. Closed cached items keep
  // identity, not an FD; only open files and directory streams retain handles.
  var descriptor: Descriptor?
  var readDescriptor: Descriptor?
  var writeDescriptor: Descriptor?
  var listings: [UInt64: [String]] = [:]
  var listed: UInt64?
  var grants: Access = []
  var opened: Access = []

  convenience init(id: UInt64, path: String, parent: UInt64, descriptor: Descriptor) throws {
    var info = stat()
    try descriptor.withFD { try checked(fstat($0, &info)) }
    self.init(id: id, path: path, parent: parent, info: info, descriptor: descriptor)
  }
  init(id: UInt64, path: String, parent: UInt64, info: stat, descriptor: Descriptor? = nil) {
    device = info.st_dev
    inode = info.st_ino
    hasAliases = info.st_mode & S_IFMT != S_IFDIR && info.st_nlink > 1
    item = Item(id)
    self.path = path
    self.parent = parent
    self.descriptor = descriptor
  }
}

private actor VolumeState {
  let root: Descriptor
  let writable: Bool
  private var records: [UInt64: Record] = [:]
  private var paths: [String: UInt64] = [:]
  private var nextID: UInt64 = 3
  // Public inode identity is independent of each pathname's private FSItem.
  // Device is part of the key because a root resource crosses backing mounts.
  private var fileIDs: [BackingIdentity: UInt64] = [:]
  private var nextFileID: UInt64 = 3
  private var nextVerifier: UInt64 = 1
  private var activeIO: [UUID: UInt64] = [:]
  // One pin per backing volume with unsynchronized mutations, not per file.
  private var dirtyVolumes: [dev_t: (revision: UInt64, handle: Descriptor)] = [:]
  private var mutationRevision: UInt64 = 0
  private var ioWaiters: [(UInt64?, CheckedContinuation<Void, Never>)] = []
  private var policy = Policy()
  private var generation = 0
  private var serving = false
  private var stopped = false
  private var controller: FileHandle?
  private var asks: [String: CheckedContinuation<Bool, Never>] = [:]
  private var activation: CheckedContinuation<Void, Error>?
  private var cleanup: Task<Void, Never>?
  private var deactivated = false

  init(rootFD: Int32, writable: Bool) throws {
    root = Descriptor(rootFD)
    self.writable = writable
    records[2] = try Record(id: 2, path: "/", parent: 2, descriptor: root)
    paths["/"] = 2
    let record = records[2]!
    fileIDs[BackingIdentity(device: record.device, inode: record.inode)] = 2
  }
  func fileIdentifier(device: dev_t, inode: ino_t) throws -> UInt64 {
    let key = BackingIdentity(device: device, inode: inode)
    if let id = fileIDs[key] { return id }
    guard nextFileID != UInt64.max else { throw failure(EOVERFLOW) }
    let id = nextFileID
    nextFileID += 1
    fileIDs[key] = id
    return id
  }
  func fileIdentifier(_ record: Record) throws -> UInt64 {
    try fileIdentifier(device: record.device, inode: record.inode)
  }
  func parentFileIdentifier(_ path: String) throws -> UInt64 {
    var info = stat()
    try descriptor((path as NSString).deletingLastPathComponent).withFD {
      try checked(fstat($0, &info))
    }
    return try fileIdentifier(device: info.st_dev, inode: info.st_ino)
  }
  func noteMutation(_ fd: Int32) throws {
    var info = stat()
    try checked(fstat(fd, &info))
    let pin =
      try dirtyVolumes[info.st_dev]?.handle
      ?? Descriptor(checked(fcntl(fd, F_DUPFD_CLOEXEC, 0)))
    mutationRevision &+= 1
    dirtyVolumes[info.st_dev] = (mutationRevision, pin)
  }
  func prepareSync() throws -> [VolumeSync] {
    guard !deactivated else { throw failure(ENODEV) }
    var info = stat()
    try root.withFD { try checked(fstat($0, &info)) }
    var pending = dirtyVolumes.map { ($0.key, Optional($0.value.revision), $0.value.handle) }
    if dirtyVolumes[info.st_dev] == nil { pending.append((info.st_dev, nil, root)) }
    return try pending.map { device, revision, descriptor in
      let copy = try descriptor.withFD { try checked(fcntl($0, F_DUPFD_CLOEXEC, 0)) }
      return VolumeSync(
        device: device, revision: revision,
        handle: FileHandle(fileDescriptor: copy, closeOnDealloc: true))
    }
  }
  func completeSync(_ snapshots: [VolumeSync], waited: Bool) {
    // A nonwaiting flush may still be running. A write completing during a
    // waiting flush also needs a later sync, even if it was admitted earlier.
    guard waited else { return }
    for snapshot in snapshots {
      if let revision = snapshot.revision, dirtyVolumes[snapshot.device]?.revision == revision {
        dirtyVolumes.removeValue(forKey: snapshot.device)
      }
    }
  }
  func record(_ id: UInt64) throws -> Record {
    guard serving, !stopped else { throw failure(EACCES) }
    guard let record = records[id] else { throw failure(ESTALE) }
    return record
  }
  func handle(_ record: Record) throws -> Descriptor {
    if record.item.id == 2 { return root }
    if let handle = record.readDescriptor ?? record.writeDescriptor ?? record.descriptor {
      return handle
    }
    let handle = try descriptor(record.path)
    try validate(handle, record: record)
    return handle
  }
  func validate(_ handle: Descriptor, record: Record) throws {
    var info = stat()
    try handle.withFD { try checked(fstat($0, &info)) }
    guard info.st_dev == record.device, info.st_ino == record.inode else { throw failure(ESTALE) }
  }
  func descriptorPath(_ fd: Int32) throws -> String {
    var bytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    try checked(fcntl(fd, F_GETPATH, &bytes))
    guard
      let path = String(
        validating: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    else { throw failure(EILSEQ) }
    return path
  }
  func relativePath(_ fd: Descriptor) throws -> String {
    try fd.withFD { try relativePath(fd: $0) }
  }
  func relativePath(fd: Int32) throws -> String {
    let rootPath = try root.withFD { try descriptorPath($0) }
    let path = try descriptorPath(fd)
    guard covers(rootPath, path) else { throw failure(EACCES) }
    if path == rootPath { return "/" }
    return rootPath == "/" ? path : String(path.dropFirst(rootPath.count))
  }
  func refresh(_ record: Record, using fd: Int32? = nil) throws {
    let held = try fd == nil ? handle(record) : nil
    defer { withExtendedLifetime(held) {} }
    let descriptor = fd ?? held!.value
    var identity = stat()
    try checked(fstat(descriptor, &identity))
    if record.unlinked || identity.st_nlink == 0 { return }
    if identity.st_mode & S_IFMT != S_IFDIR && identity.st_nlink > 1 { record.hasAliases = true }
    if record.hasAliases {
      // F_GETPATH can name another hardlink of the same vnode. Keep this
      // alias's binding; do not turn a preferred-name change into a rename.
      try validate(self.descriptor(record.path), record: record)
      return
    }
    let path: String
    do { path = try relativePath(fd: descriptor) } catch {
      var info = stat()
      try checked(fstat(descriptor, &info))
      // An unlinked but still-open file remains usable under its last pathname
      // policy. A linked item moved outside the backing resource does not.
      if info.st_nlink == 0 { return }
      throw error
    }
    if record.item.id != 2 {
      record.parent = try identifier((path as NSString).deletingLastPathComponent)
    }
    guard path != record.path else { return }
    record.parentFileID = try parentFileIdentifier(path)
    if paths[record.path] == record.item.id { paths.removeValue(forKey: record.path) }
    record.path = path
    record.grants = []
    paths[path] = record.item.id
  }
  func identifier(_ path: String) throws -> UInt64 {
    if let id = paths[path] { return id }
    guard nextID != UInt64.max else { throw failure(EOVERFLOW) }
    let id = nextID
    nextID += 1
    paths[path] = id
    return id
  }
  func authorize(_ record: Record, _ access: Access, traversal: Bool = false) async throws {
    try refresh(record)
    let path = record.path
    try await authorize([path], access, traversal: traversal)
    try refresh(record)
    guard records[record.item.id] === record, record.path == path else { throw failure(ESTALE) }
    if traversal, policy.mode(path) == .deny, try attributes(record).type != .directory {
      throw failure(EACCES)
    }
  }
  func check() throws {
    guard serving, !stopped else { throw failure(EACCES) }
  }
  func authorize(_ paths: [String], _ access: Access, traversal: Bool = false) async throws {
    try check()
    if access.contains(.write), !writable { throw failure(EROFS) }
    for path in Set(paths) {
      let mode = policy.mode(path)
      if traversal && !access.contains(.write) && mode == .deny && policy.traversable(path) {
        continue
      }
      for right in [Access.read, .write] where access.contains(right) {
        switch mode.decision(right) {
        case .deny: throw failure(EACCES)
        case .allow: continue
        case .ask:
          if let id = self.paths[path], records[id]?.grants.contains(right) == true { continue }
          let id = UUID().uuidString
          let granted = await withCheckedContinuation { continuation in
            asks[id] = continuation
            do {
              try send([
                "type": "approval", "id": id, "generation": generation,
                "path": path, "access": right == .read ? "read" : "write", "reason": "access",
              ])
            } catch {
              serving = false
              asks.removeValue(forKey: id)?.resume(returning: false)
              Task { await self.stop() }
            }
          }
          try check()
          guard granted else { throw failure(EACCES) }
          if let id = self.paths[path] { records[id]?.grants.insert(right) }
        }
      }
    }
    try check()
  }
  func send(_ object: [String: Any]) throws {
    guard let controller else { throw failure(ENOTCONN) }
    var data = try JSONSerialization.data(withJSONObject: object)
    data.append(10)
    try controller.write(contentsOf: data)
  }
  func connect(url: URL) async throws {
    guard controller == nil, !stopped else { throw failure(EALREADY) }
    let fd = try checked(socket(AF_UNIX, SOCK_STREAM, 0))
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = url.path.utf8CString
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
      throw failure(ENAMETOOLONG)
    }
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
      bytes.withUnsafeBytes { destination.copyBytes(from: $0) }
    }
    _ = try withUnsafePointer(to: &address) { pointer in
      try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        try checked(Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)))
      }
    }
    var uid: uid_t = 0
    var gid: gid_t = 0
    try checked(getpeereid(fd, &uid, &gid))
    guard uid == geteuid() else { throw failure(EACCES) }
    var one: Int32 = 1
    try checked(
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout.size(ofValue: one))))
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    try checked(
      setsockopt(
        fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))))
    controller = handle
    try send(["type": "hello", "version": 1, "mount": UUID().uuidString])
    Task {
      do {
        var frame = Data()
        for try await byte in handle.bytes {
          if byte == 10 {
            let message = try JSONDecoder().decode(ControlMessage.self, from: frame)
            frame.removeAll(keepingCapacity: true)
            try await receive(message)
          } else {
            frame.append(byte)
            // Protocol framing limit, not a filesystem workload limit.
            guard frame.count <= 1_048_576 else { throw failure(EMSGSIZE) }
          }
        }
      } catch { log.error("Controller disconnected: \(error)") }
      await stop()
    }
    while !serving {
      guard !stopped else { throw failure(ENOTCONN) }
      try await withCheckedThrowingContinuation { activation = $0 }
    }
  }
  func receive(_ message: ControlMessage) async throws {
    switch message.type {
    case "decision":
      guard let receivedGeneration = message.generation, let id = message.id,
        let allow = message.allow
      else { throw failure(EPROTO) }
      // Replies to prompts cancelled by a newer policy are harmless stale IPC.
      guard receivedGeneration == generation else { return }
      asks.removeValue(forKey: id)?.resume(returning: allow)
    case "policy":
      guard let next = message.generation, next > generation, let scopes = message.scopes,
        scopes.allSatisfy({ validPath($0.path) }), Set(scopes.map(\.path)).count == scopes.count
      else { throw failure(EPROTO) }
      guard !stopped else { return }
      for ask in asks.values { ask.resume(returning: false) }
      asks.removeAll()
      for record in records.values { record.grants = [] }
      policy = Policy(scopes)
      generation = next
      serving = true
      try send([
        "type": "policyAck", "generation": next,
      ])
      activation?.resume()
      activation = nil
    default: throw failure(EPROTO)
    }
  }
  func stop(deactivating: Bool = false) async {
    if deactivating { deactivated = true }
    // Disconnect, unmount and deactivate may overlap. Admission stopping is
    // immediate; each caller still waits for the same cleanup to finish.
    if let cleanup {
      await cleanup.value
    } else if !stopped {
      serving = false
      stopped = true
      for ask in asks.values { ask.resume(returning: false) }
      asks.removeAll()
      activation?.resume(throwing: failure(ENOTCONN))
      activation = nil
      let task = Task {
        await drainIO()
        for id in records.keys { close(id) }
        if let controller {
          shutdown(controller.fileDescriptor, SHUT_RDWR)
          try? controller.close()
        }
        controller = nil
        paths.removeAll()
      }
      cleanup = task
      await task.value
      cleanup = nil
    }
    // A disconnected mounted volume still owns its kernel-visible records:
    // only tryReclaim may remove them. Deactivation guarantees other items
    // were reclaimed and permits final teardown of the retained root.
    if deactivated {
      records.removeAll()
      dirtyVolumes.removeAll()
    }
  }

  // Resolve every component relative to the pinned root. Symlinks themselves
  // use O_SYMLINK; their targets are resolved by the mounted filesystem, never
  // followed through the module's backing authority.
  func descriptor(_ path: String, flags: Int32 = O_EVTONLY | O_SYMLINK) throws -> Descriptor {
    var current = root
    let components = path.split(separator: "/").map(String.init)
    for (index, component) in components.enumerated() {
      let last = index == components.count - 1
      // O_SYMLINK already opens the link itself; combining it with O_NOFOLLOW
      // produces ELOOP on Darwin. Intermediate components never follow links.
      let noFollow: Int32 = last && flags & O_SYMLINK != 0 ? 0 : O_NOFOLLOW
      let next = try current.withFD {
        try checked(
          openat(
            $0, component,
            O_CLOEXEC | noFollow | O_NONBLOCK | (last ? flags : O_EVTONLY | O_DIRECTORY)))
      }
      current = Descriptor(next)
    }
    return current
  }
  func namedPath(_ requested: String, _ handle: Descriptor) throws -> String {
    let canonical = try relativePath(handle)
    var info = stat()
    try handle.withFD { try checked(fstat($0, &info)) }
    if info.st_mode & S_IFMT != S_IFDIR, info.st_nlink > 1, canonical != requested {
      let actual = (canonical as NSString).lastPathComponent
      let name = (requested as NSString).lastPathComponent
      // A vnode's preferred hardlink name is not a pathname canonicalizer.
      // Accept only an unambiguous ASCII case alias on an insensitive volume;
      // otherwise require a fresh lookup, never silently choose another link.
      let sameParent =
        (canonical as NSString).deletingLastPathComponent
        == (requested as NSString).deletingLastPathComponent
      let insensitive = handle.withFD { fpathconf($0, _PC_CASE_SENSITIVE) == 0 }
      guard sameParent, insensitive, actual.utf8.allSatisfy({ $0 < 128 }),
        name.utf8.allSatisfy({ $0 < 128 }), actual.lowercased() == name.lowercased()
      else {
        throw failure(
          ESTALE, reason: "Backing vnode names a different or ambiguous hardlink alias.")
      }
    }
    return canonical
  }
  func targetPath(_ directory: Record, name: String) throws -> String {
    let path = try childPath(directory.path, name)
    do { return try namedPath(path, descriptor(path)) } catch {
      if (error as NSError).code == Int(ENOENT) { return path }
      throw error
    }
  }
  func verifyName(_ directory: Record, name: String, record: Record) throws {
    try validate(descriptor(try childPath(directory.path, name)), record: record)
  }
  func authorizeNamespace(_ items: [Record], paths: [String]) async throws {
    let before = items.map { ($0, $0.path) }
    try await authorize(paths, .write)
    for (record, path) in before {
      try refresh(record)
      guard records[record.item.id] === record, record.path == path else {
        throw failure(ESTALE)
      }
    }
  }
  func discover(_ path: String, parent: UInt64, candidate: Descriptor? = nil) throws -> Record {
    let fd = try candidate ?? descriptor(path)
    var info = stat()
    try checked(fstat(fd.value, &info))
    if let id = paths[path], let existing = records[id],
      info.st_dev == existing.device, info.st_ino == existing.inode
    {
      return existing
    }
    let id: UInt64
    if let existing = paths[path], records[existing] == nil {
      id = existing
    } else {
      guard nextID != UInt64.max else { throw failure(EOVERFLOW) }
      id = nextID
      nextID += 1
    }
    let value = try Record(id: id, path: path, parent: parent, descriptor: fd)
    value.parentFileID = try parentFileIdentifier(path)
    records[value.item.id] = value
    paths[path] = value.item.id
    return value
  }
  func discardCreated(_ record: Record, parent: Descriptor, named name: String) {
    parent.withFD { fd in
      var current = stat()
      if fstatat(fd, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
        record.device == current.st_dev, record.inode == current.st_ino,
        unlinkat(fd, name, current.st_mode & S_IFMT == S_IFDIR ? AT_REMOVEDIR : 0) != 0
      {
        log.error("Creation rollback failed for \(record.path): \(errno)")
      }
    }
    records.removeValue(forKey: record.item.id)
    if paths[record.path] == record.item.id { paths.removeValue(forKey: record.path) }
  }

  func attributes(_ record: Record, using fd: Int32? = nil) throws -> sending FSItem.Attributes {
    var info = stat()
    if let fd {
      try checked(fstat(fd, &info))
    } else {
      try handle(record).withFD { try checked(fstat($0, &info)) }
    }
    return try attributes(record, info: info)
  }
  func attributes(_ record: Record, info: stat) throws -> sending FSItem.Attributes {
    let result = FSItem.Attributes()
    result.fileID = FSItem.Identifier(try fileIdentifier(record))
    result.parentID = record.item.id == 2 ? .parentOfRoot : FSItem.Identifier(record.parentFileID)
    result.type = itemType(info.st_mode)
    result.uid = info.st_uid
    result.gid = info.st_gid
    result.mode = policy.projectedMode(info.st_mode, at: record.path)
    result.flags = info.st_flags
    result.linkCount = UInt32(info.st_nlink)
    result.size = UInt64(max(0, info.st_size))
    if info.st_mode & S_IFMT == S_IFLNK, let target = try? renderLinkTarget(record) {
      // All result classes request size. A readable projected link reports its
      // actual rendered byte count, including when rebasing makes it longer.
      result.size = UInt64(target.utf8.count)
    }
    // If the target cannot currently be rendered (denied, unresolved, or
    // awaiting approval), retain the real backing size for lstat/unlink. The
    // readlink surface reports that condition rather than inventing contents.
    result.allocSize = UInt64(max(0, info.st_blocks)) * 512
    result.accessTime = info.st_atimespec
    result.modifyTime = info.st_mtimespec
    result.changeTime = info.st_ctimespec
    result.birthTime = info.st_birthtimespec
    return result
  }
  func reader(_ record: Record) throws -> Descriptor {
    if let fd = record.readDescriptor { return fd }
    let fd = try descriptor(record.path, flags: O_RDONLY)
    try validate(fd, record: record)
    record.readDescriptor = fd
    return fd
  }
  func writer(_ record: Record) throws -> Descriptor {
    if let fd = record.writeDescriptor { return fd }
    let fd = try descriptor(record.path, flags: O_WRONLY)
    try validate(fd, record: record)
    record.writeDescriptor = fd
    return fd
  }
  func reclaim(_ id: UInt64) async {
    await drainIO(for: id)
    guard let value = records[id], id != 2 else { return }
    value.item.tryReclaim {
      self.records.removeValue(forKey: id)
      if self.paths[value.path] == id { self.paths.removeValue(forKey: value.path) }
    }
  }
  func close(_ id: UInt64) {
    records[id]?.grants = []
    records[id]?.readDescriptor = nil
    records[id]?.writeDescriptor = nil
    records[id]?.descriptor = nil
    records[id]?.listings.removeAll()
    records[id]?.listed = nil
  }
  func apply(_ changes: AttributeChanges, to record: Record) throws {
    let handle = try self.handle(record)
    defer { withExtendedLifetime(handle) {} }
    let fd = handle.value
    if !changes.consumed.isEmpty { try noteMutation(fd) }
    if let size = changes.size {
      var info = stat()
      try checked(fstat(fd, &info))
      // FSVolume.Handler requires size requests on directories and symlinks
      // to be ignored, including attributes supplied alongside creation.
      let kind = info.st_mode & S_IFMT
      if kind != S_IFDIR && kind != S_IFLNK {
        guard size <= UInt64(Int64.max) else { throw failure(EFBIG) }
        try checked(ftruncate(try writer(record).value, off_t(size)))
      }
    }
    if changes.uid != nil || changes.gid != nil {
      try checked(fchown(fd, changes.uid ?? uid_t.max, changes.gid ?? gid_t.max))
    }
    if let mode = changes.mode { try checked(fchmod(fd, mode_t(mode))) }
    if changes.accessTime != nil || changes.modifyTime != nil {
      let times = [
        changes.accessTime ?? timespec(tv_sec: 0, tv_nsec: Int(UTIME_OMIT)),
        changes.modifyTime ?? timespec(tv_sec: 0, tv_nsec: Int(UTIME_OMIT)),
      ]
      try checked(futimens(fd, times))
    }
    if var birth = changes.birthTime {
      var list = attrlist()
      list.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
      list.commonattr = attrgroup_t(ATTR_CMN_CRTIME)
      try checked(fsetattrlist(fd, &list, &birth, MemoryLayout<timespec>.size, 0))
    }
    if let flags = changes.flags { try checked(fchflags(fd, flags)) }
  }

  func beginEnumeration(_ id: UInt64, cookie: UInt64, verifier: UInt64) async throws -> Enumeration
  {
    let directory = try record(id)
    try refresh(directory)
    guard try attributes(directory).type == .directory else { throw failure(ENOTDIR) }
    let path = directory.path
    try await authorize([path], .read, traversal: true)
    guard records[id] === directory, directory.path == path else { throw failure(ESTALE) }
    if cookie >= 2, let resumed = directory.listings[verifier] {
      return Enumeration(id: id, path: path, verifier: verifier, names: resumed)
    }
    let names = try entryNames(directory)
    if let listed = directory.listed, directory.listings[listed] == names {
      return Enumeration(id: id, path: path, verifier: listed, names: names)
    }
    let issued: UInt64
    if cookie >= 2 {
      issued = verifier
    } else {
      guard nextVerifier != UInt64.max else { throw failure(EOVERFLOW) }
      issued = nextVerifier
      nextVerifier += 1
    }
    directory.listings[issued] = names
    directory.listed = issued
    return Enumeration(id: id, path: path, verifier: issued, names: names)
  }
  func entryNames(_ directory: Record) throws -> [String] {
    let fd = try handle(directory).withFD {
      try checked(openat($0, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC))
    }
    guard let stream = fdopendir(fd) else {
      let error = failure()
      Darwin.close(fd)
      throw error
    }
    defer { closedir(stream) }
    var names: [String] = []
    while true {
      errno = 0
      guard let entry = readdir(stream) else {
        if errno != 0 { throw failure() }
        return names
      }
      let name = withUnsafePointer(to: &entry.pointee.d_name) {
        $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) {
          String(cString: $0)
        }
      }
      if name == "." || name == ".." { continue }
      names.append(name)
    }
  }
  func nextEntry(_ enumeration: Enumeration, cookie: UInt64, wantsAttributes: Bool) throws
    -> sending DirectoryEntry?
  {
    try check()
    let id = enumeration.id
    let directory = try record(id)
    try refresh(directory)
    guard directory.path == enumeration.path else {
      throw failure(Int32(FSError.Code.invalidDirectoryCookie.rawValue))
    }
    // FSVolume.h requires dot entries for plain readdir, but not for readdir
    // with attributes. Reserve cookies 0/1; snapshot indices start at 2.
    if !wantsAttributes, cookie < 2 {
      return DirectoryEntry(
        name: cookie == 0 ? "." : "..",
        id: cookie == 0 ? try fileIdentifier(directory) : directory.parentFileID,
        nextCookie: cookie + 1,
        type: .directory, attributes: nil)
    }
    let start = cookie < 2 ? 0 : cookie - 2
    guard start <= UInt64(enumeration.names.count) else { throw failure(EINVAL) }
    let parentHandle = try handle(directory)
    defer { withExtendedLifetime(parentHandle) {} }
    for index in Int(start)..<enumeration.names.count {
      let name = enumeration.names[index]
      let next = UInt64(index) + 1
      let path = try childPath(directory.path, name)
      if !policy.traversable(path) { continue }
      // Enumerating names doesn't approve reading their contents. Only include
      // attributes when their read policy allows them without a prompt.
      let child: Record
      let attrs: FSItem.Attributes
      do {
        // Listing metadata must not require opening a child's contents (for
        // example, macOS /.file has mode 000 but can still be listed/stat'ed).
        var info = stat()
        try checked(fstatat(parentHandle.value, name, &info, AT_SYMLINK_NOFOLLOW))
        if let oldID = paths[path], let old = records[oldID],
          old.device != info.st_dev || old.inode != info.st_ino
        {
          paths.removeValue(forKey: path)
        }
        let entryID = try identifier(path)
        // Readdir identifiers are not live FSItems: FSKit cannot reclaim an
        // item it was never handed. Keep no descriptor per enumerated name.
        child = records[entryID] ?? Record(id: entryID, path: path, parent: id, info: info)
        child.parentFileID = try fileIdentifier(directory)
        attrs = try attributes(child, info: info)
      } catch {
        if (error as NSError).code == Int(ENOENT) { continue }
        throw error
      }
      if attrs.type != .directory && policy.mode(path) == .deny { continue }
      // Attribute-based enumeration must expose traversable ancestors just as
      // lookup/getAttributes do. Passing nil here makes FSKit's bulk listing
      // stop at that entry, even though name-only readdir can return it.
      let mode = policy.mode(path)
      let type = attrs.type
      let mayReadAttributes = mode.decision(.read) == .allow
        || (type == .directory && mode == .deny && policy.traversable(path))
      return DirectoryEntry(
        name: name, id: attrs.fileID.rawValue, nextCookie: next + 2, type: attrs.type,
        attributes: wantsAttributes && mayReadAttributes ? attrs : nil)
    }
    return nil
  }
}
private func itemType(_ mode: mode_t) -> FSItem.ItemType {
  switch mode & S_IFMT {
  case S_IFREG: return .file
  case S_IFDIR: return .directory
  case S_IFLNK: return .symlink
  case S_IFIFO: return .fifo
  case S_IFCHR: return .charDevice
  case S_IFBLK: return .blockDevice
  case S_IFSOCK: return .socket
  default: return .unknown
  }
}

private final class PermissionFSVolume: FSVolume, FSVolume.Handler,
  FSVolume.ReadWriteHandler, FSVolume.OpenCloseHandler
{
  let state: VolumeState
  let rootFD: Int32
  let readOnly: Bool
  init(readOnly: Bool) throws {
    self.readOnly = readOnly
    // The generic resource identifies the session, not a host volume to mount.
    // Backing operations use host paths and remain subject to OS access checks.
    rootFD = try checked(Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC))
    let copy: Int32
    do { copy = try checked(fcntl(rootFD, F_DUPFD_CLOEXEC, 0)) } catch {
      Darwin.close(rootFD)
      throw error
    }
    do { state = try VolumeState(rootFD: copy, writable: !readOnly) } catch {
      Darwin.close(rootFD)
      throw error
    }
    super.init(
      volumeID: FSVolume.Identifier(uuid: UUID()), volumeName: FSFileName(string: "PermissionFS"))
  }
  deinit {
    Darwin.close(rootFD)
  }
  private func id(_ item: FSItem) -> UInt64 { (item as? Item)?.id ?? 0 }
  var requestedMountOptions: FSVolume.MountOptions { readOnly ? .readOnly : [] }
  var supportedVolumeCapabilities: FSVolume.SupportedCapabilities {
    let value = FSVolume.SupportedCapabilities()
    value.supportsHardLinks = true
    value.supportsSymbolicLinks = true
    value.supportsPersistentObjectIDs = false
    value.supports64BitObjectIDs = true
    value.supportsHiddenFiles = true
    return value
  }
  var maximumLinkCount: Int { fpathconf(rootFD, _PC_LINK_MAX) }
  var maximumNameLength: Int { fpathconf(rootFD, _PC_NAME_MAX) }
  var restrictsOwnershipChanges: Bool { fpathconf(rootFD, _PC_CHOWN_RESTRICTED) == 1 }
  var truncatesLongNames: Bool { fpathconf(rootFD, _PC_NO_TRUNC) == 0 }
  var volumeStatistics: FSStatFSResult {
    let result = FSStatFSResult(fileSystemTypeName: "permissionfs")
    var info = statfs()
    // The SDK's synchronous property has no error result (Apple's passthrough
    // sample returns the unpopulated result on fstatfs failure as well).
    guard fstatfs(rootFD, &info) == 0 else {
      log.error("fstatfs failed: \(errno)")
      return result
    }
    result.blockSize = Int(info.f_bsize)
    result.ioSize = Int(info.f_iosize)
    result.totalBlocks = info.f_blocks
    result.availableBlocks = info.f_bavail
    result.freeBlocks = info.f_bfree
    result.usedBlocks = info.f_blocks - info.f_bfree
    result.totalFiles = info.f_files
    result.freeFiles = info.f_ffree
    result.fileSystemSubType = Int(info.f_fssubtype)
    return result
  }
  func activateVolume(
    options: FSTaskOptions,
    replyHandler: @escaping @Sendable (FSActivateResult?, Error?) -> Void
  ) {
    let arguments = options.taskOptions
    var url: URL?
    if let index = arguments.firstIndex(of: "-s"), index + 1 < arguments.count {
      let path = arguments[index + 1]
      if validPath(path) {
        url = URL(fileURLWithPath: path)
      }
    }
    let state = state
    Task { await state.activate(url: url, reply: replyHandler) }
  }
  func deactivateVolume(options: FSDeactivateOptions) async throws {
    // FSVolume.h: other items are reclaimed and cleanup I/O has already synced.
    await state.stop(deactivating: true)
  }
  func mount(options: FSTaskOptions) async throws { try await state.check() }
  func unmount() async { await state.stop() }
  func synchronize(flags: FSSyncFlags) async throws {
    // A root resource can cross several mounted backing volumes. Flush each
    // mutated volume, including files whose handles have already closed.
    defer { withExtendedLifetime(self) {} }
    let nativeFlags: Int32
    switch flags {
    case .noWait: nativeFlags = 0
    case .wait, .dWait: nativeFlags = SYNC_VOLUME_WAIT
    @unknown default: throw failure(EINVAL)
    }
    let pending = try await state.prepareSync()
    defer { for volume in pending { try? volume.handle.close() } }
    for volume in pending {
      try synchronizeBackingVolume(volume.handle.fileDescriptor, flags: nativeFlags)
    }
    await state.completeSync(pending, waited: nativeFlags == SYNC_VOLUME_WAIT)
  }
  func reclaimItem(_ item: FSItem) async throws { await state.reclaim(id(item)) }
  func attributes(_ request: FSItem.GetAttributesRequest, of item: FSItem, context: FSContext)
    async throws -> FSGetAttributesResult
  {
    let id = id(item)
    return try await state.getAttributesResult(id: id)
  }
  func lookupItem(
    named name: FSFileName, in directory: FSItem, context: FSContext,
    replyHandler: @escaping @Sendable (FSLookupItemResult?, Error?) -> Void
  ) {
    let parent = self.id(directory)
    let name = name.string
    let state = state
    Task { await state.lookup(parent: parent, name: name, reply: replyHandler) }
  }
  func enumerateDirectory(
    _ directory: FSItem, startingAt cookie: FSDirectoryCookie,
    verifier: FSDirectoryVerifier, attributes: FSItem.GetAttributesRequest?,
    packer: FSDirectoryEntryPacker, context: FSContext
  ) async throws -> FSEnumerateDirectoryResult {
    let enumeration = try await state.beginEnumeration(
      id(directory), cookie: cookie.rawValue, verifier: verifier.rawValue)
    var cursor = cookie.rawValue
    while let entry = try await state.nextEntry(
      enumeration, cookie: cursor, wantsAttributes: attributes != nil)
    {
      if !packer.packEntry(
        name: FSFileName(string: entry.name), itemType: entry.type,
        itemID: FSItem.Identifier(entry.id), nextCookie: FSDirectoryCookie(entry.nextCookie),
        attributes: entry.attributes)
      {
        break
      }
      cursor = entry.nextCookie
    }
    try await state.check()
    return try required(FSEnumerateDirectoryResult(verifier: enumeration.verifier))
  }

  private func requested(_ modes: FSVolume.OpenModes) -> Access {
    var access: Access = []
    if modes.contains(.read) { access.insert(.read) }
    if modes.contains(.write) { access.insert(.write) }
    return access
  }
  func openItem(_ item: FSItem, modes: FSVolume.OpenModes, context: FSContext) async throws {
    let id = self.id(item)
    let access = requested(modes)
    try await state.openItem(id: id, requested: access.isEmpty ? .read : access)
  }
  func closeItem(_ item: FSItem, modes: FSVolume.OpenModes, context: FSContext) async throws {
    let id = self.id(item)
    await state.closeItem(id: id, keeping: requested(modes))
  }
  func read(from item: FSItem, at offset: off_t, length: Int, into buffer: FSMutableFileDataBuffer)
    async throws -> FSReadFileResult
  {
    guard offset >= 0, length >= 0, length <= buffer.length else { throw failure(EINVAL) }
    let access = try await state.beginIO(id(item), write: false)
    do {
      let count = try buffer.withUnsafeMutableBytes {
        try checked(pread(access.handle.fileDescriptor, $0.baseAddress, length, offset))
      }
      let attributes = try await state.completeIO(access, write: false)
      return try required(FSReadFileResult(bytesRead: count, itemAttributes: attributes))
    } catch {
      await state.finishIO(access)
      throw error
    }
  }

  func write(contents: Data, to item: FSItem, at offset: off_t) async throws -> FSWriteFileResult {
    guard offset >= 0 else { throw failure(EINVAL) }
    let access = try await state.beginIO(id(item), write: true)
    do {
      let count = try contents.withUnsafeBytes {
        try checked(pwrite(access.handle.fileDescriptor, $0.baseAddress, $0.count, offset))
      }
      let attributes = try await state.completeIO(access, write: true)
      return try required(
        FSWriteFileResult(bytesWritten: count, itemAttributes: attributes, freeSpace: nil))
    } catch {
      await state.finishIO(access)
      throw error
    }
  }

  func setAttributes(_ request: FSItem.SetAttributesRequest, on item: FSItem, context: FSContext)
    async throws -> FSSetAttributesResult
  {
    let changes = try AttributeChanges(request)
    let result = try await state.setAttributesResult(id: id(item), changes: changes)
    request.consumedAttributes = changes.consumed
    return result
  }

  func createItem(
    named name: FSFileName, type: FSItem.ItemType, in directory: FSItem,
    attributes: FSItem.SetAttributesRequest, context: FSContext,
    replyHandler: @escaping @Sendable (FSCreateItemResult?, Error?) -> Void
  ) {
    let parent = self.id(directory)
    let name = name.string
    do {
      let changes = try AttributeChanges(attributes, creating: true)
      // FSKit inspects consumption at completion. Report the handled fields;
      // directory/symlink size is explicitly a no-op under the SDK contract.
      // A failure applying other supported fields returns an error.
      attributes.consumedAttributes = changes.consumed
      let state = state
      Task {
        await state.create(
          parent: parent, name: name, type: type, changes: changes, reply: replyHandler)
      }
    } catch { replyHandler(nil, error) }
  }
  func createSymbolicLink(
    named name: FSFileName, in directory: FSItem,
    attributes: FSItem.SetAttributesRequest, linkContents: FSFileName, context: FSContext,
    replyHandler: @escaping @Sendable (FSCreateSymlinkResult?, Error?) -> Void
  ) {
    let parent = self.id(directory)
    let name = name.string
    let target = linkContents.string
    do {
      let changes = try AttributeChanges(attributes, creating: true)
      // FSKit inspects consumption at completion. Report the handled fields;
      // directory/symlink size is explicitly a no-op under the SDK contract.
      // A failure applying other supported fields returns an error.
      attributes.consumedAttributes = changes.consumed
      let state = state
      Task {
        await state.createSymlink(
          parent: parent, name: name, target: target, changes: changes, reply: replyHandler)
      }
    } catch { replyHandler(nil, error) }
  }
  func readSymbolicLink(_ item: FSItem, context: FSContext) async throws -> FSReadSymlinkResult {
    let id = id(item)
    return try await state.readSymlinkResult(id: id)
  }
  func createLink(to item: FSItem, named name: FSFileName, in directory: FSItem, context: FSContext)
    async throws -> FSCreateLinkResult
  {
    let id = id(item)
    let parent = self.id(directory)
    let name = name.string
    return try await state.createLinkResult(id: id, parent: parent, name: name)
  }
  func renameItem(
    _ item: FSItem, inDirectory source: FSItem, named name: FSFileName,
    to newName: FSFileName, inDirectory destination: FSItem, overItem: FSItem?, context: FSContext
  ) async throws -> FSRenameItemResult {
    let id = id(item)
    let from = self.id(source)
    let to = self.id(destination)
    let name = name.string
    let newName = newName.string
    let over = overItem.map { self.id($0) }
    return try await state.renameResult(
      id: id, from: from, to: to, name: name, newName: newName, over: over)
  }
  func removeItem(
    _ item: FSItem, named name: FSFileName, from directory: FSItem, context: FSContext
  ) async throws -> FSRemoveItemResult {
    let id = id(item)
    let parent = self.id(directory)
    let name = name.string
    return try await state.removeResult(id: id, parent: parent, name: name)
  }
}

extension VolumeState {
  fileprivate func renamePaths(from source: String, to destination: String) -> [String] {
    // A directory move also changes every descendant's policy path. Check the
    // explicit boundaries in both trees, including restrictions not yet looked
    // up by FSKit; an rw ancestor cannot move a denied subtree out of its rule.
    var affected = [source, destination]
    for scope in policy.scopes {
      if covers(source, scope.path) {
        affected += [scope.path, destination + scope.path.dropFirst(source.count)]
      }
      if covers(destination, scope.path) {
        affected += [scope.path, source + scope.path.dropFirst(destination.count)]
      }
    }
    return affected
  }
  fileprivate func renamed(
    from source: String, to destination: String, parent: UInt64, parentFileID: UInt64, over: UInt64?
  ) {
    if let over, let record = records[over], paths[record.path] == over {
      paths.removeValue(forKey: record.path)
      record.unlinked = true
    }
    for record in records.values where covers(source, record.path) {
      paths.removeValue(forKey: record.path)
      record.path = destination + record.path.dropFirst(source.count)
      record.grants = []
      paths[record.path] = record.item.id
      if record.path == destination {
        record.parent = parent
        record.parentFileID = parentFileID
      }
    }
  }
  fileprivate func unlinked(_ path: String) {
    if let id = paths.removeValue(forKey: path) { records[id]?.unlinked = true }
  }
}

final class PermissionFSUnary: FSUnaryFileSystem, FSUnaryFileSystemOperations {
  func probeResource(resource: FSResource) async throws -> FSProbeResult {
    guard let resource = resource as? FSGenericURLResource,
      resource.url.scheme?.lowercased() == "pi-fs"
    else { return .notRecognized }
    return .usable(name: "PermissionFS", containerID: FSContainerIdentifier(uuid: UUID()))
  }
  func loadResource(resource: FSResource, options: FSTaskOptions) async throws -> FSVolume {
    guard let resource = resource as? FSGenericURLResource,
      resource.url.scheme?.lowercased() == "pi-fs"
    else { throw failure(EINVAL) }
    guard !options.taskOptions.contains("-f") else { throw failure(ENOTSUP) }
    try configureDescriptorLimit()
    let volume = try PermissionFSVolume(readOnly: options.taskOptions.contains("--rdonly"))
    containerStatus = .ready
    return volume
  }
  func unloadResource(resource: FSResource, options: FSTaskOptions) async throws {
    containerStatus = .notReady(status: failure(ENODEV))
  }
}
@main
struct PermissionFSExtension: UnaryFileSystemExtension {
  var fileSystem: PermissionFSUnary { PermissionFSUnary() }
}

extension VolumeState {
  fileprivate func activate(
    url: URL?, reply: @Sendable (FSActivateResult?, Error?) -> Void
  ) async {
    do {
      guard let url else { throw failure(EINVAL) }
      try await connect(url: url)
      let root = try record(2)
      let result = try required(FSActivateResult(rootItem: root.item))
      reply(result, nil)
    } catch {
      await stop()
      reply(nil, error)
    }
  }
  fileprivate func getAttributesResult(id: UInt64) async throws -> sending FSGetAttributesResult {
    let record = try self.record(id)
    try await self.authorize(record, .read, traversal: true)
    return try required(FSGetAttributesResult(attributes: self.attributes(record)))
  }
  fileprivate func lookup(
    parent: UInt64, name: String?, reply: @Sendable (FSLookupItemResult?, Error?) -> Void
  ) async {
    do {
      let directory = try record(parent)
      try refresh(directory)
      guard try attributes(directory).type == .directory else { throw failure(ENOTDIR) }
      let name = try required(name)
      let parentPath = directory.path
      let requestedPath: String
      switch name {
      case ".": requestedPath = parentPath
      case "..": requestedPath = (parentPath as NSString).deletingLastPathComponent
      default: requestedPath = try childPath(parentPath, name)
      }
      // Match only after backing canonicalization, so a differently cased
      // spelling cannot defeat (or hide) the actual path's nested rule.
      let candidate = try descriptor(requestedPath)
      defer { withExtendedLifetime(candidate) {} }
      let path = try namedPath(requestedPath, candidate)
      try await authorize([path], .read, traversal: true)
      guard records[parent] === directory, directory.path == parentPath else {
        throw failure(ESTALE)
      }
      // No suspension from final validation through publication. Reclaim runs
      // on this actor and cannot interleave with the actual FSKit reply.
      try refresh(directory)
      let current = try descriptor(path)
      var before = stat()
      var after = stat()
      try candidate.withFD { try checked(fstat($0, &before)) }
      try current.withFD { try checked(fstat($0, &after)) }
      guard directory.path == parentPath, try namedPath(path, current) == path,
        before.st_dev == after.st_dev, before.st_ino == after.st_ino
      else { throw failure(ESTALE) }
      let targetParent =
        name == "." || name == ".."
        ? try identifier((path as NSString).deletingLastPathComponent) : parent
      let found = try discover(path, parent: targetParent, candidate: candidate)
      if policy.mode(path).decision(.read) == .ask { found.grants.insert(.read) }
      let attributes = try self.attributes(found, using: candidate.value)
      guard attributes.type == .directory || policy.mode(path) != .deny else {
        throw failure(EACCES)
      }
      let result = try required(
        FSLookupItemResult(
          foundItem: found.item,
          itemName: FSFileName(
            string: name == "." || name == ".." ? name : (path as NSString).lastPathComponent),
          itemAttributes: attributes))
      found.descriptor = nil
      reply(result, nil)
    } catch { reply(nil, error) }
  }
  fileprivate func openItem(id: UInt64, requested: Access) async throws {
    let record = try self.record(id)
    try await self.authorize(record, requested, traversal: true)
    if requested.contains(.read) { _ = try self.reader(record) }
    if requested.contains(.write) { _ = try self.writer(record) }
    record.opened.formUnion(requested)
  }
  fileprivate func closeItem(id: UInt64, keeping: Access) {
    guard let record = records[id] else { return }
    record.opened.formIntersection(keeping)
    if record.opened.isEmpty {
      close(id)
    } else if !record.unlinked {
      if !record.opened.contains(.write) { record.writeDescriptor = nil }
      if !record.opened.contains(.read) { record.readDescriptor = nil }
    }
  }
  fileprivate func beginIO(_ id: UInt64, write: Bool) async throws -> DataAccess {
    let record = try self.record(id)
    let right: Access = write ? .write : .read
    if !record.opened.contains(right) { try await authorize(record, right) }
    let descriptor = try write ? writer(record) : reader(record)
    let handle = FileHandle(
      fileDescriptor: try checked(fcntl(descriptor.value, F_DUPFD_CLOEXEC, 0)), closeOnDealloc: true
    )
    if write { try noteMutation(handle.fileDescriptor) }
    let access = DataAccess(token: UUID(), itemID: id, path: record.path, handle: handle)
    activeIO[access.token] = id
    return access
  }
  fileprivate func completeIO(_ access: DataAccess, write: Bool) throws -> sending FSItem.Attributes
  {
    defer { finishIO(access) }
    guard activeIO[access.token] == access.itemID else { throw failure(ESTALE) }
    guard let record = records[access.itemID] else { throw failure(ESTALE) }
    if write { try noteMutation(access.handle.fileDescriptor) }
    if !write {
      try check()
      try refresh(record, using: access.handle.fileDescriptor)
      if record.path != access.path, policy.mode(record.path).decision(.read) != .allow {
        throw failure(EACCES)
      }
    }
    return try attributes(record, using: access.handle.fileDescriptor)
  }
  fileprivate func finishIO(_ access: DataAccess) {
    guard activeIO.removeValue(forKey: access.token) != nil else { return }
    let ready = ioWaiters.filter { id, _ in !activeIO.values.contains { id == nil || $0 == id } }
    ioWaiters.removeAll { id, _ in !activeIO.values.contains { id == nil || $0 == id } }
    for (_, waiter) in ready { waiter.resume() }
  }
  fileprivate func drainIO(for id: UInt64? = nil) async {
    if activeIO.values.contains(where: { id == nil || $0 == id }) {
      await withCheckedContinuation { ioWaiters.append((id, $0)) }
    }
  }
  fileprivate func setAttributesResult(id: UInt64, changes: AttributeChanges) async throws
    -> sending FSSetAttributesResult
  {
    let record = try self.record(id)
    try await authorize(record, .write)
    try apply(changes, to: record)
    return try required(FSSetAttributesResult(attributes: attributes(record), freeSpace: nil))
  }
  fileprivate func create(
    parent: UInt64, name: String?, type: FSItem.ItemType, changes: AttributeChanges,
    reply: @Sendable (FSCreateItemResult?, Error?) -> Void
  ) async {
    do {
      let directory = try self.record(parent)
      let parentPath = directory.path
      let name = try required(name)
      let path = try targetPath(directory, name: name)
      try await authorizeNamespace([directory], paths: [path])
      guard try targetPath(directory, name: name) == path else { throw failure(ESTALE) }
      try refresh(directory)
      guard records[parent] === directory, directory.path == parentPath else {
        throw failure(ESTALE)
      }
      let parentHandle = try handle(directory)
      defer { withExtendedLifetime(parentHandle) {} }
      try noteMutation(parentHandle.value)
      let mode = changes.mode.map(mode_t.init) ?? mode_t(type == .directory ? 0o777 : 0o666)
      let handle: Descriptor
      switch type {
      case .file:
        handle = Descriptor(
          try checked(
            openat(parentHandle.value, name, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, mode)))
      case .directory:
        try checked(mkdirat(parentHandle.value, name, mode))
        handle = Descriptor(
          try checked(
            openat(parentHandle.value, name, O_EVTONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)))
      case .fifo:
        try checked(mkfifoat(parentHandle.value, name, mode))
        handle = Descriptor(
          try checked(openat(parentHandle.value, name, O_EVTONLY | O_NOFOLLOW | O_CLOEXEC)))
      default: throw failure(ENOTSUP)
      }
      let record = try self.discover(path, parent: parent, candidate: handle)
      if type == .file { record.writeDescriptor = handle }
      if policy.mode(path).decision(.write) == .ask { record.grants.insert(.write) }
      do {
        try self.apply(changes, to: record)
        let result = try required(
          FSCreateItemResult(
            newItem: record.item, newItemName: FSFileName(string: name),
            newItemAttributes: self.attributes(record),
            directoryAttributes: self.attributes(directory), freeSpace: nil))
        record.descriptor = nil
        reply(result, nil)
      } catch {
        discardCreated(record, parent: parentHandle, named: name)
        throw error
      }
    } catch { reply(nil, error) }
  }

  fileprivate func createSymlink(
    parent: UInt64, name: String?, target: String?, changes: AttributeChanges,
    reply: @Sendable (FSCreateSymlinkResult?, Error?) -> Void
  ) async {
    do {
      let directory = try self.record(parent)
      let parentPath = directory.path
      let name = try required(name)
      let path = try targetPath(directory, name: name)
      let target = try required(target)
      guard !target.contains("\0") else { throw failure(EINVAL) }
      try await authorizeNamespace([directory], paths: [path])
      guard try targetPath(directory, name: name) == path else { throw failure(ESTALE) }
      try refresh(directory)
      guard records[parent] === directory, directory.path == parentPath else {
        throw failure(ESTALE)
      }
      let parentHandle = try handle(directory)
      defer { withExtendedLifetime(parentHandle) {} }
      try noteMutation(parentHandle.value)
      try checked(symlinkat(target, parentHandle.value, name))
      let handle = Descriptor(
        try checked(openat(parentHandle.value, name, O_SYMLINK | O_EVTONLY | O_CLOEXEC)))
      let record = try self.discover(path, parent: parent, candidate: handle)
      if policy.mode(path).decision(.write) == .ask { record.grants.insert(.write) }
      do {
        try self.apply(changes, to: record)
        let result = try required(
          FSCreateSymlinkResult(
            newItem: record.item, newItemName: FSFileName(string: name),
            newItemAttributes: self.attributes(record),
            directoryAttributes: self.attributes(directory), freeSpace: nil))
        record.descriptor = nil
        reply(result, nil)
      } catch {
        discardCreated(record, parent: parentHandle, named: name)
        throw error
      }
    } catch { reply(nil, error) }
  }

  // Read the actual link, without following it. Keep this separate from the
  // projected representation: backing names and stored link bytes never change.
  fileprivate func linkContents(_ path: String, identity: Descriptor) throws -> String {
    let parent = try descriptor((path as NSString).deletingLastPathComponent)
    defer { withExtendedLifetime((parent, identity)) {} }
    let name = (path as NSString).lastPathComponent
    var expected = stat()
    var current = stat()
    try checked(fstat(identity.value, &expected))
    guard expected.st_mode & S_IFMT == S_IFLNK else { throw failure(EINVAL) }
    var size = max(256, Int(expected.st_size) + 1)
    while true {
      var bytes = [UInt8](repeating: 0, count: size)
      let count = try checked(readlinkat(parent.value, name, &bytes, size))
      try checked(fstatat(parent.value, name, &current, AT_SYMLINK_NOFOLLOW))
      guard expected.st_dev == current.st_dev, expected.st_ino == current.st_ino else {
        throw failure(ESTALE)
      }
      if count < size {
        guard let target = String(bytes: bytes.prefix(count), encoding: .utf8) else {
          throw failure(EILSEQ)
        }
        return target
      }
      guard size <= Int.max / 2 else { throw failure(EOVERFLOW) }
      size *= 2
    }
  }

  fileprivate func linkReadAllowed(_ path: String, traversal: Bool = false, approved: Set<String>)
    throws
  {
    let mode = policy.mode(path)
    if traversal, mode == .deny, policy.traversable(path) { return }
    switch mode.decision(.read) {
    case .allow: return
    case .deny: throw failure(EACCES)
    case .ask:
      if approved.contains(path) { return }
      if let id = paths[path], records[id]?.grants.contains(.read) == true { return }
      throw LinkNeedsApproval(path: path, traversal: traversal)
    }
  }

  fileprivate func projectedLinkTarget(id: UInt64) async throws -> String {
    var approved: Set<String> = []
    while true {
      try check()
      let record = try self.record(id)
      try refresh(record)
      do { return try renderLinkTarget(record, approved: approved) } catch let request
        as LinkNeedsApproval
      {
        try await authorize([request.path], .read, traversal: request.traversal)
        try check()
        approved.insert(request.path)
        // Rewalk after suspension rather than carrying stale path resolutions.
      }
    }
  }

  fileprivate func renderLinkTarget(_ record: Record, approved: Set<String> = []) throws -> String {
    try check()
    let source = record.path
    try linkReadAllowed(source, approved: approved)
    let sourceHandle = try handle(record)
    defer { withExtendedLifetime(sourceHandle) {} }
    let original = try linkContents(source, identity: sourceHandle)
    let backingRoot = try root.withFD { try descriptorPath($0) }
    let sourceParent = (source as NSString).deletingLastPathComponent
    var resolved = sourceParent.split(separator: "/").map(String.init)

    // Absolute backing targets are rebased, not emitted as host absolute URLs.
    // Component traversal below handles '..' after resolving preceding links.
    func components(_ target: String) throws -> [String] {
      guard !target.isEmpty else { throw failure(ENOENT) }
      var value = target
      if target.hasPrefix("/") {
        guard covers(backingRoot, target) else {
          throw failure(
            EACCES, reason: "Absolute symbolic link target is outside the backing resource.")
        }
        resolved = []
        value = backingRoot == "/" ? target : String(target.dropFirst(backingRoot.count))
      }
      var parts = value.split(separator: "/").map(String.init)
      if value.hasSuffix("/"), !parts.isEmpty { parts.append(".") }
      return parts
    }
    func relativeTarget(_ destination: [String]) -> String {
      let origin = sourceParent.split(separator: "/").map(String.init)
      var common = 0
      while common < min(origin.count, destination.count), origin[common] == destination[common] {
        common += 1
      }
      let relative =
        Array(repeating: "..", count: origin.count - common) + destination.dropFirst(common)
      return relative.isEmpty ? "." : relative.joined(separator: "/")
    }
    var pending = try components(original)
    // Preserve ordinary chained and dangling links: names with no later '..'
    // cannot undo the containment of an intermediate link's own result.
    var sawName = false
    var needsWalk = false
    for component in pending {
      if component == ".." {
        needsWalk = needsWalk || sawName
      } else if component != "." {
        sawName = true
      }
    }
    if !needsWalk {
      while let first = pending.first, first == "." || first == ".." {
        pending.removeFirst()
        if first == ".." {
          guard !resolved.isEmpty else {
            throw failure(EACCES, reason: "Symbolic link traversal leaves the projected root.")
          }
          resolved.removeLast()
        }
      }
      guard try relativePath(sourceHandle) == source else { throw failure(ESTALE) }
      return relativeTarget(resolved + pending)
    }
    var links = 1
    var observed: [(String, dev_t, ino_t)] = []
    while !pending.isEmpty {
      let component = pending.removeFirst()
      if component == "." { continue }
      if component == ".." {
        guard !resolved.isEmpty else {
          throw failure(EACCES, reason: "Symbolic link traversal leaves the projected root.")
        }
        resolved.removeLast()
        continue
      }
      let parent = "/" + resolved.joined(separator: "/")
      let path = try childPath(parent, component)
      let candidate: Descriptor
      do { candidate = try descriptor(path) } catch {
        // A final missing leaf remains dangling (and O_CREAT still names that
        // leaf). Missing intermediates must not be collapsed through '..'.
        if (error as NSError).code == Int(ENOENT) {
          if !pending.contains("..") {
            resolved += [component] + pending
            pending = []
            break
          }
          throw failure(
            ENOENT,
            reason:
              "Projection cannot resolve parent traversal after a missing link-target component; the stored link itself may still be readable."
          )
        }
        throw error
      }
      let canonical = try namedPath(path, candidate)
      var info = stat()
      try candidate.withFD { try checked(fstat($0, &info)) }
      observed.append((canonical, info.st_dev, info.st_ino))
      if info.st_mode & S_IFMT == S_IFLNK {
        guard links < Int(MAXSYMLINKS) else { throw failure(ELOOP) }
        links += 1
        try linkReadAllowed(canonical, approved: approved)
        let target = try linkContents(canonical, identity: candidate)
        resolved = (canonical as NSString).deletingLastPathComponent.split(separator: "/").map(
          String.init)
        pending = try components(target) + pending
      } else {
        if !pending.isEmpty {
          guard info.st_mode & S_IFMT == S_IFDIR else { throw failure(ENOTDIR) }
          try linkReadAllowed(canonical, traversal: true, approved: approved)
        }
        // No universal final-target read check: lookup/open enforce the actual
        // requested rights, including writes and creation through dangling links.
        resolved = canonical.split(separator: "/").map(String.init)
      }
    }
    guard try relativePath(sourceHandle) == source else { throw failure(ESTALE) }
    for (path, device, inode) in observed {
      var current = stat()
      try descriptor(path).withFD { try checked(fstat($0, &current)) }
      guard current.st_dev == device, current.st_ino == inode else { throw failure(ESTALE) }
    }
    return relativeTarget(resolved)
  }

  fileprivate func readSymlinkResult(id: UInt64) async throws -> sending FSReadSymlinkResult {
    let initial = try self.record(id)
    try refresh(initial)
    let source = initial.path
    let target = try await projectedLinkTarget(id: id)
    let record = try self.record(id)
    try refresh(record)
    guard record.path == source else { throw failure(ESTALE) }
    let snapshot = try attributes(record)
    snapshot.size = UInt64(target.utf8.count)
    return try required(
      FSReadSymlinkResult(contents: FSFileName(string: target), symlinkAttributes: snapshot))
  }
  fileprivate func createLinkResult(id: UInt64, parent: UInt64, name: String?) async throws
    -> sending FSCreateLinkResult
  {
    let record = try self.record(id)
    let directory = try self.record(parent)
    let name = try required(name)
    let path = try targetPath(directory, name: name)
    try await authorizeNamespace([record, directory], paths: [record.path, path])
    guard try targetPath(directory, name: name) == path else { throw failure(ESTALE) }
    let parentHandle = try handle(directory)
    defer { withExtendedLifetime(parentHandle) {} }
    let source = try descriptor(
      (record.path as NSString).deletingLastPathComponent, flags: O_EVTONLY | O_DIRECTORY)
    try noteMutation(parentHandle.value)
    try checked(
      linkat(
        source.value, (record.path as NSString).lastPathComponent,
        parentHandle.value, name, 0))
    record.hasAliases = true
    return try required(
      FSCreateLinkResult(
        linkName: FSFileName(string: name),
        linkAttributes: self.attributes(record), directoryAttributes: self.attributes(directory),
        freeSpace: nil))
  }
  fileprivate func renameResult(
    id: UInt64, from: UInt64, to: UInt64, name: String?, newName: String?, over: UInt64?
  ) async throws -> sending FSRenameItemResult {
    let record = try self.record(id)
    let source = try self.record(from)
    let destination = try self.record(to)
    let name = try required(name)
    let newName = try required(newName)
    let oldPath = try targetPath(source, name: name)
    let target = try targetPath(destination, name: newName)
    let newPath = try childPath(destination.path, newName)
    guard record.path == oldPath else { throw failure(ESTALE) }
    let affected = renamePaths(from: oldPath, to: target) + [newPath]
    try await authorizeNamespace([record, source, destination], paths: affected)
    guard try targetPath(destination, name: newName) == target else { throw failure(ESTALE) }
    try verifyName(source, name: name, record: record)
    if let over { try verifyName(destination, name: newName, record: self.record(over)) }
    let sourceHandle = try handle(source)
    let destinationHandle = try handle(destination)
    let renamedHandle = try handle(record)
    var replacedHandle: Descriptor?
    var replacedBefore: FSItem.Attributes?
    if let over {
      let old = try self.record(over)
      replacedHandle = try handle(old)
      replacedBefore = try self.attributes(old, using: replacedHandle!.value)
    }
    defer {
      withExtendedLifetime((sourceHandle, destinationHandle, renamedHandle, replacedHandle)) {}
    }
    try noteMutation(sourceHandle.value)
    try noteMutation(destinationHandle.value)
    try checked(renameat(sourceHandle.value, name, destinationHandle.value, newName))
    self.renamed(
      from: oldPath, to: newPath, parent: to, parentFileID: try fileIdentifier(destination),
      over: over)
    var replaced: FSItem.Attributes?
    if let over, let replacedHandle {
      if replacedBefore?.type == .directory {
        replaced = replacedBefore
      } else {
        replaced = try self.attributes(self.record(over), using: replacedHandle.value)
      }
    }
    return try required(
      FSRenameItemResult(
        newName: FSFileName(string: newName),
        renamedItemAttributes: self.attributes(record, using: renamedHandle.value),
        sourceDirectoryAttributes: self.attributes(source),
        destinationDirectoryAttributes: self.attributes(destination),
        overItemAttributes: replaced, freeSpace: nil))
  }
  fileprivate func removeResult(id: UInt64, parent: UInt64, name: String?) async throws
    -> sending FSRemoveItemResult
  {
    let record = try self.record(id)
    let directory = try self.record(parent)
    let name = try required(name)
    let path = try targetPath(directory, name: name)
    guard record.path == path else { throw failure(ESTALE) }
    try await authorizeNamespace([record, directory], paths: [path])
    try verifyName(directory, name: name, record: record)
    let parentHandle = try handle(directory)
    defer { withExtendedLifetime(parentHandle) {} }
    let removedHandle = try handle(record)
    defer { withExtendedLifetime(removedHandle) {} }
    let before = try self.attributes(record, using: removedHandle.value)
    let isDirectory = before.type == .directory
    try noteMutation(parentHandle.value)
    try checked(unlinkat(parentHandle.value, name, isDirectory ? AT_REMOVEDIR : 0))
    self.unlinked(path)
    // Darwin retires an event-only directory vnode after rmdir. The SDK asks
    // for the removed item's attributes, but updated parent attributes. Keep
    // that actual snapshot rather than requiring read permission just to pin
    // an otherwise removable directory, or reporting ENOENT after success.
    let removed = try isDirectory ? before : self.attributes(record, using: removedHandle.value)
    return try required(
      FSRemoveItemResult(
        itemAttributes: removed,
        directoryAttributes: self.attributes(directory), freeSpace: nil))
  }
}
