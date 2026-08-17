import Darwin
import Foundation
import CoreServices

private let maximumFrame = 2 * 1024 * 1024
private let maximumIO = 1024 * 1024
private let leaseSeconds: UInt32 = 90

private func writeAll(_ fd: Int32, data: Data) throws {
  try data.withUnsafeBytes { bytes in
    var sent = 0
    while sent < bytes.count {
      let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: sent), bytes.count - sent)
      if count < 0 && errno == EINTR { continue }
      guard count > 0 else { throw failure(count == 0 ? EPIPE : errno) }
      sent += count
    }
  }
}
private func diagnostic(_ message: String) {
  try? writeAll(STDERR_FILENO, data: Data((message + "\n").utf8))
}
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
  diagnostic("Raised open-file soft limit from \(previous) to \(target)")
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
  let normalized = String(decoding: try PolicyName(name).units, as: UTF16.self)
  guard !normalized.isEmpty, normalized != ".", normalized != "..",
    !normalized.contains("/"), !normalized.contains("\0") else { throw failure(EINVAL) }
  return (parent == "/" ? "" : parent) + "/" + name
}
private func parentPath(_ path: String) -> String {
  path == "/" ? "/" : (path as NSString).deletingLastPathComponent
}
private func monotonicTime() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
private func randomBytes(_ count: Int) -> Data {
  var bytes = [UInt8](repeating: 0, count: count)
  arc4random_buf(&bytes, bytes.count)
  return Data(bytes)
}

private enum NFSStatus: UInt32, Error {
  case ok = 0
  case permission = 1
  case noEntry = 2
  case io = 5
  case noDevice = 6
  case access = 13
  case exists = 17
  case crossDevice = 18
  case notDirectory = 20
  case isDirectory = 21
  case invalid = 22
  case tooBig = 27
  case noSpace = 28
  case readOnly = 30
  case tooManyLinks = 31
  case nameTooLong = 63
  case notEmpty = 66
  case quota = 69
  case stale = 70
  case badHandle = 10001
  case badCookie = 10003
  case notSame = 10027
  case notSupported = 10004
  case tooSmall = 10005
  case serverFault = 10006
  case delay = 10008
  case expired = 10011
  case shareDenied = 10015
  case handleExpired = 10014
  case resource = 10018
  case noFileHandle = 10020
  case minorVersionMismatch = 10021
  case staleClientID = 10022
  case staleStateID = 10023
  case oldStateID = 10024
  case badStateID = 10025
  case badSequenceID = 10026
  case symlink = 10029
  case restoreHandle = 10030
  case attributeNotSupported = 10032
  case noGrace = 10033
  case badXDR = 10036
  case openMode = 10038
  case badOwner = 10039
  case badName = 10041
  case illegalOperation = 10044
  case fileOpen = 10046
}
private func nfsStatus(_ error: Error) -> NFSStatus {
  if let status = error as? NFSStatus { return status }
  let error = error as NSError
  guard error.domain == NSPOSIXErrorDomain else { return .serverFault }
  switch Int32(error.code) {
  case EPERM: return .permission
  case ENOENT: return .noEntry
  case EACCES: return .access
  case EEXIST: return .exists
  case EXDEV: return .crossDevice
  case ENOTDIR: return .notDirectory
  case EISDIR: return .isDirectory
  case EINVAL: return .invalid
  case EFBIG, EOVERFLOW: return .tooBig
  case ENOSPC: return .noSpace
  case EROFS: return .readOnly
  case EMLINK: return .tooManyLinks
  case ENAMETOOLONG: return .nameTooLong
  case ENOTEMPTY: return .notEmpty
  case EDQUOT: return .quota
  case ESTALE: return .stale
  case ENOTSUP: return .notSupported
  case ELOOP: return .symlink
  case ENFILE, EMFILE, ENOMEM: return .resource
  case EAGAIN, EINTR: return .delay
  default: return .io
  }
}
private enum Operation: UInt32 {
  case access = 3
  case close = 4
  case commit = 5
  case create = 6
  case getattr = 9
  case getfh = 10
  case link = 11
  case lookup = 15
  case lookupp = 16
  case open = 18
  case openConfirm = 20
  case openDowngrade = 21
  case putfh = 22
  case putpubfh = 23
  case putrootfh = 24
  case read = 25
  case readdir = 26
  case readlink = 27
  case remove = 28
  case rename = 29
  case renew = 30
  case restorefh = 31
  case savefh = 32
  case secinfo = 33
  case setattr = 34
  case setclientid = 35
  case setclientidConfirm = 36
  case write = 38
  case releaseLockowner = 39
}
private enum Attribute: Int, CaseIterable {
  case supported = 0
  case type = 1
  case handleExpiry = 2
  case change = 3
  case size = 4
  case linkSupport = 5
  case symlinkSupport = 6
  case namedAttributes = 7
  case fsid = 8
  case uniqueHandles = 9
  case leaseTime = 10
  case readAttributeError = 11
  case aclSupport = 13
  case canSetTime = 15
  case caseInsensitive = 16
  case casePreserving = 17
  case chownRestricted = 18
  case fileHandle = 19
  case fileID = 20
  case filesAvailable = 21
  case filesFree = 22
  case filesTotal = 23
  case homogeneous = 26
  case maximumFileSize = 27
  case maximumLinks = 28
  case maximumName = 29
  case maximumRead = 30
  case maximumWrite = 31
  case mode = 33
  case noTruncate = 34
  case links = 35
  case owner = 36
  case ownerGroup = 37
  case rawDevice = 41
  case spaceAvailable = 42
  case spaceFree = 43
  case spaceTotal = 44
  case spaceUsed = 45
  case timeAccess = 47
  case timeAccessSet = 48
  case timeCreate = 50
  case timeDelta = 51
  case timeMetadata = 52
  case timeModify = 53
  case timeModifySet = 54
  case mountedOnFileID = 55
}
private enum FileKind: UInt32 {
  case regular = 1
  case directory = 2
  case block = 3
  case character = 4
  case symlink = 5
  case socket = 6
  case fifo = 7
  init(_ mode: mode_t) throws {
    switch mode & S_IFMT {
    case S_IFREG: self = .regular
    case S_IFDIR: self = .directory
    case S_IFBLK: self = .block
    case S_IFCHR: self = .character
    case S_IFLNK: self = .symlink
    case S_IFSOCK: self = .socket
    case S_IFIFO: self = .fifo
    default: throw NFSStatus.notSupported
    }
  }
}
private struct XDRReader: Sendable {
  let data: Data
  var position = 0
  var remaining: Int { data.count - position }
  mutating func take(_ count: Int) throws -> Data {
    guard count >= 0, count <= remaining else { throw NFSStatus.badXDR }
    defer { position += count }
    return data.subdata(in: position..<(position + count))
  }
  mutating func uint32() throws -> UInt32 {
    let bytes = try take(4)
    return bytes.reduce(0) { ($0 << 8) | UInt32($1) }
  }
  mutating func uint64() throws -> UInt64 {
    let high = try uint32()
    return (UInt64(high) << 32) | UInt64(try uint32())
  }
  mutating func opaque(limit: Int = maximumFrame) throws -> Data {
    let count = Int(try uint32())
    guard count <= limit else { throw NFSStatus.badXDR }
    let value = try take(count)
    _ = try take((4 - count % 4) % 4)
    return value
  }
  mutating func string(limit: Int = Int(MAXPATHLEN)) throws -> String {
    guard let value = String(data: try opaque(limit: limit), encoding: .utf8),
      !value.contains("\0")
    else { throw NFSStatus.badName }
    return value
  }
  mutating func name() throws -> String {
    let value = try string(limit: 255)
    _ = try childPath("/", value)
    return value
  }
  mutating func bitmap() throws -> Set<Int> {
    let count = try uint32()
    guard count <= 4 else { throw NFSStatus.badXDR }
    var result: Set<Int> = []
    for index in 0..<Int(count) {
      let word = try uint32()
      for bit in 0..<32 where word & (UInt32(1) << bit) != 0 { result.insert(index * 32 + bit) }
    }
    return result
  }
}
private struct XDRWriter: Sendable {
  var data = Data()
  mutating func uint32(_ value: UInt32) {
    var value = value.bigEndian
    withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
  }
  mutating func uint64(_ value: UInt64) {
    uint32(UInt32(truncatingIfNeeded: value >> 32))
    uint32(UInt32(truncatingIfNeeded: value))
  }
  mutating func bool(_ value: Bool) { uint32(value ? 1 : 0) }
  mutating func fixed(_ value: Data) { data.append(value) }
  mutating func opaque(_ value: Data) {
    uint32(UInt32(value.count))
    data.append(value)
    data.append(contentsOf: repeatElement(0, count: (4 - value.count % 4) % 4))
  }
  mutating func string(_ value: String) { opaque(Data(value.utf8)) }
  mutating func bitmap(_ bits: Set<Int>) {
    let count = bits.max().map { $0 / 32 + 1 } ?? 0
    uint32(UInt32(count))
    for index in 0..<count {
      var word: UInt32 = 0
      for bit in bits where bit / 32 == index { word |= UInt32(1) << (bit % 32) }
      uint32(word)
    }
  }
  mutating func time(_ value: timespec) {
    uint64(UInt64(bitPattern: Int64(value.tv_sec)))
    uint32(UInt32(value.tv_nsec))
  }
  mutating func change(before: UInt64, after: UInt64) {
    bool(false)
    uint64(before)
    uint64(after)
  }
}
private struct AttributeChanges: Sendable {
  let bits: Set<Int>
  var mode: UInt32?
  var uid: UInt32?
  var gid: UInt32?
  var size: UInt64?
  var accessTime: timespec?
  var modifyTime: timespec?
  var birthTime: timespec?
  init(size: UInt64?) {
    bits = size == nil ? [] : [Attribute.size.rawValue]
    self.size = size
  }
  init(_ reader: inout XDRReader) throws {
    bits = try reader.bitmap()
    var values = XDRReader(data: try reader.opaque())
    func time(_ values: inout XDRReader, set: Bool) throws -> timespec {
      if set {
        let how = try values.uint32()
        if how == 0 { return timespec(tv_sec: 0, tv_nsec: Int(UTIME_NOW)) }
        guard how == 1 else { throw NFSStatus.invalid }
      }
      let seconds = Int64(bitPattern: try values.uint64())
      let nanos = try values.uint32()
      guard nanos < 1_000_000_000 else { throw NFSStatus.invalid }
      return timespec(tv_sec: Int(seconds), tv_nsec: Int(nanos))
    }
    for bit in bits.sorted() {
      switch Attribute(rawValue: bit) {
      case .size:
        size = try values.uint64()
        guard size! <= UInt64(Int64.max) else { throw NFSStatus.tooBig }
      case .mode:
        mode = try values.uint32()
        guard mode! & ~0o7777 == 0 else { throw NFSStatus.invalid }
      case .owner:
        guard let value = UInt32(try values.string()), value != UInt32.max else {
          throw NFSStatus.badOwner
        }
        uid = value
      case .ownerGroup:
        guard let value = UInt32(try values.string()), value != UInt32.max else {
          throw NFSStatus.badOwner
        }
        gid = value
      case .timeAccessSet: accessTime = try time(&values, set: true)
      case .timeModifySet: modifyTime = try time(&values, set: true)
      case .timeCreate: birthTime = try time(&values, set: false)
      default: throw NFSStatus.attributeNotSupported
      }
    }
    guard values.remaining == 0 else { throw NFSStatus.badXDR }
  }
}

private struct Access: OptionSet, Sendable {
  let rawValue: UInt8
  static let read = Access(rawValue: 1)
  static let write = Access(rawValue: 2)
}
private struct ActionApprovalKey: Hashable {
  let generation: Int
  let path: String
  let context: String
  let observation: String
  let right: UInt8
  let effect: String
}
private enum MetadataPromptScope {
  @TaskLocal static var allowed = true
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
private struct Scope: Decodable, Sendable {
  let path: String
  let mode: Mode
  var barrier: Bool? = nil
}
private struct ControlMessage: Decodable, Sendable {
  let type: String
  var generation: Int?
  var scopes: [Scope]?
  var id: String?
  var allow: Bool?
}
private struct LinkNeedsApproval: Error {
  let path: String
  let traversal: Bool
}
private struct LinkApproval {
  let identity: BackingIdentity?
}
private struct PolicyName {
  let units: [UInt16]
  init(_ value: String) throws {
    let string = value as CFString
    let capacity = CFStringGetMaximumSizeOfFileSystemRepresentation(string)
    guard capacity > 0 else { throw failure(EILSEQ) }
    var bytes = [CChar](repeating: 0, count: capacity)
    guard CFStringGetFileSystemRepresentation(string, &bytes, bytes.count),
      let normalized = String(
        validating: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    else { throw failure(EILSEQ) }
    units = Array(normalized.utf16)
  }
}
private enum NameComparison: Equatable {
  case sensitive, insensitive
  init(directoryFD: Int32) throws {
    var attributes = attrlist()
    attributes.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
    attributes.commonattr = attrgroup_t(ATTR_CMN_RETURNED_ATTRS)
    attributes.volattr = attrgroup_t(ATTR_VOL_INFO) | attrgroup_t(ATTR_VOL_CAPABILITIES)
    var bytes = [UInt8](repeating: 0, count: 64)
    try checked(fgetattrlist(directoryFD, &attributes, &bytes, bytes.count, 0))
    let length = bytes.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
    let returned = bytes.withUnsafeBytes {
      $0.loadUnaligned(fromByteOffset: 4, as: attribute_set_t.self)
    }
    let offset = 4 + MemoryLayout<attribute_set_t>.size
    guard length >= offset + 32, length <= bytes.count,
      returned.volattr & attrgroup_t(ATTR_VOL_CAPABILITIES) != 0
    else { throw failure(ENOTSUP) }
    let capabilities = bytes.withUnsafeBytes {
      $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
    }
    let valid = bytes.withUnsafeBytes {
      $0.loadUnaligned(fromByteOffset: offset + 16, as: UInt32.self)
    }
    guard valid & UInt32(VOL_CAP_FMT_CASE_SENSITIVE) != 0 else { throw failure(ENOTSUP) }
    self = capabilities & UInt32(VOL_CAP_FMT_CASE_SENSITIVE) != 0 ? .sensitive : .insensitive
  }
  func equivalent(_ first: PolicyName, _ second: PolicyName) throws -> Bool {
    if first.units == second.units { return true }
    if self == .sensitive { return false }
    var same: DarwinBoolean = false
    var order: Int32 = 0
    let status = first.units.withUnsafeBufferPointer { first in
      second.units.withUnsafeBufferPointer { second in
        UCCompareTextNoLocale(
          UInt32(kUCCollateTypeHFSExtended) << UInt32(kUCCollateTypeShiftBits),
          first.baseAddress, first.count, second.baseAddress, second.count, &same, &order)
      }
    }
    guard status == 0 else { throw failure(EILSEQ) }
    return same.boolValue
  }
}
private struct Policy {
  fileprivate struct Entry {
    let index: Int
    let scope: Scope
    let components: [String]
    let names: [PolicyName]
  }
  struct Cursor {
    fileprivate let entries: [Entry]
    let depth: Int
    let mode: Mode
    let scopeIndices: [Int]
    var hasDescendants: Bool { !entries.isEmpty }
    var traversable: Bool { mode != .deny || entries.contains { $0.scope.mode != .deny } }
    var descendantSuffixes: [String] {
      if mode == .readWrite && entries.allSatisfy({ $0.scope.mode == .readWrite && $0.scope.barrier != true }) {
        return []
      }
      return entries.map { $0.components.dropFirst(depth).joined(separator: "/") }
    }
    func child(_ name: String, comparison: NameComparison) throws -> Cursor {
      try child(name, comparison: { comparison })
    }
    func child(_ name: String, comparison: () throws -> NameComparison) throws -> Cursor {
      guard !entries.isEmpty else {
        return Cursor(entries: [], depth: depth + 1, mode: mode, scopeIndices: scopeIndices)
      }
      let prepared = try entries.first(where: {
        $0.components[depth].utf8.elementsEqual(name.utf8)
      })?.names[depth] ?? PolicyName(name)
      var selectedComparison: NameComparison?
      let matches = try entries.filter { entry in
        let expected = entry.names[depth]
        if expected.units == prepared.units { return true }
        guard try NameComparison.insensitive.equivalent(expected, prepared) else { return false }
        if selectedComparison == nil { selectedComparison = try comparison() }
        return selectedComparison == .insensitive
      }
      return Policy.cursor(matches, depth: depth + 1, inherited: mode, inheritedIndices: scopeIndices)
    }
  }
  private let entries: [Entry]
  init() { entries = [] }
  init(_ scopes: [Scope]) throws {
    guard scopes.allSatisfy({ $0.barrier != true || $0.mode == .deny }) else { throw failure(EPROTO) }
    entries = try scopes.enumerated().map { index, scope in
      let components = scope.path.split(separator: "/").map(String.init)
      return Entry(index: index, scope: scope, components: components, names: try components.map(PolicyName.init))
    }
  }
  var root: Cursor { Self.cursor(entries, depth: 0, inherited: .deny, inheritedIndices: []) }
  private static func cursor(
    _ entries: [Entry], depth: Int, inherited: Mode, inheritedIndices: [Int]
  ) -> Cursor {
    let exact = entries.filter { $0.components.count == depth }
    if exact.contains(where: { $0.scope.barrier == true }) {
      return Cursor(entries: [], depth: depth, mode: .deny, scopeIndices: exact.map { $0.index })
    }
    let modes = exact.map { $0.scope.mode }
    let mode = modes.dropFirst().reduce(modes.first ?? inherited, intersect)
    return Cursor(
      entries: entries.filter { $0.components.count > depth }, depth: depth, mode: mode,
      scopeIndices: exact.isEmpty ? inheritedIndices : exact.map { $0.index })
  }
  private static func intersect(_ first: Mode, _ second: Mode) -> Mode {
    if first == .deny || second == .deny { return .deny }
    let readAsk = first.decision(.read) == .ask || second.decision(.read) == .ask
    let writeDeny = first.decision(.write) == .deny || second.decision(.write) == .deny
    let writeAsk = first.decision(.write) == .ask || second.decision(.write) == .ask
    if writeDeny { return readAsk ? .askRead : .read }
    if readAsk { return .askReadWrite }
    return writeAsk ? .readAskWrite : .readWrite
  }
}
private final class DescriptorCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func adjust(_ amount: Int) { lock.lock(); value += amount; lock.unlock() }
  var count: Int { lock.lock(); defer { lock.unlock() }; return value }
}
private let descriptorCounter = DescriptorCounter()
private final class Descriptor: Sendable {
  let value: Int32
  init(_ value: Int32) { self.value = value; descriptorCounter.adjust(1) }
  @discardableResult func withFD<T>(_ body: (Int32) throws -> T) rethrows -> T {
    try withExtendedLifetime(self) { try body(value) }
  }
  deinit { Darwin.close(value); descriptorCounter.adjust(-1) }
}
private struct BackingIdentity: Hashable, Sendable {
  let device: dev_t
  let inode: ino_t
  let generation: UInt32
  init(_ info: stat) {
    device = info.st_dev
    inode = info.st_ino
    generation = info.st_gen
  }
}
private struct ChangeSignature: Equatable {
  let modifySeconds: Int
  let modifyNanos: Int
  let changeSeconds: Int
  let changeNanos: Int
  let size: off_t
  let generation: Int
  let publication: UInt64
  init(_ info: stat, generation: Int, publication: UInt64) {
    modifySeconds = info.st_mtimespec.tv_sec
    modifyNanos = info.st_mtimespec.tv_nsec
    changeSeconds = info.st_ctimespec.tv_sec
    changeNanos = info.st_ctimespec.tv_nsec
    size = info.st_size
    self.generation = generation
    self.publication = publication
  }
}
private final class WeakDescriptor {
  weak var value: Descriptor?
  init(_ value: Descriptor) { self.value = value }
}
private final class Record {
  let id: UInt64
  var identity: BackingIdentity
  var bindingVersion: UInt64 = 0
  var viewRevision: UInt64 = 0
  var policyComparisons: [NameComparison] = []
  var policyParentBinding: UInt64 = 0
  var identityPins: [WeakDescriptor] = []
  let path: String
  private(set) weak var parent: Record?
  let name: String
  let entryKey: EntryKey?
  var retired = false
  var acquiredDirectory = false
  var publicationEpoch: UInt64 = 0
  var viewEpoch = 0
  var object: Descriptor?
  var policyView: Policy.Cursor?
  var comparison: NameComparison?
  weak var approvalOwner: Descriptor?
  var metadataRights: Access = []
  var linkReadGranted = false
  var strongIdentity = false
  var observed: stat
  var hasAliases: Bool
  var unlinked = false
  var touched = monotonicTime()
  var expiredGrantTouch: UInt64? = nil
  var signature: ChangeSignature?
  var change: UInt64 = 0
  var exclusiveVerifier: Data?
  init(id: UInt64, path: String, info: stat, parent: Record? = nil, name: String = "") {
    self.id = id
    self.path = path
    self.parent = parent
    self.name = name
    entryKey = parent.map { EntryKey(parent: $0.id, name: Data(name.utf8)) }
    observed = info
    identity = BackingIdentity(info)
    hasAliases = info.st_mode & S_IFMT != S_IFDIR && info.st_nlink > 1
  }
}
private struct EntryKey: Hashable {
  let parent: UInt64
  let name: Data
}
private struct EntrySelection {
  let parent: Record
  let directory: Descriptor
  let name: String
  let path: String
  let cursor: Policy.Cursor
  let generation: Int
}
private enum EffectOperation: String {
  case remove, rename, link, create
  case openRead = "open-read"
  case openWrite = "open-write"
  case openReadWrite = "open-readwrite"
  init(access: Access) {
    self = access == .read ? .openRead : access == .write ? .openWrite : .openReadWrite
  }
}
private enum OpenPurpose: String {
  case metadataOwner = "metadata-owner"
  case content
  case setSize = "set-size"
}
private struct EffectItem {
  let path: String
  let cursor: Policy.Cursor
  let access: Access
  var wire: [String: Any] {
    ["path": path, "access": access == .read ? "read" : "write", "scopeIndices": cursor.scopeIndices]
  }
}
private final class EffectTicket {
  let operation: EffectOperation
  let purpose: OpenPurpose?
  let source: String?
  let destination: String?
  let entries: [EntrySelection]
  let items: [EffectItem]
  let generation: Int
  private var consumed = false
  init(operation: EffectOperation, purpose: OpenPurpose?, source: String?, destination: String?, entries: [EntrySelection],
    items: [EffectItem], generation: Int) {
    self.operation = operation; self.purpose = purpose; self.source = source; self.destination = destination
    self.entries = entries; self.items = items; self.generation = generation
  }
  var wire: [String: Any] {
    var result: [String: Any] = ["operation": operation.rawValue, "footprint": items.map { $0.wire }]
    if let purpose { result["purpose"] = purpose.rawValue }
    if let source { result["source"] = source }
    if let destination { result["destination"] = destination }
    return result
  }
  func consume(generation: Int) throws {
    guard !consumed, self.generation == generation else { throw NFSStatus.access }
    consumed = true
  }
}
private struct MetadataSelection {
  let owner: Descriptor?
  let info: stat
  let generation: Int
}
private struct ReplayHandle {
  let id: UInt64
}
private enum HandleContext {
  case object(Record)
  case replay(ReplayHandle)
  var id: UInt64 {
    switch self {
    case .object(let record): return record.id
    case .replay(let handle): return handle.id
    }
  }
  var record: Record? {
    if case .object(let record) = self { return record }
    return nil
  }
  var replayOnly: Bool {
    if case .replay = self { return true }
    return false
  }
}
private struct OwnerKey: Hashable, Sendable {
  let client: UInt64
  let owner: Data
}
private struct OperationResult: Sendable {
  let status: NFSStatus
  let body: Data
  let current: UInt64?
  var selected: stat? = nil
}
private final class OpenOwner {
  let key: OwnerKey
  var confirmed = false
  var sequence: UInt32?
  var signature = Data()
  var result: OperationResult?
  var pending = false
  var pendingSequence: UInt32?
  var pendingSignature = Data()
  var pendingWaiters: [CheckedContinuation<OperationResult, Never>] = []
  var touched = monotonicTime()
  var closedKey: Data?
  var closedHandle: UInt64?
  init(_ key: OwnerKey) { self.key = key }
}
private final class OpenState {
  let key: Data
  let owner: OwnerKey
  let record: Record
  var recordIDs: Set<UInt64>
  var sequence: UInt32 = 1
  var closing = false
  var rights: Access = []
  var drainRights: Access = []
  var deny: Access = []
  var reader: Descriptor?
  var writer: Descriptor?
  init(key: Data, owner: OwnerKey, record: Record) {
    self.key = key
    self.owner = owner
    self.record = record
    recordIDs = [record.id]
  }
  var stateID: Data {
    var value = XDRWriter()
    value.uint32(sequence)
    value.fixed(key)
    return value.data
  }
}
private final class MetadataPin {
  let stateKey: Data
  let identity: BackingIdentity
  let descriptor: Descriptor
  var selected: stat?
  init(stateKey: Data, identity: BackingIdentity, descriptor: Descriptor) {
    self.stateKey = stateKey
    self.identity = identity
    self.descriptor = descriptor
  }
}
private struct DataAccess: Sendable {
  let token: UUID
  let stateKey: Data
  let itemID: UInt64
  let admittedIdentity: BackingIdentity
  let descriptor: Descriptor
}
private final class BackingExecutor: @unchecked Sendable {
  typealias Work = @Sendable () -> Void
  private let condition = NSCondition()
  private var pending: [Work?] = []
  private var head = 0

  init() {
    for _ in 0..<4 {
      let worker = Thread { self.run() }
      worker.qualityOfService = .userInitiated
      worker.start()
    }
  }
  func submit(_ work: @escaping Work) {
    condition.lock()
    pending.append(work)
    condition.signal()
    condition.unlock()
  }
  private func take() -> Work {
    condition.lock()
    defer { condition.unlock() }
    while head == pending.count { condition.wait() }
    let work = pending[head]!
    pending[head] = nil
    head += 1
    if head == pending.count {
      pending.removeAll(keepingCapacity: true)
      head = 0
    } else if head >= 1024 && head >= pending.count / 2 {
      pending.removeFirst(head)
      head = 0
    }
    return work
  }
  private func run() {
    while true {
      autoreleasepool {
        let work = take()
        work()
      }
    }
  }
}
private let backingExecutor = BackingExecutor()
private func backingIO<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
  try await withCheckedThrowingContinuation { continuation in
    backingExecutor.submit {
      do { continuation.resume(returning: try body()) } catch {
        continuation.resume(throwing: error)
      }
    }
  }
}
private struct Client {
  let owner: Data
  let verifier: Data
  let confirmation: Data
  var confirmed = false
  var renewed = monotonicTime()
}
private struct RPCKey: Hashable {
  let connection: UUID
  let xid: UInt32
  let uid: UInt32
}
private struct CompoundReply: Sendable {
  let data: Data
  let teardownOnly: Bool
  let replayStates: Set<Data>?
}
private struct RPCReplay {
  let request: Data
  let response: Data
  let teardownOnly: Bool
  let time: UInt64
  let generation: Int
  let replayStates: Set<Data>?
}
private struct RPCPending {
  let request: Data
  var waiters: [CheckedContinuation<Data, Never>] = []
}
private struct Credentials: Sendable {
  let uid: UInt32
  let groups: Set<UInt32>
}
private struct OpenRequest: Sendable {
  let sequence: UInt32
  let rights: UInt32
  let deny: UInt32
  let owner: OwnerKey
  var createMode: UInt32?
  var attributes: AttributeChanges?
  var verifier: Data?
  var claim: UInt32 = 0
  var name: String?
  var semanticError: NFSStatus?
  init(_ input: inout XDRReader) throws {
    sequence = try input.uint32()
    rights = try input.uint32()
    deny = try input.uint32()
    owner = OwnerKey(client: try input.uint64(), owner: try input.opaque(limit: 1024))
    do {
      let how = try input.uint32()
      if how == 1 {
        let mode = try input.uint32()
        guard mode <= 2 else { throw NFSStatus.invalid }
        createMode = mode
        if mode < 2 {
          do { attributes = try AttributeChanges(&input) } catch {
            let status = nfsStatus(error)
            if status == .badXDR { throw error }
            semanticError = status
          }
        } else {
          verifier = try input.take(8)
        }
      } else {
        guard how == 0 else { throw NFSStatus.invalid }
      }
      claim = try input.uint32()
      switch claim {
      case 0: name = try input.name()
      case 1: _ = try input.uint32()
      case 2:
        _ = try input.take(16)
        name = try input.name()
        semanticError = semanticError ?? .notSupported
      case 3:
        name = try input.name()
        semanticError = semanticError ?? .notSupported
      default: semanticError = semanticError ?? .notSupported
      }
    } catch {
      let status = nfsStatus(error)
      if status == .badXDR { throw error }
      semanticError = semanticError ?? status
    }
  }
}

private enum CompoundTask {
  @TaskLocal static var identifier: UUID?
}

private actor NFSServer {
  private struct ConfigurationEntry {
    weak var owner: Descriptor?
    var values: [Int32: Int] = [:]
  }
  private var configurations: [ObjectIdentifier: ConfigurationEntry] = [:]
  private var configurationCreationsSincePrune = 0

  private func pruneConfigurations() {
    for (key, entry) in configurations where entry.owner == nil {
      configurations.removeValue(forKey: key)
    }
    configurationCreationsSincePrune = 0
  }
  private func descriptorConfiguration(_ owner: Descriptor, _ name: Int32) throws -> Int {
    let key = ObjectIdentifier(owner)
    if let entry = configurations[key], entry.owner === owner {
      if let value = entry.values[name] { return value }
    } else {
      configurations[key] = ConfigurationEntry(owner: owner)
      configurationCreationsSincePrune += 1
      if configurationCreationsSincePrune >= 64 { pruneConfigurations() }
    }
    let value = try owner.withFD { fd in
      errno = 0
      let value = fpathconf(fd, name)
      if value < 0 && errno != 0 { throw failure() }
      return value
    }
    configurations[key]!.values[name] = value
    return value
  }

  let root: Descriptor
  let backingRoot: String
  let epoch = randomBytes(8)
  private var records: [UInt64: Record] = [:]
  private var paths: [String: UInt64] = [:]
  private var entries: [EntryKey: UInt64] = [:]
  private var optionalOrder: [UInt64: (previous: UInt64?, next: UInt64?)] = [:]
  private var optionalFirst: UInt64?
  private var optionalLast: UInt64?
  private var optionalCount = 0
  private var compoundPins: [UUID: Set<UInt64>] = [:]
  private var recordPins: [UInt64: Int] = [:]
  private var ownerBudget = 256
  private var directoryHits: UInt64 = 0
  private var directoryMisses: UInt64 = 0
  private var acquisitionOpens: UInt64 = 0
  private var bulkCalls: UInt64 = 0
  private var fallbackStats: UInt64 = 0
  private var prefixRefreshStats: UInt64 = 0
  private var directoryFieldStats: UInt64 = 0
  private var missingFieldStats: UInt64 = 0
  private var listingBuilds: UInt64 = 0
  private var listingRowsBuilt: UInt64 = 0
  private var listingBuildNanos: UInt64 = 0
  private var activeListingBuilders = 0
  private var peakListingBuilders = 0
  private var nativeBudget = 16384
  private var nextID: UInt64 = 3
  private var changeCounter: UInt64 = 0
  private var policy = Policy()
  private var contextRevision: UInt64 = 0
  private var actionApprovals: [UUID: Set<ActionApprovalKey>] = [:]
  private var generation = 0
  private var quiescing = false
  private var connections: Set<UUID> = []
  private var directoryCursors: [UInt64: DirectoryCursor] = [:]
  private var olderDirectoryCursors: [UInt64: DirectoryCursor] = [:]
  private var directorySerial: UInt64 = 0
  private var serving = false
  private var stopped = false
  private var asks: [String: CheckedContinuation<Bool, Never>] = [:]
  private var clients: [UInt64: Client] = [:]
  private var owners: [OwnerKey: OpenOwner] = [:]
  private var states: [Data: OpenState] = [:]
  private var stateKeysByRecordID: [UInt64: [Data]] = [:]
  private var stateKeysByIdentityOwner: [BackingIdentity: [OwnerKey: Data]] = [:]
  private var activeIO: [UUID: DataAccess] = [:]
  private var ioWaiters: [(Data, CheckedContinuation<Void, Never>)] = []
  private var nextClient: UInt64 = UInt64.random(in: 1...UInt64.max / 2)
  private var replays: [RPCKey: RPCReplay] = [:]
  private var replayOrder: [RPCKey: (previous: RPCKey?, next: RPCKey?)] = [:]
  private var replayFirst: RPCKey?
  private var replayLast: RPCKey?
  private var pendingRPCs: [RPCKey: RPCPending] = [:]
  private var replayBytes = 0
  private var lastMaintenance = monotonicTime()

  private func removeReplay(_ key: RPCKey) {
    guard let replay = replays.removeValue(forKey: key) else { return }
    replayBytes -= replay.request.count + replay.response.count
    let order = replayOrder.removeValue(forKey: key)!
    if let previous = order.previous {
      replayOrder[previous]!.next = order.next
    } else {
      replayFirst = order.next
    }
    if let next = order.next {
      replayOrder[next]!.previous = order.previous
    } else {
      replayLast = order.previous
    }
  }

  init(rootPath: String) throws {
    let descriptor = Descriptor(try checked(Darwin.open(rootPath, O_SEARCH | O_DIRECTORY | O_CLOEXEC)))
    root = descriptor
    var rootBytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    try descriptor.withFD { try checked(fcntl($0, F_GETPATH, &rootBytes)) }
    guard let nativeRoot = rootBytes.withUnsafeBufferPointer({ String(validatingCString: $0.baseAddress!) }) else {
      throw failure(EILSEQ)
    }
    backingRoot = nativeRoot
    var filesystem = statfs()
    try checked(fstatfs(root.value, &filesystem))
    let filesystemName = withUnsafeBytes(of: filesystem.f_fstypename) { bytes in
      String(bytes: bytes.prefix { $0 != 0 }, encoding: .utf8)
    }
    guard filesystemName == "apfs" || filesystemName == "hfs" else { throw failure(ENOTSUP) }
    var info = stat()
    try checked(fstat(root.value, &info))
    let record = Record(id: 2, path: "/", info: info)
    record.object = root
    record.strongIdentity = true
    record.acquiredDirectory = true
    record.comparison = try NameComparison(directoryFD: descriptor.value)
    records[2] = record
    paths["/"] = 2
    var limit = rlimit()
    try checked(getrlimit(RLIMIT_NOFILE, &limit))
    nativeBudget = Int(min(limit.rlim_cur, 1_000_000)) - 256
    ownerBudget = max(16, min(256, nativeBudget / 4))
  }
  func send(_ object: [String: Any]) throws {
    var data = try JSONSerialization.data(withJSONObject: object)
    data.append(10)
    try writeAll(STDOUT_FILENO, data: data)
  }
  func hello() throws { try send(["type": "hello", "version": 1, "mount": UUID().uuidString]) }
  func receive(_ message: ControlMessage) throws {
    switch message.type {
    case "decision":
      guard let epoch = message.generation, let id = message.id, let allow = message.allow
      else { throw failure(EPROTO) }
      guard epoch == generation else { return }
      asks.removeValue(forKey: id)?.resume(returning: allow)
    case "policy":
      guard !stopped, !quiescing, let next = message.generation, next > generation,
        let scopes = message.scopes,
        scopes.allSatisfy({ validPath($0.path) })
      else { throw failure(EPROTO) }
      let nextPolicy = try Policy(scopes)
      for ask in asks.values { ask.resume(returning: false) }
      asks.removeAll()
      invalidatePolicyViews()
      actionApprovals.removeAll()
      policy = nextPolicy
      generation = next
      serving = true
      try send(["type": "policyAck", "generation": next])
    case "quiesce":
      quiesce()
      try send(["type": "quiesced"])
    default: throw failure(EPROTO)
    }
  }
  func stop() {
    serving = false
    stopped = true
    clearOptionalOwners()
    configurations.removeAll()
    configurationCreationsSincePrune = 0
    policy = Policy()
    for ask in asks.values { ask.resume(returning: false) }
    asks.removeAll()
  }
  func check() throws {
    guard serving, !stopped else { throw NFSStatus.access }
  }
  func expireApproval(_ id: String) { asks.removeValue(forKey: id)?.resume(returning: false) }
  private func unlinkOptional(_ id: UInt64) {
    guard let order = optionalOrder.removeValue(forKey: id) else { return }
    if let previous = order.previous { optionalOrder[previous]!.next = order.next }
    else { optionalFirst = order.next }
    if let next = order.next { optionalOrder[next]!.previous = order.previous }
    else { optionalLast = order.previous }
    optionalCount -= 1
  }
  private func retainOptional(_ record: Record) {
    guard record.id != 2, record.object != nil, !record.retired, records[record.id] === record,
      stateKeysByRecordID[record.id] == nil else { return }
    unlinkOptional(record.id)
    optionalOrder[record.id] = (optionalLast, nil)
    if let last = optionalLast { optionalOrder[last]!.next = record.id }
    else { optionalFirst = record.id }
    optionalLast = record.id
    optionalCount += 1
  }
  private func publishViewChange(_ parent: Record) {
    parent.publicationEpoch &+= 1
    parent.signature = nil
    changeCounter &+= 1
    parent.change = changeCounter
  }
  private func discardDirectoryContinuations(_ id: UInt64) {
    directoryCursors.removeValue(forKey: id)
    for (verifier, cursor) in olderDirectoryCursors where cursor.directoryID == id {
      olderDirectoryCursors.removeValue(forKey: verifier)
    }
  }
  private func evictDirectoryOwner(_ id: UInt64) {
    guard id != 2, stateKeysByRecordID[id] == nil, let record = records[id] else { return }
    unlinkOptional(id)
    record.object = nil
    clearMetadataRights(record)
    record.policyView = nil
    record.bindingVersion &+= 1
    contextRevision &+= 1
  }
  private func pinIdentity(_ record: Record, _ owner: Descriptor) {
    record.identityPins.removeAll { $0.value == nil }
    if !record.identityPins.contains(where: { $0.value === owner }) {
      record.identityPins.append(WeakDescriptor(owner))
    }
  }
  private func protectedOwner(_ record: Record) -> Descriptor? {
    record.object ?? dataDescriptor(record) ?? record.identityPins.compactMap { $0.value }.first
  }
  private func refreshPolicyContext(_ record: Record, parent: Record) throws {
    guard let comparison = parent.comparison else { throw NFSStatus.delay }
    let comparisons = parent.policyComparisons + [comparison]
    if record.policyComparisons != comparisons || record.policyParentBinding != parent.bindingVersion {
      record.policyComparisons = comparisons
      record.policyParentBinding = parent.bindingVersion
      record.policyView = nil
    }
  }
  private func refreshPathObservation(_ record: Record, _ info: stat) throws {
    if protectedOwner(record) != nil {
      guard observationMatches(record, info) else { throw NFSStatus.stale }
    } else if !observationMatches(record, info) || record.identity != BackingIdentity(info) {
      if !observationMatches(record, info) {
        var detached = false
        if let key = record.entryKey, entries[key] == record.id {
          entries.removeValue(forKey: key)
          detached = true
        }
        if paths[record.path] == record.id {
          paths.removeValue(forKey: record.path)
          detached = true
        }
        if detached, let parent = record.parent { publishViewChange(parent) }
      }
      discardDirectoryContinuations(record.id)
      record.bindingVersion &+= 1
      contextRevision &+= 1
      record.comparison = nil
      record.policyView = nil
      clearMetadataRights(record)
      record.identity = BackingIdentity(info)
      record.signature = nil
      record.exclusiveVerifier = nil
    }
    if protectedOwner(record) == nil, let parent = record.parent {
      try refreshPolicyContext(record, parent: parent)
    }
    record.observed = info
  }
  private func retireOptional(_ id: UInt64) {
    guard id != 2, stateKeysByRecordID[id] == nil, let record = records[id] else { return }
    unlinkOptional(id)
    record.object = nil
    clearMetadataRights(record)
    record.retired = true
    directoryCursors.removeValue(forKey: id)
    for (verifier, cursor) in olderDirectoryCursors where cursor.directoryID == id {
      olderDirectoryCursors.removeValue(forKey: verifier)
    }
    if paths[record.path] == id { paths.removeValue(forKey: record.path) }
    if let key = record.entryKey, entries[key] == id { entries.removeValue(forKey: key) }
    if let parent = record.parent { publishViewChange(parent) }
  }
  private func clearOptionalOwners() {
    for id in Array(optionalOrder.keys) { retireOptional(id) }
    entries.removeAll()
    invalidatePolicyViews()
  }
  private func invalidatePolicyViews() {
    directoryCursors.removeAll()
    olderDirectoryCursors.removeAll()
    for record in records.values {
      clearMetadataRights(record)
      record.policyView = nil
    }
  }
  private func pinRecord(_ record: Record) {
    guard let task = CompoundTask.identifier, compoundPins[task] != nil else { return }
    if compoundPins[task]!.insert(record.id).inserted {
      recordPins[record.id, default: 0] += 1
    }
  }
  private func releasePins(_ task: UUID) {
    actionApprovals.removeValue(forKey: task)
    for id in compoundPins.removeValue(forKey: task) ?? [] {
      let remaining = recordPins[id, default: 0] - 1
      if remaining == 0 { recordPins.removeValue(forKey: id) }
      else { recordPins[id] = remaining }
    }
    try? makeRoom()
  }
  private func makeRoom() throws {
    var candidate = optionalFirst
    while optionalCount >= ownerBudget, let id = candidate {
      candidate = optionalOrder[id]?.next
      guard recordPins[id] == nil, directoryCursors[id]?.busy != true else { continue }
      evictDirectoryOwner(id)
    }
    guard descriptorCounter.count + connections.count * 2 + 128 < nativeBudget
    else { throw NFSStatus.resource }
  }
  private func viewPolicy(_ record: Record) throws -> Policy.Cursor {
    guard records[record.id] === record else { throw NFSStatus.stale }
    if record.viewEpoch == generation, record.viewRevision == contextRevision, let cached = record.policyView {
      return cached
    }
    var cursor = policy.root
    let names = record.path.split(separator: "/").map(String.init)
    guard names.count == record.policyComparisons.count else { throw NFSStatus.serverFault }
    for (name, comparison) in zip(names, record.policyComparisons) {
      cursor = try cursor.child(name, comparison: comparison)
    }
    record.policyView = cursor
    record.viewEpoch = generation
    record.viewRevision = contextRevision
    return cursor
  }
  private func viewComparison(_ record: Record, owner: Descriptor) throws -> NameComparison {
    if let cached = record.comparison { return cached }
    let comparison = try owner.withFD { try NameComparison(directoryFD: $0) }
    record.comparison = comparison
    return comparison
  }
  private func select(_ parent: Record, name: String) async throws -> EntrySelection {
    let path = try childPath(parent.path, name)
    let directory = try await directoryOwner(parent)
    _ = try await authorize(parent, .read, traversal: true, captureStat: false)
    let cursor = try viewPolicy(parent).child(name, comparison: {
      try viewComparison(parent, owner: directory)
    })
    return EntrySelection(parent: parent, directory: directory, name: name,
      path: path, cursor: cursor, generation: generation)
  }
  private func approve(
    _ path: String, cursor: Policy.Cursor, access: Access, traversal: Bool = false,
    effect: EffectTicket? = nil, remembered: Access = [], selection: Record? = nil,
    entry: EntrySelection? = nil, observation: stat? = nil, allowPrompt: Bool = true
  ) async throws {
    try check()
    let epoch = generation
    let selectedVersion = selection?.bindingVersion
    let selectedOwner = selection.flatMap { protectedOwner($0) }
    if let selection, let selectedOwner { pinIdentity(selection, selectedOwner) }
    defer { withExtendedLifetime(selectedOwner) {} }
    let effectData = try effect.map { try JSONSerialization.data(withJSONObject: $0.wire, options: [.sortedKeys]).base64EncodedString() } ?? "metadata"
    let selectedEntry = entry ?? effect?.entries.first(where: { $0.path == path })
    let parent = selectedEntry?.parent ?? selection?.parent
    let parentOwner = selectedEntry?.directory ?? parent.flatMap { protectedOwner($0) }
    let parentToken = parentOwner.map { String(describing: ObjectIdentifier($0)) } ?? "root"
    let context = "\(selection?.id ?? 0):\(selectedVersion ?? 0):\(parent?.id ?? 0):\(parent?.bindingVersion ?? 0):\(parentToken)"
    let observed = observation ?? selection?.observed
    let object = observed.map { "\($0.st_dev):\($0.st_ino):\($0.st_gen):\($0.st_mode & S_IFMT)" } ?? "name"
    if traversal && !access.contains(.write) && cursor.mode == .deny && cursor.traversable { return }
    for right in [Access.read, .write] where access.contains(right) {
      switch cursor.mode.decision(right) {
      case .deny: throw NFSStatus.access
      case .allow: continue
      case .ask:
        let actionKey = ActionApprovalKey(generation: epoch, path: path, context: context,
          observation: object, right: right.rawValue, effect: effectData)
        if let task = CompoundTask.identifier, actionApprovals[task]?.contains(actionKey) == true { continue }
        guard allowPrompt && MetadataPromptScope.allowed else { throw NFSStatus.access }
        guard asks.count < 128 else { throw NFSStatus.resource }
        let id = UUID().uuidString
        let timeout = Task {
          try? await Task.sleep(for: .seconds(300))
          if !Task.isCancelled { self.expireApproval(id) }
        }
        let allowed = await withCheckedContinuation { continuation in
          asks[id] = continuation
          do {
            var frame: [String: Any] = ["type": "approval", "id": id, "generation": epoch,
              "path": path, "access": right == .read ? "read" : "write",
              "reason": effect == nil ? "access" : "effect", "scopeIndices": cursor.scopeIndices]
            if let effect { frame["effect"] = effect.wire }
            try send(frame)
          } catch { stop() }
        }
        timeout.cancel()
        try check()
        guard generation == epoch && allowed,
          selection?.bindingVersion == selectedVersion else { throw NFSStatus.access }
        if let task = CompoundTask.identifier { actionApprovals[task, default: []].insert(actionKey) }
      }
    }
    try check()
    guard generation == epoch else { throw NFSStatus.access }
  }
  private func effectItems(_ entry: EntrySelection, access: Access, recursive: Bool = false) -> [EffectItem] {
    var result: [EffectItem] = []
    for right in [Access.read, .write] where access.contains(right) {
      result.append(EffectItem(path: entry.path, cursor: entry.cursor, access: right))
    }
    if recursive {
      for rule in entry.cursor.entries {
        let suffix = rule.components.dropFirst(entry.cursor.depth).joined(separator: "/")
        let cursor = Policy.Cursor(entries: [], depth: rule.components.count,
          mode: rule.scope.mode, scopeIndices: [rule.index])
        for right in [Access.read, .write] where access.contains(right) {
          result.append(EffectItem(path: entry.path + "/" + suffix, cursor: cursor, access: right))
        }
      }
    }
    return result
  }
  private func authorizeEffect(_ operation: EffectOperation, purpose: OpenPurpose? = nil,
    source: EntrySelection? = nil, destination: EntrySelection? = nil,
    sourceObject: Record? = nil, items: [EffectItem]) async throws -> EffectTicket {
    try check()
    let opening = operation == .openRead || operation == .openWrite || operation == .openReadWrite
    guard opening == (purpose != nil),
      purpose != .metadataOwner || operation == .openRead,
      purpose != .setSize || operation == .openWrite || operation == .openReadWrite
    else { throw NFSStatus.serverFault }
    guard sourceObject == nil || (operation == .link && source == nil
      && sourceObject?.viewEpoch == generation) else { throw NFSStatus.serverFault }
    let entries = [source, destination].compactMap { $0 }
    guard !entries.isEmpty, entries.allSatisfy({ $0.generation == generation }),
      !items.isEmpty, items.count <= 4096 else { throw NFSStatus.access }
    guard items.allSatisfy({ $0.cursor.mode.decision($0.access) != .deny }) else { throw NFSStatus.access }
    let ticket = EffectTicket(operation: operation, purpose: purpose, source: source?.path ?? sourceObject?.path, destination: destination?.path,
      entries: entries, items: items, generation: generation)
    if items.contains(where: { $0.cursor.mode.decision($0.access) == .ask }) {
      guard try JSONSerialization.data(withJSONObject: ticket.wire).count <= maximumFrame / 2 else { throw NFSStatus.resource }
      for item in items {
        try await approve(item.path, cursor: item.cursor, access: item.access, effect: ticket)
      }
    }
    guard ticket.generation == generation else { throw NFSStatus.access }
    return ticket
  }
  private func authorityInstalled(_ owner: Descriptor, on record: Record) -> Bool {
    guard records[record.id] === record, !record.retired else { return false }
    if record.object === owner { return true }
    return stateCandidates(recordID: record.id).contains {
      !$0.closing && $0.recordIDs.contains(record.id)
        && ($0.reader === owner || $0.writer === owner)
    }
  }
  private func cachedMetadataRights(_ record: Record, readlink: Bool = false) -> Access { [] }
  private func clearMetadataRights(_ record: Record) {
    record.approvalOwner = nil
    record.metadataRights = []
    record.linkReadGranted = false
  }
  @discardableResult
  func authorize(_ record: Record, _ access: Access, traversal: Bool = false,
    captureStat: Bool = true, selected: stat? = nil, readlink: Bool = false) async throws -> stat {
    if protectedOwner(record) == nil, let parent = record.parent {
      _ = try await directoryOwner(parent)
    }
    let info = try selected ?? (captureStat ? snapshot(record) : record.observed)
    if protectedOwner(record) == nil { try refreshPathObservation(record, info) }
    let cursor = try viewPolicy(record)
    if traversal && cursor.mode == .deny && info.st_mode & S_IFMT != S_IFDIR { throw NFSStatus.access }
    let epoch = generation
    let admitted = protectedOwner(record)
    if let admitted { pinIdentity(record, admitted) }
    defer { withExtendedLifetime(admitted) {} }
    try await approve(record.path, cursor: cursor, access: access, traversal: traversal, selection: record)
    guard generation == epoch, records[record.id] === record, !record.retired else { throw NFSStatus.access }
    clearMetadataRights(record)
    record.touched = monotonicTime()
    return info
  }
  private func observationMatches(_ record: Record, _ info: stat) -> Bool {
    record.identity.device == info.st_dev && record.identity.inode == info.st_ino
      && (record.identity.generation == 0 || info.st_gen == 0 || record.identity.generation == info.st_gen)
      && record.observed.st_mode & S_IFMT == info.st_mode & S_IFMT
  }
  private func capture(_ entry: EntrySelection, traversal: Bool = false, hint: stat? = nil) async throws -> Record {
    guard entry.generation == generation, entry.cursor.traversable else { throw NFSStatus.access }
    var info = hint ?? stat()
    if hint == nil { try entry.directory.withFD { try checked(fstatat($0, entry.name, &info, AT_SYMLINK_NOFOLLOW)) } }
    if entry.cursor.mode == .deny && info.st_mode & S_IFMT != S_IFDIR { throw NFSStatus.access }
    let prior = entries[EntryKey(parent: entry.parent.id, name: Data(entry.name.utf8))].flatMap { records[$0] }
    let remembered: Access = prior.flatMap {
      !$0.retired && $0.viewEpoch == generation && observationMatches($0, info)
        ? cachedMetadataRights($0) : nil
    } ?? []
    try await approve(entry.path, cursor: entry.cursor, access: .read, traversal: traversal, remembered: remembered, entry: entry, observation: info)
    guard entry.generation == generation else { throw NFSStatus.access }
    return try publishEntry(entry, owner: nil, info: info, strong: false)
  }
  private func publishEntry(_ entry: EntrySelection, owner: Descriptor?, info: stat, strong: Bool) throws -> Record {
    guard entry.generation == generation else { throw NFSStatus.access }
    let key = EntryKey(parent: entry.parent.id, name: Data(entry.name.utf8))
    if let id = entries[key], let record = records[id], !record.retired,
      observationMatches(record, info), (!strong || record.identity == BackingIdentity(info)),
      protectedOwner(record) == nil || record.policyParentBinding == entry.parent.bindingVersion {
      try refreshPathObservation(record, info)
      record.policyView = entry.cursor
      record.viewEpoch = generation
      record.viewRevision = contextRevision
      record.touched = monotonicTime()
      if strong { record.strongIdentity = true }
      if info.st_mode & S_IFMT == S_IFDIR, let owner {
        record.object = owner; record.acquiredDirectory = true; record.strongIdentity = true
      }
      pinRecord(record); retainOptional(record)
      return record
    }
    if let id = entries[key], let previous = records[id] {
      publishViewChange(entry.parent); previous.unlinked = true
    }
    guard nextID != UInt64.max else { throw NFSStatus.resource }
    let record = Record(id: nextID, path: entry.path, info: info, parent: entry.parent, name: entry.name)
    nextID += 1
    try refreshPolicyContext(record, parent: entry.parent)
    if info.st_mode & S_IFMT == S_IFDIR, let owner {
      record.object = owner; record.acquiredDirectory = true
    }
    record.strongIdentity = strong
    record.viewEpoch = generation
    record.viewRevision = contextRevision
    record.policyView = entry.cursor
    records[record.id] = record
    pinRecord(record)
    entries[key] = record.id
    paths[record.path] = record.id
    retainOptional(record)
    return record
  }
  private func directoryOwner(_ record: Record) async throws -> Descriptor {
    guard !record.retired else { throw NFSStatus.handleExpired }
    pinRecord(record)
    if let owner = protectedOwner(record) {
      guard record.observed.st_mode & S_IFMT == S_IFDIR else { throw NFSStatus.notDirectory }
      directoryHits &+= 1; retainOptional(record); return owner
    }
    directoryMisses &+= 1
    guard let parent = record.parent else { throw NFSStatus.noEntry }
    let parentOwner = try await directoryOwner(parent)
    let epoch = generation
    try refreshPolicyContext(record, parent: parent)
    let cursor = try viewPolicy(parent).child(record.name, comparison: {
      try viewComparison(parent, owner: parentOwner)
    })
    let entry = EntrySelection(parent: parent, directory: parentOwner, name: record.name,
      path: try childPath(parent.path, record.name), cursor: cursor, generation: epoch)
    try await approve(entry.path, cursor: entry.cursor, access: .read, traversal: true, selection: record, entry: entry)
    guard epoch == generation, !record.retired else { throw NFSStatus.access }
    if let owner = protectedOwner(record) {
      guard record.observed.st_mode & S_IFMT == S_IFDIR else { throw NFSStatus.notDirectory }
      return owner
    }
    try makeRoom()
    acquisitionOpens &+= 1
    let owner = try parentOwner.withFD {
      Descriptor(try checked(openat($0, record.name, O_SEARCH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)))
    }
    var info = stat(); try owner.withFD { try checked(fstat($0, &info)) }
    let oldVersion = record.bindingVersion
    let oldComparison = record.comparison
    try refreshPathObservation(record, info)
    let comparison = try owner.withFD { try NameComparison(directoryFD: $0) }
    if record.acquiredDirectory && oldComparison != comparison { contextRevision &+= 1 }
    record.comparison = comparison
    record.policyView = nil
    // Pin the acquired object across any fresh replacement approval; no other action can substitute it.
    pinIdentity(record, owner)
    if record.bindingVersion != oldVersion {
      try await approve(entry.path, cursor: try viewPolicy(record), access: .read, traversal: true, selection: record, entry: entry)
    }
    guard epoch == generation else { throw NFSStatus.access }
    record.object = owner; record.acquiredDirectory = true; record.strongIdentity = true
    clearMetadataRights(record)
    retainOptional(record)
    return owner
  }
  private func recoverContext(_ record: Record) async throws -> Record {
    if !record.retired { return record }
    guard let parent = record.parent else { throw NFSStatus.handleExpired }
    let recovered = try await recoverContext(parent)
    return try await lookup(recovered, name: record.name)
  }
  private func objectOwner(_ record: Record, access: Access, readlink: Bool = false) async throws -> Descriptor {
    let selected = try await objectObservation(record, access: access, readlink: readlink)
    guard let owner = selected.owner else { throw NFSStatus.serverFault }
    return owner
  }
  private func objectObservation(_ record: Record, access: Access, readlink: Bool = false,
    captureStat: Bool = false) async throws -> MetadataSelection {
    let epoch = generation
    func heldObservation(_ owner: Descriptor) throws -> MetadataSelection {
      var info = record.observed
      if captureStat { try owner.withFD { try checked(fstat($0, &info)) } }
      guard observationMatches(record, info) else { throw NFSStatus.stale }
      return MetadataSelection(owner: owner, info: info, generation: epoch)
    }
    let retained = protectedOwner(record)
    if let retained { pinIdentity(record, retained) }
    _ = try await authorize(record, access, captureStat: false, readlink: readlink)
    if let retained { return try heldObservation(retained) }
    guard let parent = record.parent else { throw NFSStatus.noEntry }
    let parentOwner = try await directoryOwner(parent)
    guard epoch == generation else { throw NFSStatus.access }
    if let owner = protectedOwner(record) { return try heldObservation(owner) }
    try makeRoom()
    acquisitionOpens &+= 1
    let owner = try parentOwner.withFD {
      Descriptor(try checked(openat($0, record.name, O_EVTONLY | O_SYMLINK | O_CLOEXEC | O_NONBLOCK)))
    }
    var info = stat(); try owner.withFD { try checked(fstat($0, &info)) }
    let oldVersion = record.bindingVersion
    try refreshPathObservation(record, info)
    pinIdentity(record, owner)
    if record.bindingVersion != oldVersion {
      _ = try await authorize(record, access, captureStat: false, readlink: readlink)
    }
    guard epoch == generation else { throw NFSStatus.access }
    return MetadataSelection(owner: owner, info: info, generation: epoch)
  }
  func record(_ id: UInt64) throws -> Record {
    guard let record = records[id] else { throw NFSStatus.stale }
    guard !record.retired else { throw NFSStatus.handleExpired }
    pinRecord(record)
    record.touched = monotonicTime()
    return record
  }
  func fileHandle(_ record: Record) -> Data {
    var result = XDRWriter()
    result.fixed(epoch)
    result.uint64(record.id)
    return result.data
  }
  func record(handle: Data) throws -> Record {
    guard handle.count == 16, handle.prefix(8) == epoch else { throw NFSStatus.badHandle }
    var input = XDRReader(data: handle)
    _ = try input.take(8)
    let id = try input.uint64()
    guard records[id] != nil else { throw NFSStatus.stale }
    return try record(id)
  }
  private func retainedOwner(_ owner: OpenOwner, now: UInt64) -> Bool {
    owner.pending || now - owner.touched < UInt64(leaseSeconds) * 2_000_000_000
      || states.values.contains(where: { $0.owner == owner.key })
  }
  private func liveClosedReplay(_ owner: OpenOwner, handle: UInt64) -> Bool {
    let now = monotonicTime()
    let lease = UInt64(leaseSeconds) * 1_000_000_000
    guard owner.closedHandle == handle, let key = owner.closedKey,
      let result = owner.result, result.status == .ok, result.current == handle,
      result.body.count == 16, Data(result.body.suffix(12)) == key,
      owner.sequence != nil, retainedOwner(owner, now: now),
      let client = clients[owner.key.client], client.confirmed,
      now - client.renewed < lease else { return false }
    return true
  }
  private func fileContext(handle: Data) throws -> HandleContext {
    guard handle.count == 16, handle.prefix(8) == epoch else { throw NFSStatus.badHandle }
    var input = XDRReader(data: handle)
    _ = try input.take(8)
    let id = try input.uint64()
    if let record = try? record(id) { return .object(record) }
    guard owners.values.contains(where: { liveClosedReplay($0, handle: id) }) else {
      throw records[id]?.retired == true ? NFSStatus.handleExpired : NFSStatus.stale
    }
    return .replay(ReplayHandle(id: id))
  }
  private func replayClose(_ handle: ReplayHandle, stateID: Data, sequence: UInt32,
    signature: Data) async throws -> OperationResult {
    guard stateID.count == 16 else { throw NFSStatus.badStateID }
    let key = Data(stateID.suffix(12))
    guard let owner = owners.values.first(where: {
      $0.closedKey == key && liveClosedReplay($0, handle: handle.id)
    }) else { throw NFSStatus.badStateID }
    guard owner.sequence == sequence, owner.signature == signature else { throw NFSStatus.badSequenceID }
    guard let result = try await beginSequence(owner, sequence: sequence, signature: signature) else {
      throw NFSStatus.serverFault
    }
    return result
  }
  func snapshot(_ record: Record) throws -> stat {
    guard !record.retired else { throw NFSStatus.handleExpired }
    var info = stat()
    if let owner = protectedOwner(record) {
      try owner.withFD { try checked(fstat($0, &info)) }
      guard observationMatches(record, info) else { throw NFSStatus.stale }
      record.observed = info
    } else {
      guard let parent = record.parent, let owner = protectedOwner(parent) else { throw NFSStatus.delay }
      try owner.withFD { try checked(fstatat($0, record.name, &info, AT_SYMLINK_NOFOLLOW)) }
      try refreshPathObservation(record, info)
    }
    return info
  }
  private func stateCandidates(recordID: UInt64) -> [OpenState] {
    (stateKeysByRecordID[recordID] ?? []).compactMap { states[$0] }
  }
  private func stateCandidates(identity: BackingIdentity) -> [OpenState] {
    guard let keys = stateKeysByIdentityOwner[identity] else { return [] }
    return keys.values.compactMap { states[$0] }
  }
  private func indexedState(owner: OwnerKey, identity: BackingIdentity) -> OpenState? {
    guard let key = stateKeysByIdentityOwner[identity]?[owner] else { return nil }
    return states[key]
  }
  private func publishState(_ state: OpenState, recordID: UInt64) {
    let same = states[state.key] === state
    if let previous = states[state.key], previous !== state {
      removeState(state.key)
    }
    states[state.key] = state
    unlinkOptional(recordID)
    stateKeysByIdentityOwner[state.record.identity, default: [:]][state.owner] = state.key
    let recordIDs = same ? [recordID] : Array(state.recordIDs)
    for id in recordIDs {
      if !(stateKeysByRecordID[id]?.contains(state.key) ?? false) {
        stateKeysByRecordID[id, default: []].append(state.key)
      }
    }
  }
  private func removeState(_ key: Data) {
    guard let state = states.removeValue(forKey: key) else { return }
    for id in state.recordIDs {
      stateKeysByRecordID[id]?.removeAll { $0 == key }
      if stateKeysByRecordID[id]?.isEmpty == true {
        stateKeysByRecordID.removeValue(forKey: id)
      }
    }
    if stateKeysByIdentityOwner[state.record.identity]?[state.owner] == key {
      stateKeysByIdentityOwner[state.record.identity]?.removeValue(forKey: state.owner)
    }
    if stateKeysByIdentityOwner[state.record.identity]?.isEmpty == true {
      stateKeysByIdentityOwner.removeValue(forKey: state.record.identity)
    }
    for id in state.recordIDs where stateKeysByRecordID[id] == nil {
      if let record = records[id] { clearMetadataRights(record); retainOptional(record) }
    }
  }
  func dataDescriptor(_ record: Record) -> Descriptor? {
    stateCandidates(recordID: record.id).first(where: { $0.recordIDs.contains(record.id) })
      .flatMap { $0.reader ?? $0.writer }
  }
  func handle(_ record: Record) throws -> Descriptor {
    guard records[record.id] === record, !record.retired else { throw NFSStatus.handleExpired }
    pinRecord(record)
    if record.id == 2 { return root }
    if let data = dataDescriptor(record) { return data }
    guard let object = record.object else {
      throw NFSStatus.handleExpired
    }
    record.touched = monotonicTime()
    retainOptional(record)
    return object
  }
  func validate(_ descriptor: Descriptor, record: Record) throws {
    var info = stat()
    try descriptor.withFD { try checked(fstat($0, &info)) }
    guard BackingIdentity(info) == record.identity else { throw NFSStatus.stale }
  }
  @discardableResult
  func refresh(_ record: Record, using fd: Int32? = nil) throws -> stat {
    if let fd {
      var info = stat(); try checked(fstat(fd, &info))
      guard BackingIdentity(info) == record.identity else { throw NFSStatus.handleExpired }
      return info
    }
    return try snapshot(record)
  }
  func change(_ record: Record, info: stat) -> UInt64 {
    let signature = ChangeSignature(info, generation: generation, publication: record.publicationEpoch)
    if record.signature != signature {
      changeCounter &+= 1
      record.signature = signature
      record.change = changeCounter
    }
    return record.change
  }
  func change(_ record: Record) throws -> UInt64 { change(record, info: try snapshot(record)) }
}

extension NFSServer {
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
  fileprivate func linkContents(_ path: String, identity: Descriptor) throws -> String {
    var size = 256
    while size <= maximumIO {
      var bytes = [CChar](repeating: 0, count: size)
      let count = try identity.withFD { try checked(freadlink($0, &bytes, bytes.count)) }
      if count < size {
        guard let text = String(validating: bytes.prefix(count).map { UInt8(bitPattern: $0) }, as: UTF8.self) else {
          throw failure(EILSEQ)
        }
        return text
      }
      size *= 2
    }
    throw NFSStatus.nameTooLong
  }
  private func linkComponents(_ target: String) throws -> (absolute: Bool, parts: [String]) {
    guard !target.isEmpty else { throw NFSStatus.noEntry }
    let absolute = target.hasPrefix("/")
    var value = target
    if absolute {
      guard covers(backingRoot, target) else { throw NFSStatus.access }
      if backingRoot != "/" { value = String(target.dropFirst(backingRoot.count)) }
    }
    var parts = value.split(separator: "/").map(String.init)
    if value.hasSuffix("/"), !parts.isEmpty { parts.append(".") }
    return (absolute, parts)
  }
  private func relativeLink(_ record: Record, destination: [String]) -> String {
    let origin = parentPath(record.path).split(separator: "/").map(String.init)
    var common = 0
    while common < min(origin.count, destination.count)
      && origin[common].utf8.elementsEqual(destination[common].utf8) { common += 1 }
    let result = Array(repeating: "..", count: origin.count - common) + destination.dropFirst(common)
    return result.isEmpty ? "." : result.joined(separator: "/")
  }
  fileprivate func projectedLinkTarget(id: UInt64) async throws -> String {
    let record = try self.record(id)
    let initialGeneration = generation
    let owner = try await objectOwner(record, access: .read, readlink: true)
    return try await projectLinkTarget(record, owner: owner, generation: initialGeneration)
  }
  private func projectLinkTarget(_ record: Record, owner: Descriptor, generation initialGeneration: Int) async throws -> String {
    defer { withExtendedLifetime(owner) {} }
    guard initialGeneration == generation else { throw NFSStatus.access }
    guard record.observed.st_mode & S_IFMT == S_IFLNK else { throw NFSStatus.invalid }
    let parsed = try linkComponents(linkContents(record.path, identity: owner))
    var pending = parsed.parts
    var directory: Record
    if parsed.absolute { directory = try self.record(2) }
    else {
      guard let parent = record.parent else { throw NFSStatus.handleExpired }
      directory = parent
    }
    var links = 1
    while true {
      guard initialGeneration == generation else { throw NFSStatus.access }
      while let first = pending.first, first == "." || first == ".." {
        pending.removeFirst()
        if first == ".." {
          guard directory.id != 2 else { throw NFSStatus.access }
          directory = try await lookupParent(directory)
        }
      }
      if !pending.contains("..") {
        return relativeLink(record, destination: directory.path.split(separator: "/").map(String.init) + pending)
      }
      guard !pending.isEmpty else { return relativeLink(record, destination: directory.path.split(separator: "/").map(String.init)) }
      let next = try await lookup(directory, name: pending.removeFirst())
      if next.observed.st_mode & S_IFMT == S_IFLNK {
        guard links < Int(MAXSYMLINKS) else { throw NFSStatus.symlink }
        links += 1
        _ = try await authorize(next, .read, captureStat: false, readlink: true)
        let nextOwner = try await objectOwner(next, access: .read, readlink: true)
        let target = try linkComponents(linkContents(next.path, identity: nextOwner))
        if target.absolute { directory = try self.record(2) }
        pending = target.parts + pending
      } else {
        guard next.observed.st_mode & S_IFMT == S_IFDIR else { throw NFSStatus.notDirectory }
        directory = next
      }
    }
  }

}

private struct DirectoryObservation {
  let name: String
  var consumed = false
  var info: stat?
  var valid: Set<Int> = []
  var error: NFSStatus?
  var cookie: UInt64 = 0
}
private final class DirectoryCursor {
  var stream: UnsafeMutablePointer<DIR>?
  let verifier: UInt64
  let directoryChange: UInt64
  let generation: Int
  let directoryID: UInt64
  let directoryIdentity: BackingIdentity
  var anchor: Descriptor?
  var bulk = true
  var busy = false
  var batch: [DirectoryObservation] = []
  var batchRequest: UUID?
  var index = 0
  var ended = false
  var emittedBulkCookies = false
  var estimatedBytes = 256
  var touched = monotonicTime()
  init(stream: UnsafeMutablePointer<DIR>, verifier: UInt64, directoryChange: UInt64,
    generation: Int, anchor: Descriptor, directoryID: UInt64, directoryIdentity: BackingIdentity) {
    self.directoryIdentity = directoryIdentity
    self.stream = stream; self.verifier = verifier; self.directoryChange = directoryChange
    self.generation = generation; self.anchor = anchor; self.directoryID = directoryID
    descriptorCounter.adjust(1)
  }
  func finish() {
    if let stream { closedir(stream); descriptorCounter.adjust(-1); self.stream = nil }
    anchor = nil
    ended = true
  }
  deinit { if let stream { closedir(stream); descriptorCounter.adjust(-1) } }
}

extension NFSServer {
  fileprivate func directoryEntry(_ stream: UnsafeMutablePointer<DIR>) throws -> String? {
    errno = 0
    guard let entry = Darwin.readdir(stream) else {
      if errno != 0 { throw failure() }
      return nil
    }
    return try withUnsafePointer(to: &entry.pointee.d_name) {
      try $0.withMemoryRebound(to: UInt8.self, capacity: Int(entry.pointee.d_namlen)) {
        guard
          let name = String(
            bytes: UnsafeBufferPointer(
              start: $0,
              count: Int(entry.pointee.d_namlen)), encoding: .utf8)
        else { throw failure(EILSEQ) }
        return name
      }
    }
  }
  private func lookupParent(_ directory: Record) async throws -> Record {
    guard directory.id != 2 else { throw NFSStatus.noEntry }
    let owner = try await directoryOwner(directory)
    _ = try await authorize(directory, .read, traversal: true, captureStat: false)
    try makeRoom()
    acquisitionOpens &+= 1
    let actual = try owner.withFD {
      Descriptor(try checked(openat($0, "..", O_SEARCH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)))
    }
    var info = stat(); try actual.withFD { try checked(fstat($0, &info)) }
    if let cached = directory.parent, !cached.retired, let cachedOwner = cached.object {
      var live = stat()
      try cachedOwner.withFD { try checked(fstat($0, &live)) }
      if BackingIdentity(live) == BackingIdentity(info), observationMatches(cached, info) {
        _ = try await authorize(cached, .read, traversal: true, captureStat: false)
        pinRecord(cached); retainOptional(cached)
        return cached
      }
    }
    let path = try relativePath(actual)
    guard validPath(path) else { throw NFSStatus.access }
    var repaired = try record(2)
    for name in path.split(separator: "/").map(String.init) {
      repaired = try await lookup(repaired, name: name)
      _ = try await directoryOwner(repaired)
    }
    guard observationMatches(repaired, info) else { throw NFSStatus.delay }
    _ = try await authorize(repaired, .read, traversal: true, captureStat: false)
    return repaired
  }
  fileprivate func lookup(_ directory: Record, name: String) async throws -> Record {
    try await capture(select(directory, name: name), traversal: true)
  }
  fileprivate func apply(
    _ changes: AttributeChanges, to record: Record,
    writer: Descriptor? = nil, pin: Descriptor? = nil
  ) throws {
    let owner = try writer ?? pin ?? handle(record)
    if let size = changes.size {
      guard record.observed.st_mode & S_IFMT == S_IFREG else { throw NFSStatus.invalid }
      guard let writer else { throw NFSStatus.openMode }
      try writer.withFD { try checked(ftruncate($0, off_t(size))) }
    }
    try owner.withFD { fd in
      if changes.uid != nil || changes.gid != nil {
        try checked(fchown(fd, changes.uid ?? uid_t.max, changes.gid ?? gid_t.max))
      }
      if let mode = changes.mode { try checked(fchmod(fd, mode_t(mode))) }
      if changes.accessTime != nil || changes.modifyTime != nil {
        let times = [changes.accessTime ?? timespec(tv_sec: 0, tv_nsec: Int(UTIME_OMIT)),
          changes.modifyTime ?? timespec(tv_sec: 0, tv_nsec: Int(UTIME_OMIT))]
        try checked(futimens(fd, times))
      }
      if var birth = changes.birthTime {
        var list = attrlist(); list.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
        list.commonattr = attrgroup_t(ATTR_CMN_CRTIME)
        try checked(fsetattrlist(fd, &list, &birth, MemoryLayout<timespec>.size, 0))
      }
    }
  }
  private func attributeOwner(_ record: Record, requested: Set<Int>) async throws -> Descriptor? {
    let needsOwner: Set<Int> = [
      Attribute.caseInsensitive.rawValue, Attribute.maximumLinks.rawValue, Attribute.maximumName.rawValue,
      Attribute.filesAvailable.rawValue, Attribute.filesFree.rawValue, Attribute.filesTotal.rawValue,
      Attribute.spaceAvailable.rawValue, Attribute.spaceFree.rawValue, Attribute.spaceTotal.rawValue,
    ]
    if requested.isDisjoint(with: needsOwner) { return protectedOwner(record) }
    if let owner = protectedOwner(record) { return owner }
    if record.observed.st_mode & S_IFMT == S_IFDIR { return try await directoryOwner(record) }
    return nil
  }
  private func prepareLinkSize(_ record: Record, info: stat, owner knownOwner: Descriptor?,
    allowPrompt: Bool) async throws -> (owner: Descriptor, info: stat, size: UInt64?) {
    try await MetadataPromptScope.$allowed.withValue(allowPrompt && MetadataPromptScope.allowed) {
      let epoch = generation
      let selected: MetadataSelection
      if let knownOwner {
        pinIdentity(record, knownOwner)
        guard observationMatches(record, info) else { throw NFSStatus.stale }
        _ = try await authorize(record, .read, captureStat: false, selected: info, readlink: true)
        selected = MetadataSelection(owner: knownOwner, info: info, generation: epoch)
      } else {
        selected = try await objectObservation(record, access: .read, readlink: true, captureStat: true)
      }
      guard let owner = selected.owner, generation == epoch, selected.generation == epoch else { throw NFSStatus.access }
      defer { withExtendedLifetime(owner) {} }
      guard observationMatches(record, selected.info) else { throw NFSStatus.stale }
      if selected.info.st_mode & S_IFMT != S_IFLNK { return (owner, selected.info, nil) }
      let target = try await projectLinkTarget(record, owner: owner, generation: epoch)
      guard generation == epoch, observationMatches(record, selected.info) else { throw NFSStatus.access }
      return (owner, selected.info, UInt64(target.utf8.count))
    }
  }
  fileprivate func attributes(
    _ record: Record, requested: Set<Int>, info: stat? = nil,
    filesystem: statfs? = nil, pinnedFD: Int32? = nil, projectedLinkSize: UInt64? = nil
  ) throws -> Data {
    if requested.contains(Attribute.timeAccessSet.rawValue)
      || requested.contains(Attribute.timeModifySet.rawValue)
    {
      throw NFSStatus.invalid
    }
    let info = try info ?? snapshot(record)
    var fs = filesystem ?? statfs()
    let pathconfAttributes: Set<Int> = [
      Attribute.caseInsensitive.rawValue, Attribute.maximumLinks.rawValue,
      Attribute.maximumName.rawValue,
    ]
    let filesystemAttributes: Set<Int> = [
      Attribute.filesAvailable.rawValue, Attribute.filesFree.rawValue,
      Attribute.filesTotal.rawValue, Attribute.spaceAvailable.rawValue,
      Attribute.spaceFree.rawValue, Attribute.spaceTotal.rawValue,
    ]
    let hasOwnDescriptor = pinnedFD != nil || record.object != nil || dataDescriptor(record) != nil
    var supported = Set(Attribute.allCases.map(\.rawValue))
    if !hasOwnDescriptor && info.st_mode & S_IFMT != S_IFDIR {
      supported.subtract(pathconfAttributes.union(filesystemAttributes))
    }
    let bits = requested.intersection(supported)
    let needsFilesystem = filesystem == nil && !bits.isDisjoint(with: filesystemAttributes)
    let needsDescriptor = needsFilesystem || !bits.isDisjoint(with: pathconfAttributes)
    let handle = pinnedFD == nil && needsDescriptor ? (protectedOwner(record)) : nil
    defer { withExtendedLifetime(handle) {} }
    let nativeFD = pinnedFD ?? handle?.value
    if needsDescriptor && nativeFD == nil { throw NFSStatus.attributeNotSupported }
    let configurationOwner = [handle, record.object, dataDescriptor(record)]
      .compactMap { $0 }.first { $0.value == nativeFD }
    if needsFilesystem, let nativeFD { try checked(fstatfs(nativeFD, &fs)) }
    func configuration(_ name: Int32) throws -> Int {
      guard let nativeFD else { throw NFSStatus.serverFault }
      if let configurationOwner { return try descriptorConfiguration(configurationOwner, name) }
      errno = 0
      let value = fpathconf(nativeFD, name)
      if value < 0 && errno != 0 { throw failure() }
      return value
    }
    var values = XDRWriter()
    for bit in bits.sorted() {
      guard let attribute = Attribute(rawValue: bit) else { throw NFSStatus.serverFault }
      switch attribute {
      case .supported: values.bitmap(supported)
      case .type: values.uint32(try FileKind(info.st_mode).rawValue)
      case .handleExpiry: values.uint32(2)
      case .change: values.uint64(change(record, info: info))
      case .size:
        if info.st_mode & S_IFMT == S_IFLNK {
          guard let projectedLinkSize else { throw NFSStatus.serverFault }
          values.uint64(projectedLinkSize)
        } else { values.uint64(UInt64(max(0, info.st_size))) }
      case .linkSupport: values.bool(false)
      case .symlinkSupport, .canSetTime, .casePreserving, .noTruncate:
        values.bool(true)
      case .namedAttributes, .uniqueHandles, .homogeneous: values.bool(false)
      case .fsid:
        values.uint64(UInt64(UInt32(bitPattern: info.st_dev)))
        values.fixed(epoch)
      case .leaseTime: values.uint32(leaseSeconds)
      case .readAttributeError, .aclSupport: values.uint32(0)
      case .caseInsensitive:
        let value = try configuration(_PC_CASE_SENSITIVE)
        guard value >= 0 else { throw NFSStatus.notSupported }
        values.bool(value == 0)
      case .chownRestricted: values.bool(true)
      case .fileHandle: values.opaque(fileHandle(record))
      case .fileID, .mountedOnFileID: values.uint64(info.st_ino)
      case .filesAvailable, .filesFree: values.uint64(fs.f_ffree)
      case .filesTotal: values.uint64(fs.f_files)
      case .maximumFileSize: values.uint64(UInt64(Int64.max))
      case .maximumLinks:
        let count = try configuration(_PC_LINK_MAX)
        values.uint32(count < 0 ? UInt32.max : UInt32(clamping: count))
      case .maximumName:
        let count = try configuration(_PC_NAME_MAX)
        values.uint32(count < 0 ? 255 : UInt32(clamping: count))
      case .maximumRead, .maximumWrite: values.uint64(UInt64(maximumIO))
      case .mode: values.uint32(UInt32(info.st_mode & 0o7777))
      case .links: values.uint32(UInt32(info.st_nlink))
      case .owner: values.string(String(info.st_uid))
      case .ownerGroup: values.string(String(info.st_gid))
      case .rawDevice:
        values.uint32(UInt32(bitPattern: info.st_rdev) >> 24)
        values.uint32(UInt32(bitPattern: info.st_rdev) & 0x00ff_ffff)
      case .spaceAvailable: values.uint64(fs.f_bavail * UInt64(fs.f_bsize))
      case .spaceFree: values.uint64(fs.f_bfree * UInt64(fs.f_bsize))
      case .spaceTotal: values.uint64(fs.f_blocks * UInt64(fs.f_bsize))
      case .spaceUsed: values.uint64(UInt64(max(0, info.st_blocks)) * 512)
      case .timeAccess: values.time(info.st_atimespec)
      case .timeCreate: values.time(info.st_birthtimespec)
      case .timeMetadata: values.time(info.st_ctimespec)
      case .timeModify: values.time(info.st_mtimespec)
      case .timeDelta: values.time(timespec(tv_sec: 0, tv_nsec: 1))
      case .timeAccessSet, .timeModifySet: throw NFSStatus.invalid
      }
    }
    var output = XDRWriter()
    output.bitmap(bits)
    output.opaque(values.data)
    return output.data
  }
  private func directoryBatch(_ cursor: DirectoryCursor, capacity: Int) throws -> [DirectoryObservation] {
    guard let stream = cursor.stream else { return [] }
    bulkCalls &+= 1
    var list = attrlist()
    list.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
    let commonAttributes: [UInt32] = [
      UInt32(ATTR_CMN_RETURNED_ATTRS), UInt32(ATTR_CMN_ERROR), UInt32(ATTR_CMN_NAME),
      UInt32(ATTR_CMN_DEVID), UInt32(ATTR_CMN_OBJTYPE), UInt32(ATTR_CMN_CRTIME), UInt32(ATTR_CMN_MODTIME),
      UInt32(ATTR_CMN_CHGTIME), UInt32(ATTR_CMN_ACCTIME), UInt32(ATTR_CMN_OWNERID), UInt32(ATTR_CMN_GRPID),
      UInt32(ATTR_CMN_ACCESSMASK), UInt32(ATTR_CMN_FILEID),
    ]
    list.commonattr = commonAttributes.reduce(0) { $0 | $1 }
    list.dirattr = attrgroup_t(ATTR_DIR_LINKCOUNT | ATTR_DIR_ALLOCSIZE | ATTR_DIR_DATALENGTH)
    list.fileattr = attrgroup_t(ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE | ATTR_FILE_DEVTYPE | ATTR_FILE_DATALENGTH)
    var data = Data(count: capacity)
    let count = try data.withUnsafeMutableBytes {
      try checked(getattrlistbulk(dirfd(stream), &list, $0.baseAddress, $0.count, 0))
    }
    var result: [DirectoryObservation] = []
    var start = 0
    for _ in 0..<Int(count) {
      guard start <= data.count - 4 else { throw failure(EPROTO) }
      let length = Int(data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: start, as: UInt32.self) })
      guard length >= 24, length <= data.count - start else { throw failure(EPROTO) }
      let end = start + length
      var offset = start + 4
      func take<T>(_ type: T.Type) throws -> T {
        guard MemoryLayout<T>.size <= end - offset else { throw failure(EPROTO) }
        defer { offset += MemoryLayout<T>.size }
        return data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: T.self) }
      }
      let returned = try take(attribute_set_t.self)
      guard returned.commonattr & ~list.commonattr == 0, returned.dirattr & ~list.dirattr == 0,
        returned.fileattr & ~list.fileattr == 0, returned.volattr == 0, returned.forkattr == 0,
        returned.commonattr & (attrgroup_t(ATTR_CMN_RETURNED_ATTRS) | attrgroup_t(ATTR_CMN_NAME))
          == (attrgroup_t(ATTR_CMN_RETURNED_ATTRS) | attrgroup_t(ATTR_CMN_NAME)) else { throw failure(EPROTO) }
      func common(_ bit: UInt32) -> Bool { returned.commonattr & attrgroup_t(bit) != 0 }
      func directory(_ bit: UInt32) -> Bool { returned.dirattr & attrgroup_t(bit) != 0 }
      func file(_ bit: UInt32) -> Bool { returned.fileattr & attrgroup_t(bit) != 0 }
      let nativeError = common(UInt32(ATTR_CMN_ERROR)) ? try take(UInt32.self) : 0
      let referencePosition = offset
      let reference = try take(attrreference_t.self)
      let nameStart = referencePosition + Int(reference.attr_dataoffset)
      let nameLength = Int(reference.attr_length)
      guard nameStart >= start, nameStart <= end, nameLength >= 1, nameLength <= end - nameStart,
        data[nameStart + nameLength - 1] == 0,
        let name = String(data: data.subdata(in: nameStart..<(nameStart + nameLength - 1)), encoding: .utf8)
      else { throw failure(EPROTO) }
      var row = DirectoryObservation(name: name)
      var info = stat()
      func valid(_ attribute: Attribute) { row.valid.insert(attribute.rawValue) }
      if common(UInt32(ATTR_CMN_DEVID)) {
        info.st_dev = try take(dev_t.self); valid(.fsid)
      }
      if common(UInt32(ATTR_CMN_OBJTYPE)) {
        let type = try take(UInt32.self)
        let mode: mode_t
        switch type {
        case 1: mode = S_IFREG
        case 2: mode = S_IFDIR
        case 3: mode = S_IFBLK
        case 4: mode = S_IFCHR
        case 5: mode = S_IFLNK
        case 6: mode = S_IFSOCK
        case 7: mode = S_IFIFO
        default: throw failure(EPROTO)
        }
        info.st_mode = mode; valid(.type)
      }
      if common(UInt32(ATTR_CMN_CRTIME)) { info.st_birthtimespec = try take(timespec.self); valid(.timeCreate) }
      if common(UInt32(ATTR_CMN_MODTIME)) { info.st_mtimespec = try take(timespec.self); valid(.timeModify) }
      if common(UInt32(ATTR_CMN_CHGTIME)) { info.st_ctimespec = try take(timespec.self); valid(.timeMetadata) }
      if common(UInt32(ATTR_CMN_ACCTIME)) { info.st_atimespec = try take(timespec.self); valid(.timeAccess) }
      if common(UInt32(ATTR_CMN_OWNERID)) { info.st_uid = try take(uid_t.self); valid(.owner) }
      if common(UInt32(ATTR_CMN_GRPID)) { info.st_gid = try take(gid_t.self); valid(.ownerGroup) }
      if common(UInt32(ATTR_CMN_ACCESSMASK)) {
        info.st_mode |= mode_t(try take(UInt32.self) & 0o7777); valid(.mode)
      }
      if common(UInt32(ATTR_CMN_FILEID)) {
        info.st_ino = try take(UInt64.self); valid(.fileID); valid(.mountedOnFileID)
      }
      if directory(UInt32(ATTR_DIR_LINKCOUNT)) {
        _ = try take(UInt32.self)
      }
      if directory(UInt32(ATTR_DIR_ALLOCSIZE)) {
        let size = try take(Int64.self); guard size >= 0 else { throw failure(EPROTO) }
      }
      if directory(UInt32(ATTR_DIR_DATALENGTH)) { _ = try take(off_t.self) }
      if file(UInt32(ATTR_FILE_LINKCOUNT)) {
        info.st_nlink = nlink_t(clamping: try take(UInt32.self)); valid(.links)
      }
      if file(UInt32(ATTR_FILE_ALLOCSIZE)) {
        let size = try take(Int64.self); guard size >= 0 else { throw failure(EPROTO) }
        info.st_blocks = size / 512; valid(.spaceUsed)
      }
      if file(UInt32(ATTR_FILE_DEVTYPE)) { info.st_rdev = try take(dev_t.self); valid(.rawDevice) }
      if file(UInt32(ATTR_FILE_DATALENGTH)) { info.st_size = try take(off_t.self); valid(.size) }
      if nativeError != 0 { row.error = nfsStatus(failure(Int32(bitPattern: nativeError))) }
      else if row.valid.contains(Attribute.type.rawValue) { row.info = info }
      result.append(row)
      start = end
    }
    return result
  }
  private var continuationBytes: Int {
    directoryCursors.values.reduce(0) { $0 + $1.estimatedBytes }
      + olderDirectoryCursors.values.reduce(0) { $0 + $1.estimatedBytes }
  }
  private func materializeDirectory(_ cursor: DirectoryCursor, directory: Record, anchor: Descriptor) throws {
    let started = monotonicTime()
    activeListingBuilders += 1
    peakListingBuilders = max(peakListingBuilders, activeListingBuilders)
    pinIdentity(directory, anchor)
    defer {
      cursor.finish()
      withExtendedLifetime(anchor) {}
      activeListingBuilders -= 1
      listingBuildNanos &+= monotonicTime() - started
    }
    let request = UUID()
    // Synchronous actor-isolated scan: one builder at a time, no client continuation owns a stream.
    while try nextDirectory(cursor, request: request, capacity: 256 * 1024) != nil {}
    cursor.index = 0
    listingBuilds &+= 1
    listingRowsBuilt &+= UInt64(cursor.batch.count)
  }
  private func seekDirectory(_ cursor: DirectoryCursor, cookie: UInt64, request: UUID) throws {
    let offset = cookie == 0 ? 0 : cookie >= 3 ? cookie - 3 : UInt64.max
    guard offset <= UInt64(cursor.batch.count) else { throw NFSStatus.notSame }
    cursor.index = Int(offset)
    cursor.batchRequest = request
  }
  private func nextDirectory(_ cursor: DirectoryCursor, request: UUID, capacity: Int) throws -> DirectoryObservation? {
    if cursor.index == cursor.batch.count {
      if cursor.ended { return nil }
      guard let stream = cursor.stream else { throw NFSStatus.notSame }
      var rows: [DirectoryObservation] = []
      if cursor.bulk {
        do { rows = try directoryBatch(cursor, capacity: capacity) }
        catch {
          let status = nfsStatus(error)
          guard cursor.batch.isEmpty && (status == .notSupported || status == .invalid) else { throw error }
          cursor.bulk = false; rewinddir(stream)
        }
      }
      if !cursor.bulk, let name = try directoryEntry(stream) { rows = [DirectoryObservation(name: name)] }
      if rows.isEmpty { cursor.finish(); return nil }
      let bytes = rows.reduce(0) { $0 + 512 + $1.name.utf8.count }
      cursor.estimatedBytes += bytes
      cursor.batch.append(contentsOf: rows)
    }
    var row = cursor.batch[cursor.index]
    cursor.index += 1
    row.cookie = UInt64(cursor.index) + 3
    return row
  }
  private func unreadDirectory(_ cursor: DirectoryCursor) { cursor.index -= 1 }
  fileprivate func readDirectory(
    _ directory: Record, cookie: UInt64, verifier: UInt64,
    directoryCount: UInt32, maximumCount: UInt32, requested: Set<Int>
  ) async throws -> Data {
    try check()
    let anchor = try await directoryOwner(directory)
    guard directory.observed.st_mode & S_IFMT == S_IFDIR else { throw NFSStatus.notDirectory }
    let directoryPolicy = try viewPolicy(directory)
    let initialGeneration = generation
    try await approve(directory.path, cursor: directoryPolicy, access: .read, traversal: true,
      selection: directory)
    guard initialGeneration == generation, authorityInstalled(anchor, on: directory) else { throw NFSStatus.access }
    clearMetadataRights(directory)
    var directoryInfo = stat()
    try anchor.withFD { try checked(fstat($0, &directoryInfo)) }
    let version = change(directory, info: directoryInfo)
    let cursor: DirectoryCursor
    if cookie != 0 {
      guard cookie >= 3, let existing = (directoryCursors[directory.id]?.verifier == verifier
        ? directoryCursors[directory.id] : olderDirectoryCursors[verifier]),
        existing.directoryID == directory.id, existing.generation == generation,
        existing.directoryIdentity == BackingIdentity(directoryInfo), existing.ended
        else { throw NFSStatus.notSame }
      cursor = existing
    } else if let existing = directoryCursors[directory.id], existing.directoryChange == version,
      existing.generation == generation, existing.directoryIdentity == BackingIdentity(directoryInfo),
      existing.ended { cursor = existing }
    else {
      if let previous = directoryCursors.removeValue(forKey: directory.id) {
        olderDirectoryCursors[previous.verifier] = previous
      }
      guard directorySerial < UInt64.max else { throw NFSStatus.resource }
      try makeRoom()
      var nonce = XDRReader(data: epoch)
      let cursorVerifier = try nonce.uint64() &+ directorySerial
      directorySerial += 1
      acquisitionOpens &+= 1
      let fd = try anchor.withFD { try checked(openat($0, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)) }
      do {
        var opened = stat(); try checked(fstat(fd, &opened))
        guard BackingIdentity(opened) == BackingIdentity(directoryInfo), opened.st_mode & S_IFMT == S_IFDIR
        else { throw NFSStatus.notSame }
      } catch { Darwin.close(fd); throw error }
      guard let stream = fdopendir(fd) else { let error = failure(); Darwin.close(fd); throw error }
      cursor = DirectoryCursor(stream: stream, verifier: cursorVerifier, directoryChange: version,
        generation: generation, anchor: anchor, directoryID: directory.id,
        directoryIdentity: BackingIdentity(directoryInfo))
      try materializeDirectory(cursor, directory: directory, anchor: anchor)
      directoryCursors[directory.id] = cursor
    }
    guard !cursor.busy else { throw NFSStatus.delay }
    cursor.touched = monotonicTime()
    cursor.busy = true
    defer { cursor.busy = false }
    let enumeration = UUID()
    try seekDirectory(cursor, cookie: cookie, request: enumeration)
    var completed = false
    defer {
      if !completed {
        if directoryCursors[directory.id] === cursor { directoryCursors.removeValue(forKey: directory.id) }
        olderDirectoryCursors.removeValue(forKey: cursor.verifier)
      }
    }
    let batchCapacity = min(256 * 1024, max(4096, Int(maximumCount)))
    var output = XDRWriter()
    output.uint64(cursor.verifier)
    var namesSize = 0
    var count = 0
    let limit = min(Int(maximumCount), maximumIO)
    let ownerAttributes: Set<Int> = [
      Attribute.fileHandle.rawValue, Attribute.change.rawValue,
      Attribute.caseInsensitive.rawValue, Attribute.maximumLinks.rawValue, Attribute.maximumName.rawValue,
      Attribute.filesAvailable.rawValue, Attribute.filesFree.rawValue, Attribute.filesTotal.rawValue,
      Attribute.spaceAvailable.rawValue, Attribute.spaceFree.rawValue, Attribute.spaceTotal.rawValue,
    ]
    let wantsOwner = !requested.isDisjoint(with: ownerAttributes)
    let nativeAttributes: Set<Int> = [
      Attribute.type.rawValue, Attribute.size.rawValue, Attribute.fsid.rawValue,
      Attribute.fileID.rawValue, Attribute.mode.rawValue, Attribute.links.rawValue,
      Attribute.owner.rawValue, Attribute.ownerGroup.rawValue, Attribute.rawDevice.rawValue,
      Attribute.spaceUsed.rawValue, Attribute.timeAccess.rawValue, Attribute.timeCreate.rawValue,
      Attribute.timeMetadata.rawValue, Attribute.timeModify.rawValue, Attribute.mountedOnFileID.rawValue,
    ]
    while let row = try nextDirectory(cursor, request: enumeration, capacity: batchCapacity) {
      let rowIndex = cursor.index - 1
      var consumed = true
      defer {
        if consumed {
          cursor.batch[rowIndex].consumed = true
          cursor.batch[rowIndex].info = nil
          cursor.batch[rowIndex].valid = []
          cursor.batch[rowIndex].error = nil
        }
      }
      let name = row.name
      if name == "." || name == ".." { continue }
      let entry = try await select(directory, name: name)
      if !entry.cursor.traversable { continue }
      let mode = entry.cursor.mode
      var encoded = XDRWriter()
      encoded.bool(true)
      encoded.uint64(row.cookie)
      encoded.string(name)
      do {
        if let error = row.error { throw error }
        var info: stat
        if let selected = row.info,
          !(selected.st_mode & S_IFMT == S_IFDIR && requested.contains(Attribute.change.rawValue) && !row.valid.contains(Attribute.size.rawValue)),
          requested.intersection(nativeAttributes).isSubset(of: row.valid),
          row.valid.isSuperset(of: [Attribute.type.rawValue, Attribute.fileID.rawValue, Attribute.fsid.rawValue]) {
          info = selected
        } else {
          info = stat()
          fallbackStats &+= 1
          if row.consumed { prefixRefreshStats &+= 1 }
          else if let bulkInfo = row.info, bulkInfo.st_mode & S_IFMT == S_IFDIR,
            !requested.isDisjoint(with: [Attribute.links.rawValue, Attribute.size.rawValue, Attribute.spaceUsed.rawValue, Attribute.change.rawValue]) {
            directoryFieldStats &+= 1
          } else { missingFieldStats &+= 1 }
          let result = anchor.withFD { fstatat($0, name, &info, AT_SYMLINK_NOFOLLOW) }
          if result != 0 { if errno == ENOENT { continue }; throw failure() }
          cursor.batch[rowIndex].info = info
          cursor.batch[rowIndex].valid = nativeAttributes
        }
        if mode == .deny && info.st_mode & S_IFMT != S_IFDIR { continue }
        let mayRead = mode.decision(.read) == .allow
          || (mode == .deny && info.st_mode & S_IFMT == S_IFDIR)
        let item: Record
        if wantsOwner || (requested.contains(Attribute.size.rawValue) && info.st_mode & S_IFMT == S_IFLNK) {
          item = try publishEntry(entry, owner: nil, info: info, strong: false)
        } else {
          item = Record(id: 0, path: entry.path, info: info, parent: directory, name: name)
          try refreshPolicyContext(item, parent: directory)
        }
        if !mayRead {
          try await approve(entry.path, cursor: entry.cursor, access: .read, traversal: true,
            selection: item, entry: entry, observation: info, allowPrompt: false)
        }
        let attributeBinding = item.bindingVersion
        let previousOwner = protectedOwner(item)
        var own = try await attributeOwner(item, requested: requested)
        if item.bindingVersion != attributeBinding || !observationMatches(item, info)
          || (own != nil && own !== previousOwner) {
          own = own ?? protectedOwner(item)
          if let own {
            pinIdentity(item, own)
            try own.withFD { try checked(fstat($0, &info)) }
            guard observationMatches(item, info) else { throw NFSStatus.stale }
          } else { info = try snapshot(item) }
          try await approve(item.path, cursor: try viewPolicy(item), access: .read, traversal: true,
            selection: item, entry: entry, observation: info, allowPrompt: false)
          cursor.batch[rowIndex].info = info
          cursor.batch[rowIndex].valid = nativeAttributes
        }
        var projectedSize: UInt64? = nil
        if requested.contains(Attribute.size.rawValue), info.st_mode & S_IFMT == S_IFLNK {
          let prepared = try await prepareLinkSize(item, info: info, owner: own, allowPrompt: false)
          own = prepared.owner; info = prepared.info; projectedSize = prepared.size
        }
        guard initialGeneration == generation else { throw NFSStatus.access }
        encoded.fixed(try withExtendedLifetime(own) {
          try attributes(item, requested: requested, info: info, pinnedFD: own?.value, projectedLinkSize: projectedSize)
        })
      } catch {
        guard initialGeneration == generation else { throw NFSStatus.access }
        if mode == .deny { continue }
        guard requested.contains(Attribute.readAttributeError.rawValue) else { throw error }
        encoded.bitmap([Attribute.readAttributeError.rawValue])
        var detail = XDRWriter(); detail.uint32(nfsStatus(error).rawValue); encoded.opaque(detail.data)
      }
      let nameCost = 16 + ((name.utf8.count + 3) & ~3)
      if output.data.count + encoded.data.count + 8 > limit
        || (count > 0 && namesSize + nameCost > Int(directoryCount)) {
        consumed = false
        unreadDirectory(cursor)
        if count == 0 { completed = true; throw NFSStatus.tooSmall }
        output.bool(false); output.bool(false)
        completed = true; return output.data
      }
      output.fixed(encoded.data)
      if cursor.bulk { cursor.emittedBulkCookies = true }
      count += 1
      namesSize += nameCost
      if wantsOwner && count >= min(256, max(1, ownerBudget / 2)) {
        output.bool(false); output.bool(false)
        completed = true; return output.data
      }
    }
    output.bool(false); output.bool(true)
    guard output.data.count <= limit else { throw NFSStatus.tooSmall }
    completed = true; return output.data
  }
  private func invalidateEntries(_ entry: EntrySelection) {
    let key = EntryKey(parent: entry.parent.id, name: Data(entry.name.utf8))
    entries.removeValue(forKey: key)
    paths.removeValue(forKey: entry.path)
    publishViewChange(entry.parent)
  }
  fileprivate func remove(_ directory: Record, name: String) async throws -> Data {
    let entry = try await select(directory, name: name)
    let ticket = try await authorizeEffect(.remove, source: entry,
      items: effectItems(entry, access: .write, recursive: true))
    var info = stat()
    try entry.directory.withFD { try checked(fstatat($0, name, &info, AT_SYMLINK_NOFOLLOW)) }
    let before = try change(directory)
    try ticket.consume(generation: generation)
    try entry.directory.withFD { try checked(unlinkat($0, name, info.st_mode & S_IFMT == S_IFDIR ? AT_REMOVEDIR : 0)) }
    invalidateEntries(entry)
    var output = XDRWriter()
    output.change(before: before, after: try change(directory))
    return output.data
  }
  fileprivate func rename(_ source: Record, destination: Record, oldName: String, newName: String) async throws -> Data {
    let from = try await select(source, name: oldName)
    let to = try await select(destination, name: newName)
    let ticket = try await authorizeEffect(.rename, source: from, destination: to,
      items: effectItems(from, access: .write, recursive: true) + effectItems(to, access: .write, recursive: true))
    let beforeSource = try change(source)
    let beforeDestination = source === destination ? beforeSource : try change(destination)
    try ticket.consume(generation: generation)
    try from.directory.withFD { sourceFD in
      try to.directory.withFD { try checked(renameat(sourceFD, oldName, $0, newName)) }
    }
    invalidateEntries(from)
    invalidateEntries(to)
    let afterSource = try change(source)
    let afterDestination = source === destination ? afterSource : try change(destination)
    var output = XDRWriter()
    output.change(before: beforeSource, after: afterSource)
    output.change(before: beforeDestination, after: afterDestination)
    return output.data
  }
  fileprivate func link(_ record: Record, directory: Record, name: String) async throws -> Data {
    throw NFSStatus.notSupported
  }
  fileprivate func create(_ directory: Record, name: String, kind: FileKind, target: String?,
    changes: AttributeChanges) async throws -> (Record, Data) {
    guard kind == .directory || kind == .symlink || kind == .fifo else { throw NFSStatus.notSupported }
    guard changes.size == nil else { throw NFSStatus.invalid }
    let entry = try await select(directory, name: name)
    let ticket = try await authorizeEffect(.create, destination: entry, items: effectItems(entry, access: .write))
    let before = try change(directory)
    let mode = mode_t(changes.mode ?? (kind == .directory ? 0o777 : 0o666))
    try ticket.consume(generation: generation)
    try entry.directory.withFD { fd in
      switch kind {
      case .directory: try checked(mkdirat(fd, name, mode))
      case .symlink:
        guard let target else { throw NFSStatus.badXDR }
        try checked(symlinkat(target, fd, name))
      case .fifo: try checked(mkfifoat(fd, name, mode))
      default: throw NFSStatus.notSupported
      }
    }
    invalidateEntries(entry)
    let record = try await capture(entry)
    guard try FileKind(record.observed.st_mode) == kind else { throw NFSStatus.stale }
    if !changes.bits.isEmpty {
      let pin = try await objectOwner(record, access: .write)
      try withExtendedLifetime(pin) {
        try apply(changes, to: record, pin: pin)
        var updated = stat()
        try pin.withFD { try checked(fstat($0, &updated)) }
        guard observationMatches(record, updated) else { throw NFSStatus.stale }
        record.observed = updated
      }
    }
    var output = XDRWriter()
    output.change(before: before, after: try change(directory))
    output.bitmap(changes.bits)
    return (record, output.data)
  }

}

extension NFSServer {
  fileprivate func renew(_ id: UInt64) throws {
    guard var client = clients[id], client.confirmed else { throw NFSStatus.staleClientID }
    guard monotonicTime() - client.renewed < UInt64(leaseSeconds) * 1_000_000_000 else {
      expireClient(id)
      throw NFSStatus.expired
    }
    client.renewed = monotonicTime()
    clients[id] = client
  }
  fileprivate func expireClient(_ id: UInt64) {
    let expiredKeys = states.values.filter { $0.owner.client == id }.map { $0.key }
    for key in expiredKeys { removeState(key) }
    owners = owners.filter { $0.key.client != id }
    clients.removeValue(forKey: id)
  }
  fileprivate func maintenance() {
    let now = monotonicTime()
    guard now - lastMaintenance >= 5_000_000_000 else { return }
    lastMaintenance = now
    if ProcessInfo.processInfo.environment["PIFS_LAZY_CENSUS"] == "1" {
      diagnostic("lazy-census contexts=\(records.count) cachedFDA=\(optionalCount) fd=\(descriptorCounter.count) dirHits=\(directoryHits) dirMisses=\(directoryMisses) acquisitionOpens=\(acquisitionOpens) bulkCalls=\(bulkCalls) fallbackStats=\(fallbackStats) prefixRefreshStats=\(prefixRefreshStats) directoryFieldStats=\(directoryFieldStats) missingFieldStats=\(missingFieldStats) continuationBytes=\(continuationBytes) listingVersions=\(directoryCursors.count + olderDirectoryCursors.count) listingBuilds=\(listingBuilds) listingRowsBuilt=\(listingRowsBuilt) listingBuildNanos=\(listingBuildNanos) activeListingBuilders=\(activeListingBuilders) peakListingBuilders=\(peakListingBuilders)")
    }
    let lease = UInt64(leaseSeconds) * 1_000_000_000
    for (id, client) in clients where now - client.renewed >= lease { expireClient(id) }
    for (key, owner) in owners where !retainedOwner(owner, now: now) {
      owners.removeValue(forKey: key)
    }
    for (key, replay) in replays where now - replay.time >= lease {
      removeReplay(key)
    }
    pruneConfigurations()
  }
  fileprivate func state(_ stateID: Data, record: Record, right: Access = []) throws -> OpenState {
    guard stateID.count == 16, stateID != Data(repeating: 0, count: 16),
      stateID != Data(repeating: 255, count: 16)
    else { throw NFSStatus.badStateID }
    var input = XDRReader(data: stateID)
    let sequence = try input.uint32()
    let key = try input.take(12)
    guard let state = states[key], state.recordIDs.contains(record.id),
      state.record.identity == record.identity
    else { throw NFSStatus.badStateID }
    try renew(state.owner.client)
    guard sequence == state.sequence else {
      throw sequence < state.sequence ? NFSStatus.oldStateID : NFSStatus.badStateID
    }
    guard state.rights.isSuperset(of: right) else { throw NFSStatus.openMode }
    return state
  }
  fileprivate func beginSequence(_ owner: OpenOwner, sequence: UInt32, signature: Data)
    async throws -> OperationResult?
  {
    try renew(owner.key.client)
    owner.touched = monotonicTime()
    if owner.pending {
      guard owner.pendingSequence == sequence, owner.pendingSignature == signature else {
        throw NFSStatus.badSequenceID
      }
      return await withCheckedContinuation { owner.pendingWaiters.append($0) }
    }
    if let previous = owner.sequence {
      if sequence == previous {
        guard signature == owner.signature, let result = owner.result else {
          throw NFSStatus.badSequenceID
        }
        return result
      }
      guard sequence == previous &+ 1 else { throw NFSStatus.badSequenceID }
    }
    owner.pending = true
    owner.pendingSequence = sequence
    owner.pendingSignature = signature
    return nil
  }
  fileprivate func finishSequence(
    _ owner: OpenOwner, sequence: UInt32, signature: Data,
    result: OperationResult, closedHandle: UInt64? = nil
  ) -> OperationResult {
    owner.pending = false
    owner.pendingSequence = nil
    owner.pendingSignature = Data()
    let waiters = owner.pendingWaiters
    owner.pendingWaiters.removeAll()
    let replay = OperationResult(status: result.status, body: result.body, current: result.current)
    defer { for waiter in waiters { waiter.resume(returning: replay) } }
    let nonConsuming: Set<NFSStatus> = [
      .staleClientID, .staleStateID, .badStateID,
      .badSequenceID, .badXDR, .resource, .noFileHandle,
    ]
    if !nonConsuming.contains(result.status) {
      owner.sequence = sequence
      owner.signature = signature
      owner.result = replay
      owner.closedHandle = closedHandle
    }
    return result
  }
  fileprivate func open(_ request: OpenRequest, directory: Record, signature: Data)
    async throws -> OperationResult
  {
    try renew(request.owner.client)
    let owner = owners[request.owner] ?? OpenOwner(request.owner)
    owners[request.owner] = owner
    if let replay = try await beginSequence(owner, sequence: request.sequence, signature: signature)
    {
      return replay
    }
    let result: OperationResult
    do {
      if let error = request.semanticError { throw error }
      let (record, body) = try await performOpen(request, directory: directory, owner: owner)
      result = OperationResult(status: .ok, body: body, current: record.id, selected: record.observed)
    } catch {
      result = OperationResult(status: nfsStatus(error), body: Data(), current: nil)
    }
    return finishSequence(owner, sequence: request.sequence, signature: signature, result: result)
  }
  fileprivate func performOpen(_ request: OpenRequest, directory: Record, owner: OpenOwner)
    async throws -> (Record, Data) {
    try check()
    guard (1...3).contains(request.rights), request.deny <= 3 else { throw NFSStatus.invalid }
    guard request.claim == 0, let name = request.name else { throw NFSStatus.noGrace }
    let access = Access(rawValue: UInt8(request.rights))
    let deny = Access(rawValue: UInt8(request.deny))
    let entry = try await select(directory, name: name)
    var nativeAccess = access
    if request.attributes?.size != nil { nativeAccess.insert(.write) }
    let required = request.createMode == nil ? nativeAccess : nativeAccess.union(.write)
    let items = effectItems(entry, access: required)
    let creation: EffectTicket?
    if request.createMode != nil {
      creation = try await authorizeEffect(.create, destination: entry, items: items)
    } else { creation = nil }
    let ticket = try await authorizeEffect(EffectOperation(access: nativeAccess), purpose: .content,
      source: entry, items: items)
    try renew(owner.key.client)
    guard owners[owner.key] === owner else { throw NFSStatus.staleClientID }
    try makeRoom()
    let before = try change(directory)
    let flags: Int32 = nativeAccess == .read ? O_RDONLY : nativeAccess == .write ? O_WRONLY : O_RDWR
    let safeFlags = flags | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW
    var created = false
    let acquired: Descriptor
    try creation?.consume(generation: generation)
    try ticket.consume(generation: generation)
    if let mode = request.createMode {
      do {
        acquisitionOpens &+= 1
        acquired = try entry.directory.withFD {
          Descriptor(try checked(openat($0, name, safeFlags | O_CREAT | O_EXCL, mode_t(request.attributes?.mode ?? 0o666))))
        }
        created = true
      } catch {
        guard (error as NSError).code == Int(EEXIST) else { throw error }
        if mode == 1 { throw NFSStatus.exists }
        acquisitionOpens &+= 1
        acquired = try entry.directory.withFD { Descriptor(try checked(openat($0, name, safeFlags))) }
      }
    } else {
      acquisitionOpens &+= 1
      acquired = try entry.directory.withFD { Descriptor(try checked(openat($0, name, safeFlags))) }
    }
    if created { invalidateEntries(entry) }
    var info = stat()
    try acquired.withFD { try checked(fstat($0, &info)) }
    guard info.st_mode & S_IFMT == S_IFREG else {
      throw info.st_mode & S_IFMT == S_IFDIR ? NFSStatus.isDirectory : NFSStatus.symlink
    }
    if request.createMode == 2 && !created {
      let key = EntryKey(parent: directory.id, name: Data(name.utf8))
      guard let id = entries[key], let existing = records[id], existing.strongIdentity,
        existing.exclusiveVerifier == request.verifier, existing.identity == BackingIdentity(info),
        let old = existing.object ?? dataDescriptor(existing) else { throw NFSStatus.exists }
      try validate(old, record: existing)
    }
    let record = try publishEntry(entry, owner: acquired, info: info, strong: true)
    if created { record.exclusiveVerifier = request.verifier }
    let same = indexedState(owner: owner.key, identity: record.identity)
    if let candidate = same, !candidate.recordIDs.contains(record.id) {
      guard let previous = candidate.reader ?? candidate.writer else { throw NFSStatus.handleExpired }
      var observed = stat()
      try previous.withFD { try checked(fstat($0, &observed)) }
      guard BackingIdentity(observed) == record.identity else { throw NFSStatus.handleExpired }
    }
    for other in stateCandidates(identity: record.identity) where other !== same {
      if !other.deny.intersection(access).isEmpty || !deny.intersection(other.rights).isEmpty {
        throw NFSStatus.shareDenied
      }
    }
    let state = same ?? OpenState(key: randomBytes(12), owner: owner.key, record: record)
    let changes = created ? request.attributes : request.attributes.map { AttributeChanges(size: $0.size) }
    if let changes, !changes.bits.isEmpty {
      try apply(changes, to: record, writer: nativeAccess.contains(.write) ? acquired : nil, pin: acquired)
      info = try acquired.withFD { fd in var updated = stat(); try checked(fstat(fd, &updated)); return updated }
    }
    record.observed = info
    record.object = nil
    if same != nil { state.sequence &+= 1 }
    state.rights.formUnion(access)
    state.deny.formUnion(deny)
    state.recordIDs.insert(record.id)
    if access.contains(.read) { state.reader = acquired }
    if access.contains(.write) { state.writer = acquired }
    publishState(state, recordID: record.id)
    var output = XDRWriter()
    output.fixed(state.stateID)
    output.change(before: before, after: created ? try change(directory) : before)
    output.uint32(owner.confirmed ? 0 : 2)
    output.bitmap(changes?.bits ?? [])
    output.uint32(0)
    return (record, output.data)
  }
  fileprivate func stateOperation(
    _ operation: Operation, stateID: Data, sequence: UInt32,
    rights: UInt32?, deny: UInt32?, record: Record, signature: Data
  ) async throws -> OperationResult {
    guard stateID.count == 16 else { throw NFSStatus.badStateID }
    let key = Data(stateID.suffix(12))
    let owner: OpenOwner
    if let state = states[key], let value = owners[state.owner] {
      owner = value
    } else {
      guard operation == .close else { throw NFSStatus.badStateID }
      return try await replayClose(ReplayHandle(id: record.id), stateID: stateID,
        sequence: sequence, signature: signature)
    }
    if let replay = try await beginSequence(owner, sequence: sequence, signature: signature) {
      return replay
    }
    let result: OperationResult
    do {
      let state = try self.state(stateID, record: record)
      if operation == .close || operation == .openDowngrade {
        state.closing = true
        await drainIO(for: key)
      }
      defer { state.closing = false }
      guard states[key] === state else { throw NFSStatus.badStateID }
      switch operation {
      case .openConfirm:
        guard !owner.confirmed else { throw NFSStatus.badStateID }
        owner.confirmed = true
      case .openDowngrade:
        guard owner.confirmed, let rights, let deny, (1...3).contains(rights), deny <= 3 else {
          throw NFSStatus.invalid
        }
        let access = Access(rawValue: UInt8(rights))
        let denied = Access(rawValue: UInt8(deny))
        guard state.rights.isSuperset(of: access), state.deny.isSuperset(of: denied) else {
          throw NFSStatus.invalid
        }
        state.rights = access
        state.deny = denied
        if !access.contains(.read) { state.reader = nil }
        if !access.contains(.write) { state.writer = nil }
        state.drainRights.formIntersection(access)
      case .close:
        if let writer = state.writer { try await synchronize(writer) }
      default: throw NFSStatus.illegalOperation
      }
      guard states[key] === state else { throw NFSStatus.badStateID }
      state.sequence &+= 1
      result = OperationResult(status: .ok, body: state.stateID, current: record.id)
      if operation == .close {
        removeState(key)
        owner.closedKey = key
      }
    } catch { result = OperationResult(status: nfsStatus(error), body: Data(), current: nil) }
    return finishSequence(owner, sequence: sequence, signature: signature, result: result,
      closedHandle: operation == .close && result.status == .ok ? record.id : nil)
  }
  fileprivate func acquiredAuthority(_ state: OpenState, right: Access) -> Bool {
    state.rights.contains(right) && (right == .write ? state.writer : state.reader) != nil
  }
  fileprivate func dataState(_ stateID: Data, record: Record, right: Access) async throws
    -> OpenState
  {
    guard !stopped, serving || quiescing else { throw NFSStatus.access }
    let state = try self.state(stateID, record: record, right: right)
    guard owners[state.owner]?.confirmed == true, !state.closing else { throw NFSStatus.badStateID }
    guard acquiredAuthority(state, right: right) else { throw NFSStatus.access }
    if quiescing && !state.drainRights.isSuperset(of: right) { throw NFSStatus.access }
    return state
  }
  fileprivate func synchronize(_ descriptor: Descriptor) async throws {
    try await backingIO { try descriptor.withFD { _ = try checked(fsync($0)) } }
  }
  fileprivate func beginIO(_ stateID: Data, record: Record, right: Access) async throws
    -> DataAccess
  {
    let state = try await dataState(stateID, record: record, right: right)
    guard let descriptor = right == .write ? state.writer : state.reader else {
      throw NFSStatus.openMode
    }
    let access = DataAccess(
      token: UUID(), stateKey: state.key, itemID: record.id,
      admittedIdentity: state.record.identity, descriptor: descriptor)
    pinIdentity(record, descriptor)
    activeIO[access.token] = access
    return access
  }
  fileprivate func validateRead(_ access: DataAccess) throws {
    guard activeIO[access.token] != nil, let state = states[access.stateKey],
      state.recordIDs.contains(access.itemID)
    else { throw NFSStatus.badStateID }
    guard !stopped, serving || quiescing else { throw NFSStatus.access }
    try renew(state.owner.client)
    guard access.admittedIdentity == state.record.identity,
      acquiredAuthority(state, right: .read)
    else { throw NFSStatus.access }
    if quiescing && !state.drainRights.contains(.read) { throw NFSStatus.access }
  }
  fileprivate func finishIO(_ access: DataAccess) {
    guard activeIO.removeValue(forKey: access.token) != nil else { return }
    let ready = ioWaiters.filter { key, _ in !activeIO.values.contains { $0.stateKey == key } }
    ioWaiters.removeAll { key, _ in !activeIO.values.contains { $0.stateKey == key } }
    for (_, waiter) in ready { waiter.resume() }
  }
  fileprivate func drainIO(for key: Data) async {
    if activeIO.values.contains(where: { $0.stateKey == key }) {
      await withCheckedContinuation { ioWaiters.append((key, $0)) }
    }
  }
  fileprivate func pinMetadata(_ record: Record) throws -> MetadataPin? {
    guard !stopped, serving || quiescing else { return nil }
    guard let state = stateCandidates(recordID: record.id).first(where: {
      $0.recordIDs.contains(record.id) && !$0.closing && owners[$0.owner]?.confirmed == true
        && (acquiredAuthority($0, right: .read) || acquiredAuthority($0, right: .write))
    }), let descriptor = state.reader ?? state.writer else { return nil }
    try renew(state.owner.client)
    guard state.record.identity == record.identity else { throw NFSStatus.stale }
    pinIdentity(record, descriptor)
    return MetadataPin(stateKey: state.key, identity: record.identity, descriptor: descriptor)
  }
  fileprivate func pinOpenedMetadata(_ record: Record, stateID: Data) throws -> MetadataPin {
    guard !stopped, serving || quiescing else { throw NFSStatus.access }
    guard stateID.count == 16, let state = states[Data(stateID.suffix(12))],
      state.recordIDs.contains(record.id), !state.closing,
      let descriptor = state.reader ?? state.writer
    else { throw NFSStatus.badStateID }
    try renew(state.owner.client)
    guard state.record.identity == record.identity else { throw NFSStatus.stale }
    pinIdentity(record, descriptor)
    return MetadataPin(stateKey: state.key, identity: record.identity, descriptor: descriptor)
  }
  fileprivate func metadataPinLive(_ record: Record, pin: MetadataPin) -> Bool {
    guard !stopped, let state = states[pin.stateKey], state.recordIDs.contains(record.id),
      pin.identity == record.identity, state.record.identity == pin.identity,
      (try? renew(state.owner.client)) != nil
    else { return false }
    return acquiredAuthority(state, right: .read) || acquiredAuthority(state, right: .write)
  }
  fileprivate func pinnedAttributes(
    _ record: Record, requested: Set<Int>, pin: MetadataPin
  ) throws -> Data {
    guard !stopped, serving || quiescing else { throw NFSStatus.access }
    return try pin.descriptor.withFD { fd in
      let info: stat
      if let selected = pin.selected {
        info = selected
      } else {
        var current = stat()
        try checked(fstat(fd, &current))
        info = current
      }
      guard pin.identity == record.identity, BackingIdentity(info) == record.identity else {
        throw NFSStatus.stale
      }
      pin.selected = info
      let filesystemAttributes: Set<Int> = [
        Attribute.filesAvailable.rawValue, Attribute.filesFree.rawValue,
        Attribute.filesTotal.rawValue, Attribute.spaceAvailable.rawValue,
        Attribute.spaceFree.rawValue, Attribute.spaceTotal.rawValue,
      ]
      var filesystem: statfs? = nil
      if !requested.isDisjoint(with: filesystemAttributes) {
        var current = statfs()
        try checked(fstatfs(fd, &current))
        filesystem = current
      }
      return try attributes(
        record, requested: requested, info: info, filesystem: filesystem,
        pinnedFD: fd)
    }
  }
  @discardableResult
  fileprivate func authorizeMetadata(_ record: Record, captureStat: Bool = false) async throws -> stat? {
    guard !stopped, serving || quiescing else { throw NFSStatus.access }
    if try pinMetadata(record) != nil { return nil }
    if record.id == 2 { return captureStat ? try snapshot(record) : nil }
    guard !quiescing else { throw NFSStatus.access }
    return try await authorize(record, .read, traversal: true)
  }
  fileprivate func quiesce() {
    guard !stopped else { return }
    for state in states.values {
      state.drainRights = []
      for right in [Access.read, .write] where acquiredAuthority(state, right: right) {
        state.drainRights.insert(right)
      }
    }
    quiescing = true
    serving = false
    for ask in asks.values { ask.resume(returning: false) }
    asks.removeAll()
  }
}

private func validateCompoundArguments(_ source: XDRReader, count: UInt32) throws {
  var input = source
  func attributes(_ input: inout XDRReader) throws {
    _ = try input.bitmap()
    _ = try input.opaque()
  }
  for _ in 0..<count {
    guard let operation = Operation(rawValue: try input.uint32()) else { return }
    switch operation {
    case .access: _ = try input.take(4)
    case .close, .openConfirm: _ = try input.take(20)
    case .openDowngrade: _ = try input.take(28)
    case .commit: _ = try input.take(12)
    case .create:
      guard let kind = FileKind(rawValue: try input.uint32()) else { return }
      if kind == .symlink {
        _ = try input.opaque()
      } else if kind == .character || kind == .block {
        _ = try input.take(8)
      }
      _ = try input.opaque()
      try attributes(&input)
    case .getattr: _ = try input.bitmap()
    case .link, .lookup, .putfh, .remove, .secinfo: _ = try input.opaque()
    case .open:
      _ = try input.take(20)
      _ = try input.opaque()
      let how = try input.uint32()
      if how == 1 {
        let mode = try input.uint32()
        if mode < 2 {
          try attributes(&input)
        } else if mode == 2 {
          _ = try input.take(8)
        } else {
          return
        }
      } else if how != 0 {
        return
      }
      switch try input.uint32() {
      case 0, 3: _ = try input.opaque()
      case 1: _ = try input.take(4)
      case 2:
        _ = try input.take(16)
        _ = try input.opaque()
      default: return
      }
    case .read: _ = try input.take(28)
    case .readdir:
      _ = try input.take(24)
      _ = try input.bitmap()
    case .rename:
      _ = try input.opaque()
      _ = try input.opaque()
    case .renew: _ = try input.take(8)
    case .setattr:
      _ = try input.take(16)
      try attributes(&input)
    case .setclientid:
      _ = try input.take(8)
      _ = try input.opaque()
      _ = try input.take(4)
      _ = try input.opaque()
      _ = try input.opaque()
      _ = try input.take(4)
    case .setclientidConfirm: _ = try input.take(16)
    case .write:
      _ = try input.take(28)
      _ = try input.opaque()
    case .releaseLockowner:
      _ = try input.take(8)
      _ = try input.opaque()
    case .getfh, .lookupp, .putpubfh, .putrootfh, .readlink, .restorefh, .savefh: break
    }
  }
  guard input.remaining == 0 else { throw NFSStatus.badXDR }
}

extension NFSServer {
  fileprivate func compound(_ data: Data, credentials: Credentials) async throws -> CompoundReply {
    let task = UUID()
    compoundPins[task] = []
    defer { releasePins(task) }
    return try await CompoundTask.$identifier.withValue(task) {
      try await performCompound(data, credentials: credentials)
    }
  }
  private func performCompound(_ data: Data, credentials: Credentials) async throws -> CompoundReply {
    var input = XDRReader(data: data)
    let tag = try input.opaque(limit: 1024)
    let minor = try input.uint32()
    let count = try input.uint32()
    guard count <= 64 else { throw NFSStatus.badXDR }
    if minor != 0 {
      var output = XDRWriter()
      output.uint32(NFSStatus.minorVersionMismatch.rawValue)
      output.opaque(tag)
      output.uint32(0)
      return CompoundReply(data: output.data, teardownOnly: false, replayStates: nil)
    }
    try validateCompoundArguments(input, count: count)
    var current: HandleContext?
    var currentRecord: Record? { current?.record }
    var metadataPins: [UInt64: MetadataPin] = [:]
    var selections: [UInt64: MetadataSelection] = [:]
    var metadataPinErrors: [UInt64: NFSStatus] = [:]
    var closedStates: Set<Data> = []
    var saved: HandleContext?
    var savedRecord: Record? { saved?.record }
    var results = XDRWriter()
    var status: NFSStatus = .ok
    var completed: UInt32 = 0
    var teardownOnly = true
    var replayStates: Set<Data>? = []
    for _ in 0..<count {
      if let task = CompoundTask.identifier { actionApprovals[task] = [] }
      let rawOperation = try input.uint32()
      let teardown: Set<UInt32> = [
        Operation.putfh.rawValue, Operation.putrootfh.rawValue,
        Operation.putpubfh.rawValue, Operation.savefh.rawValue, Operation.restorefh.rawValue,
        Operation.close.rawValue, Operation.commit.rawValue, Operation.renew.rawValue,
      ]
      teardownOnly = teardownOnly && teardown.contains(rawOperation)
      let retainedOperations = teardown.union([
        Operation.read.rawValue, Operation.write.rawValue,
        Operation.getattr.rawValue, Operation.setattr.rawValue,
      ])
      if !retainedOperations.contains(rawOperation) { replayStates = nil }
      let start = input.position
      var body = XDRWriter()
      var replyOperation = rawOperation
      do {
        guard results.data.count <= maximumFrame - maximumIO - 1024 else {
          throw NFSStatus.resource
        }
        guard let operation = Operation(rawValue: rawOperation) else {
          if rawOperation < 3 || rawOperation > 39 {
            replyOperation = 10044
            throw NFSStatus.illegalOperation
          }
          throw NFSStatus.notSupported
        }
        let noHandle: Set<Operation> = [
          .putfh, .putpubfh, .putrootfh, .restorefh,
          .setclientid, .setclientidConfirm, .renew, .releaseLockowner,
        ]
        if !noHandle.contains(operation), current == nil { throw NFSStatus.noFileHandle }
        let replayContextOperations = noHandle.union([Operation.savefh, .close])
        if current?.replayOnly == true && !replayContextOperations.contains(operation) {
          throw NFSStatus.stale
        }
        if (operation == .link || operation == .rename) && saved?.replayOnly == true {
          throw NFSStatus.stale
        }
        switch operation {
        case .read, .write, .setattr, .open, .create, .remove, .rename, .link, .close, .commit:
          for pin in metadataPins.values { pin.selected = nil }
          selections.removeAll()
        default: break
        }
        switch operation {
        case .putrootfh, .putpubfh: current = .object(try record(2))
        case .putfh:
          current = try fileContext(handle: input.opaque(limit: 128))
          if let record = currentRecord, metadataPins[record.id] == nil {
            metadataPins[record.id] = try? pinMetadata(record)
          }
        case .getfh:
          try check()
          body.opaque(fileHandle(currentRecord!))
        case .savefh: saved = current
        case .restorefh:
          guard let saved else { throw NFSStatus.restoreHandle }
          current = saved
        case .getattr:
          let requested = try input.bitmap()
          if let error = metadataPinErrors[currentRecord!.id] { throw error }
          let pin = metadataPins[currentRecord!.id]
          var usablePin = false
          if let pin {
            usablePin = closedStates.contains(pin.stateKey)
            if !usablePin { usablePin = metadataPinLive(currentRecord!, pin: pin) }
          }
          if let pin, usablePin {
            body.fixed(try pinnedAttributes(currentRecord!, requested: requested, pin: pin))
            replayStates?.insert(pin.stateKey)
          } else {
            metadataPins.removeValue(forKey: currentRecord!.id)
            replayStates = nil
            let item = currentRecord!
            let selected: MetadataSelection
            if let observation = selections[item.id], observation.generation == generation {
              if item.id != 2 {
                _ = try await authorize(item, .read, traversal: true, captureStat: false, selected: observation.info)
              }
              selected = observation
            } else {
              let owner = protectedOwner(item)
              if let owner { pinIdentity(item, owner) }
              let info = try await authorizeMetadata(item, captureStat: true) ?? snapshot(item)
              selected = MetadataSelection(owner: owner, info: info, generation: generation)
              selections[item.id] = selected
            }
            let attributeGeneration = generation
            let attributeBinding = item.bindingVersion
            let previousOwner = protectedOwner(item)
            var info = selected.info
            var own = try await attributeOwner(item, requested: requested)
            if item.bindingVersion != attributeBinding || !observationMatches(item, info)
              || (own != nil && own !== previousOwner) {
              own = own ?? protectedOwner(item)
              if let own {
                pinIdentity(item, own)
                try own.withFD { try checked(fstat($0, &info)) }
                guard observationMatches(item, info) else { throw NFSStatus.stale }
              } else { info = try snapshot(item) }
              _ = try await authorize(item, .read, traversal: true, captureStat: false, selected: info)
              selections[item.id] = MetadataSelection(owner: own, info: info, generation: generation)
            }
            var projectedSize: UInt64? = nil
            if requested.contains(Attribute.size.rawValue), info.st_mode & S_IFMT == S_IFLNK {
              let prepared = try await prepareLinkSize(item, info: info, owner: own, allowPrompt: true)
              own = prepared.owner; info = prepared.info; projectedSize = prepared.size
              selections[item.id] = MetadataSelection(owner: own, info: info, generation: generation)
            }
            guard generation == attributeGeneration else { throw NFSStatus.access }
            body.fixed(try withExtendedLifetime(own) {
              try attributes(item, requested: requested, info: info, pinnedFD: own?.value, projectedLinkSize: projectedSize)
            })
          }
        case .lookup:
          let item = try await lookup(currentRecord!, name: input.name())
          current = .object(item)
          selections[item.id] = MetadataSelection(owner: item.object, info: item.observed, generation: generation)
          metadataPins[item.id]?.selected = item.observed
        case .lookupp:
          current = .object(try await lookupParent(currentRecord!))
        case .access:
          let requested = try input.uint32()
          try check()
          let item = currentRecord!
          if let parent = item.parent { _ = try await directoryOwner(parent) }
          let owner = protectedOwner(item)
          if let owner { pinIdentity(item, owner) }
          let info: stat
          if let selected = selections[item.id], selected.generation == generation { info = selected.info }
          else {
            info = try snapshot(item)
            selections[item.id] = MetadataSelection(owner: owner, info: info, generation: generation)
          }
          let directory = info.st_mode & S_IFMT == S_IFDIR
          let mode = info.st_mode & 0o777
          var effective: mode_t
          if credentials.uid == info.st_uid { effective = (mode >> 6) & 7 }
          else if credentials.groups.contains(info.st_gid) { effective = (mode >> 3) & 7 }
          else { effective = mode & 7 }
          if credentials.uid == 0 { effective = 6 | (directory || mode & 0o111 != 0 ? 1 : 0) }
          var list = attrlist(); list.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
          list.commonattr = attrgroup_t(ATTR_CMN_USERACCESS)
          var native = [UInt32](repeating: 0, count: 2)
          if let owner {
            try owner.withFD { try checked(fgetattrlist($0, &list, &native, 8, 0)) }
          } else if let parentRecord = item.parent, let parent = protectedOwner(parentRecord) {
            try parent.withFD { try checked(getattrlistat($0, item.name, &list, &native, 8, UInt(FSOPT_NOFOLLOW))) }
          } else { throw NFSStatus.delay }
          guard native[0] >= 8 else { throw NFSStatus.notSupported }
          let rights = mode_t(native[1] & 7)
          effective = credentials.uid == geteuid() ? rights : effective & rights
          var allowed: UInt32 = 0
          if effective & 4 != 0 { allowed |= 1 }
          if effective & 2 != 0 { allowed |= 0x0c }
          if effective & 1 != 0 { allowed |= directory ? 0x02 : 0x20 }
          let cursor = try viewPolicy(item)
          if cursor.mode.decision(.read) == .deny
            && !(directory && cursor.mode == .deny && cursor.traversable) {
            allowed &= ~0x21
            if !directory || !cursor.traversable { allowed &= ~0x02 }
          }
          if cursor.mode.decision(.write) == .deny { allowed &= ~0x0c }
          body.uint32(requested & 0x2f)
          body.uint32(requested & allowed)
        case .setclientid:
          try check()
          let verifier = try input.take(8)
          let name = try input.opaque(limit: 1024)
          _ = try input.uint32()
          _ = try input.string()
          _ = try input.string()
          _ = try input.uint32()
          if let existing = clients.first(where: {
            $0.value.owner == name && $0.value.verifier == verifier
          }) {
            body.uint64(existing.key)
            body.fixed(existing.value.confirmation)
          } else {
            guard nextClient != UInt64.max else { throw NFSStatus.resource }
            let id = nextClient
            nextClient += 1
            let confirmation = randomBytes(8)
            clients[id] = Client(owner: name, verifier: verifier, confirmation: confirmation)
            body.uint64(id)
            body.fixed(confirmation)
          }
        case .setclientidConfirm:
          try check()
          let id = try input.uint64()
          let confirmation = try input.take(8)
          guard var client = clients[id], client.confirmation == confirmation else {
            throw NFSStatus.staleClientID
          }
          for (otherID, other) in clients where otherID != id && other.owner == client.owner {
            expireClient(otherID)
          }
          client.confirmed = true
          client.renewed = monotonicTime()
          clients[id] = client
        case .renew: try renew(input.uint64())
        case .open:
          let request = try OpenRequest(&input)
          let signature = operationSignature(
            operation, record: currentRecord!,
            data: input.data.subdata(in: start..<input.position))
          let result = try await open(request, directory: currentRecord!, signature: signature)
          status = result.status
          body.fixed(result.body)
          if let id = result.current {
            current = .object(try record(id))
            if result.status == .ok {
              do {
                let pin = try pinOpenedMetadata(currentRecord!, stateID: Data(result.body.prefix(16)))
                pin.selected = result.selected
                metadataPins[id] = pin
                metadataPinErrors.removeValue(forKey: id)
              } catch { metadataPinErrors[id] = nfsStatus(error) }
            }
          }
        case .close, .openConfirm, .openDowngrade:
          let sequence: UInt32
          let stateID: Data
          if operation == .close {
            sequence = try input.uint32()
            stateID = try input.take(16)
          } else {
            stateID = try input.take(16)
            sequence = try input.uint32()
          }
          let rights = operation == .openDowngrade ? try input.uint32() : nil
          let deny = operation == .openDowngrade ? try input.uint32() : nil
          let signature = operationSignature(
            operation, handleID: current!.id,
            data: input.data.subdata(in: start..<input.position))
          let result: OperationResult
          if case .replay(let handle) = current! {
            guard operation == .close else { throw NFSStatus.stale }
            result = try await replayClose(handle, stateID: stateID, sequence: sequence, signature: signature)
          } else {
            result = try await stateOperation(
              operation, stateID: stateID, sequence: sequence,
              rights: rights, deny: deny, record: currentRecord!, signature: signature)
          }
          if operation == .close && result.status == .ok {
            closedStates.insert(Data(stateID.suffix(12)))
          }
          status = result.status
          body.fixed(result.body)
        case .read:
          let stateID = try input.take(16)
          let offset = try input.uint64()
          let amount = try input.uint32()
          guard amount <= maximumIO, offset <= UInt64(Int64.max),
            UInt64(amount) <= UInt64(Int64.max) - offset
          else { throw NFSStatus.invalid }
          let access = try await beginIO(stateID, record: currentRecord!, right: .read)
          replayStates?.insert(access.stateKey)
          defer { finishIO(access) }
          let (data, size) = try await backingIO {
            try access.descriptor.withFD { fd in
              var data = Data(count: Int(amount))
              let count = try data.withUnsafeMutableBytes {
                try checked(pread(fd, $0.baseAddress, $0.count, off_t(offset)))
              }
              data.count = count
              var info = stat()
              try checked(fstat(fd, &info))
              return (data, UInt64(max(0, info.st_size)))
            }
          }
          try validateRead(access)
          body.bool(offset + UInt64(data.count) >= size)
          body.opaque(data)
        case .write:
          let stateID = try input.take(16)
          let offset = try input.uint64()
          let stable = try input.uint32()
          let data = try input.opaque(limit: maximumIO)
          guard stable <= 2, offset <= UInt64(Int64.max),
            UInt64(data.count) <= UInt64(Int64.max) - offset
          else { throw NFSStatus.invalid }
          let access = try await beginIO(stateID, record: currentRecord!, right: .write)
          replayStates?.insert(access.stateKey)
          defer { finishIO(access) }
          let count = try await backingIO {
            try access.descriptor.withFD { fd in
              let count = try data.withUnsafeBytes {
                try checked(pwrite(fd, $0.baseAddress, $0.count, off_t(offset)))
              }
              try checked(fsync(fd))
              return count
            }
          }
          body.uint32(UInt32(count))
          body.uint32(2)
          body.fixed(epoch)
        case .commit:
          _ = try input.uint64()
          _ = try input.uint32()
          let pending = states.values.filter { $0.record.identity == currentRecord!.identity }
          for state in pending {
            await drainIO(for: state.key)
            if let writer = state.writer { try await synchronize(writer) }
          }
          body.fixed(epoch)
        case .readdir:
          let cookie = try input.uint64()
          let verifier = try input.uint64()
          let directoryCount = try input.uint32()
          let maximumCount = try input.uint32()
          let requested = try input.bitmap()
          body.fixed(
            try await readDirectory(
              currentRecord!, cookie: cookie, verifier: verifier,
              directoryCount: directoryCount, maximumCount: maximumCount, requested: requested))
        case .readlink:
          body.string(try await projectedLinkTarget(id: currentRecord!.id))
        case .setattr:
          let stateID = try input.take(16)
          let changes = try AttributeChanges(&input)
          let writer: Descriptor?
          if changes.size != nil {
            let state = try await dataState(stateID, record: currentRecord!, right: .write)
            writer = state.writer
            replayStates?.insert(state.key)
          } else {
            writer = nil
          }
          var effectPin = writer
          if changes.bits != [Attribute.size.rawValue] {
            replayStates = nil
            let metadataEpoch = generation
            if writer != nil { _ = try await authorize(currentRecord!, .write, captureStat: false) }
            else { effectPin = try await objectOwner(currentRecord!, access: .write) }
            if changes.size != nil { _ = try await dataState(stateID, record: currentRecord!, right: .write) }
            guard metadataEpoch == generation else { throw NFSStatus.access }
          }
          guard let effectPin else { throw NFSStatus.openMode }
          try apply(changes, to: currentRecord!, writer: writer, pin: effectPin)
          body.bitmap(changes.bits)
        case .remove: body.fixed(try await remove(currentRecord!, name: input.name()))
        case .rename:
          let oldName = try input.name()
          let newName = try input.name()
          guard let saved = savedRecord else { throw NFSStatus.noFileHandle }
          body.fixed(
            try await rename(saved, destination: currentRecord!, oldName: oldName, newName: newName))
        case .link:
          let name = try input.name()
          guard let saved = savedRecord else { throw NFSStatus.noFileHandle }
          body.fixed(try await link(saved, directory: currentRecord!, name: name))
        case .create:
          guard let kind = FileKind(rawValue: try input.uint32()) else { throw NFSStatus.invalid }
          let target: String?
          if kind == .symlink {
            target = try input.string()
          } else {
            target = nil
            if kind == .block || kind == .character {
              _ = try input.uint32()
              _ = try input.uint32()
            }
          }
          let name = try input.name()
          let changes = try AttributeChanges(&input)
          let (record, response) = try await create(
            currentRecord!, name: name, kind: kind,
            target: target, changes: changes)
          current = .object(record)
          selections[record.id] = MetadataSelection(owner: record.object, info: record.observed, generation: generation)
          body.fixed(response)
        case .secinfo:
          let name = try input.name()
          _ = try await lookup(currentRecord!, name: name)
          body.uint32(1)
          body.uint32(1)
        case .releaseLockowner:
          let client = try input.uint64()
          _ = try input.opaque(limit: 1024)
          try renew(client)
        }
      } catch {
        status = nfsStatus(error)
        body = XDRWriter()
        if rawOperation == Operation.setattr.rawValue { body.bitmap([]) }
        if status == .serverFault { diagnostic("NFS operation \(rawOperation): \(error)") }
      }
      results.uint32(replyOperation)
      results.uint32(status.rawValue)
      results.fixed(body.data)
      completed += 1
      if status != .ok { break }

    }
    var output = XDRWriter()
    output.uint32(status.rawValue)
    output.opaque(tag)
    output.uint32(completed)
    output.fixed(results.data)
    return CompoundReply(
      data: output.data, teardownOnly: teardownOnly, replayStates: replayStates)
  }
  fileprivate func operationSignature(_ operation: Operation, record: Record, data: Data) -> Data {
    operationSignature(operation, handleID: record.id, data: data)
  }
  private func operationSignature(_ operation: Operation, handleID: UInt64, data: Data) -> Data {
    var output = XDRWriter()
    output.uint32(operation.rawValue)
    output.uint64(handleID)
    output.fixed(data)
    return output.data
  }
  func rpc(_ request: Data, connection: UUID) async -> Data {
    maintenance()
    var input = XDRReader(data: request)
    var xid: UInt32 = 0
    var header = XDRWriter()
    do {
      xid = try input.uint32()
      guard try input.uint32() == 0 else { throw NFSStatus.badXDR }
      guard try input.uint32() == 2 else {
        var response = XDRWriter()
        response.uint32(xid)
        response.uint32(1)
        response.uint32(1)
        response.uint32(0)
        response.uint32(2)
        response.uint32(2)
        return response.data
      }
      let program = try input.uint32()
      let version = try input.uint32()
      let procedure = try input.uint32()
      let flavor = try input.uint32()
      let auth = try input.opaque(limit: 400)
      _ = try input.uint32()
      _ = try input.opaque(limit: 400)
      header.uint32(xid)
      header.uint32(1)
      header.uint32(0)
      header.uint32(0)
      header.opaque(Data())
      guard program == 100003 else {
        header.uint32(1)
        return header.data
      }
      guard version == 4 else {
        header.uint32(2)
        header.uint32(4)
        header.uint32(4)
        return header.data
      }
      if procedure == 0 {
        header.uint32(0)
        return header.data
      }
      guard procedure == 1 else {
        header.uint32(3)
        return header.data
      }
      guard flavor == 1 else {
        var response = XDRWriter()
        response.uint32(xid)
        response.uint32(1)
        response.uint32(1)
        response.uint32(1)
        response.uint32(5)
        return response.data
      }
      var authReader = XDRReader(data: auth)
      _ = try authReader.uint32()
      _ = try authReader.string(limit: 255)
      let uid = try authReader.uint32()
      let gid = try authReader.uint32()
      let count = try authReader.uint32()
      guard count <= 64 else { throw NFSStatus.badXDR }
      var groups: Set<UInt32> = [gid]
      for _ in 0..<count { groups.insert(try authReader.uint32()) }
      guard authReader.remaining == 0 else { throw NFSStatus.badXDR }
      let key = RPCKey(connection: connection, xid: xid, uid: uid)
      if let pending = pendingRPCs[key] {
        guard pending.request == request else {
          header.uint32(5)
          return header.data
        }
        return await withCheckedContinuation { pendingRPCs[key]!.waiters.append($0) }
      }
      if let replay = replays[key] {
        guard replay.request == request else {
          header.uint32(5)
          return header.data
        }
        let retained = replay.replayStates.map { keys in
          !keys.isEmpty && keys.allSatisfy { key in
            guard let state = states[key], owners[state.owner]?.confirmed == true else {
              return false
            }
            return (try? renew(state.owner.client)) != nil
          }
        } ?? false
        if (!stopped && (replay.generation == generation || retained)) || replay.teardownOnly {
          return replay.response
        }
        var original = XDRReader(data: try input.take(input.remaining))
        let tag = try original.opaque(limit: 1024)
        _ = try original.uint32()
        let operations = try original.uint32()
        var rejected = XDRWriter()
        rejected.uint32(NFSStatus.access.rawValue)
        rejected.opaque(tag)
        rejected.uint32(operations == 0 ? 0 : 1)
        if operations > 0 {
          rejected.uint32(try original.uint32())
          rejected.uint32(NFSStatus.access.rawValue)
        }
        header.uint32(0)
        header.fixed(rejected.data)
        return header.data
      }
      guard pendingRPCs.count < 1024 else {
        header.uint32(5)
        return header.data
      }
      pendingRPCs[key] = RPCPending(request: request)
      let requestGeneration = generation
      var teardownOnly = false
      var replayStates: Set<Data>?
      let response: Data
      do {
        let body = try await compound(
          input.take(input.remaining),
          credentials: Credentials(uid: uid, groups: groups))
        header.uint32(0)
        header.fixed(body.data)
        teardownOnly = body.teardownOnly
        replayStates = body.replayStates
        response = header.data
      } catch {
        header.uint32(4)
        response = header.data
      }
      let waiters = pendingRPCs.removeValue(forKey: key)?.waiters ?? []
      removeReplay(key)
      replays[key] = RPCReplay(
        request: request, response: response, teardownOnly: teardownOnly,
        time: monotonicTime(), generation: requestGeneration, replayStates: replayStates)
      replayBytes += request.count + response.count
      replayOrder[key] = (previous: replayLast, next: nil)
      if let last = replayLast {
        replayOrder[last]!.next = key
      } else {
        replayFirst = key
      }
      replayLast = key
      while replayBytes > 16 * 1024 * 1024, let oldest = replayFirst {
        removeReplay(oldest)
      }
      for waiter in waiters { waiter.resume(returning: response) }
      return response
    } catch {
      var response = XDRWriter()
      response.uint32(xid)
      response.uint32(1)
      response.uint32(0)
      response.uint32(0)
      response.opaque(Data())
      response.uint32(4)
      return response.data
    }
  }
}

private func readExactly(_ handle: FileHandle, count: Int) throws -> Data {
  var result = Data(count: count)
  var offset = 0
  while offset < count {
    let received = result.withUnsafeMutableBytes {
      Darwin.read(handle.fileDescriptor, $0.baseAddress!.advanced(by: offset), count - offset)
    }
    if received < 0 {
      if errno == EINTR { continue }
      throw failure()
    }
    guard received != 0 else { throw failure(ECONNRESET) }
    offset += received
  }
  return result
}
private func readFrame(_ handle: FileHandle) async throws -> Data {
  try await withCheckedThrowingContinuation { continuation in
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        var result = Data()
        var fragments = 0
        while true {
          var header = XDRReader(data: try readExactly(handle, count: 4))
          let marker = try header.uint32()
          let length = Int(marker & 0x7fff_ffff)
          fragments += 1
          guard length <= maximumFrame - result.count, fragments <= 1024 else {
            throw NFSStatus.badXDR
          }
          result.append(try readExactly(handle, count: length))
          if marker & 0x8000_0000 != 0 { break }
        }
        continuation.resume(returning: result)
      } catch { continuation.resume(throwing: error) }
    }
  }
}
private actor SocketWriter {
  let handle: FileHandle
  private var closed = false
  private let queue = DispatchQueue(label: "pi.fs.rpc.writer")
  init(_ handle: FileHandle) { self.handle = handle }
  func write(_ data: Data) async throws {
    guard !closed else { throw failure(ECONNRESET) }
    let handle = handle
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async {
        do {
          var output = XDRWriter()
          output.uint32(0x8000_0000 | UInt32(data.count))
          output.fixed(data)
          try writeAll(handle.fileDescriptor, data: output.data)
          continuation.resume()
        } catch { continuation.resume(throwing: error) }
      }
    }
  }
  func close() {
    closed = true
    shutdown(handle.fileDescriptor, SHUT_RDWR)
  }
}
private func configureSocket(_ fd: Int32) throws {
  try checked(fcntl(fd, F_SETFD, FD_CLOEXEC))
  var one: Int32 = 1
  try checked(setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size)))
  var timeout = timeval(tv_sec: 30, tv_usec: 0)
  try checked(
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)))
}
private func listenSocket(_ path: String) throws -> FileHandle {
  guard validPath(path), path != "/" else { throw failure(EINVAL) }
  let fd = try checked(socket(AF_UNIX, SOCK_STREAM, 0))
  let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
  try configureSocket(fd)
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  let bytes = path.utf8CString
  guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
    throw failure(ENAMETOOLONG)
  }
  withUnsafeMutableBytes(of: &address.sun_path) { destination in
    bytes.withUnsafeBytes { destination.copyBytes(from: $0) }
  }
  let oldMask = umask(0o077)
  defer { umask(oldMask) }
  _ = try withUnsafePointer(to: &address) {
    try $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      try checked(bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)))
    }
  }
  do {
    try checked(chmod(path, 0o600))
    try checked(listen(fd, 32))
  } catch {
    unlink(path)
    throw error
  }
  return handle
}
private func serveConnection(_ handle: FileHandle, server: NFSServer) async {
  let id = UUID()
  guard await server.admitConnection(id) else {
    try? handle.close()
    return
  }
  let writer = SocketWriter(handle)
  await withTaskGroup(of: Void.self) { group in
    var pending = 0
    do {
      while true {
        let request = try await readFrame(handle)
        if pending == 32 {
          await group.next()
          pending -= 1
        }
        pending += 1
        group.addTask {
          let response = await server.rpc(request, connection: id)
          do { try await writer.write(response) } catch { await writer.close() }
        }
      }
    } catch {
      let error = error as NSError
      if error.domain != NSPOSIXErrorDomain || ![ECONNRESET, EPIPE].contains(Int32(error.code)) {
        diagnostic("NFS connection: \(error)")
      }
    }
    await writer.close()
  }
  try? handle.close()
  await server.releaseConnection(id)
}
private func acceptDescriptor(_ listener: FileHandle) async throws -> Int32 {
  try await withCheckedThrowingContinuation { continuation in
    DispatchQueue.global(qos: .userInitiated).async {
      while true {
        let fd = accept(listener.fileDescriptor, nil, nil)
        if fd >= 0 {
          continuation.resume(returning: fd)
          return
        }
        if errno == EINTR { continue }
        continuation.resume(throwing: failure())
        return
      }
    }
  }
}
private func acceptConnections(_ listener: FileHandle, server: NFSServer) {
  Task {
    await withTaskGroup(of: Void.self) { group in
      var pending = 0
      while true {
        if pending == 64 {
          await group.next()
          pending -= 1
        }
        let fd: Int32
        do {
          fd = try await acceptDescriptor(listener)
        } catch {
          diagnostic("NFS accept: \(error)")
          await server.stop()
          return
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
          try configureSocket(fd)
          var uid: uid_t = 0
          var gid: gid_t = 0
          try checked(getpeereid(fd, &uid, &gid))
          guard uid == geteuid() || uid == 0 else { throw failure(EACCES) }
          pending += 1
          group.addTask { await serveConnection(handle, server: server) }
        } catch {
          diagnostic("NFS accept credentials: \(error)")
          try? handle.close()
        }
      }
    }
  }
}
private func controlInput(_ server: NFSServer) async {
  do {
    var frame = Data()
    for try await byte in FileHandle.standardInput.bytes {
      if byte == 10 {
        let message = try JSONDecoder().decode(ControlMessage.self, from: frame)
        frame.removeAll(keepingCapacity: true)
        try await server.receive(message)
      } else {
        frame.append(byte)
        guard frame.count <= 1_048_576 else { throw failure(EMSGSIZE) }
      }
    }
  } catch { diagnostic("Controller disconnected: \(error)") }
  await server.stop()
}
extension NFSServer {
  fileprivate func admitConnection(_ id: UUID) -> Bool {
    guard connections.count < 64 else { return false }
    connections.insert(id)
    return true
  }
  fileprivate func releaseConnection(_ id: UUID) {
    connections.remove(id)
    for key in replays.keys where key.connection == id {
      removeReplay(key)
    }
  }
  fileprivate func tick() { maintenance() }
}
@main private struct PiFS {
  static func main() async {
    do {
      var root = "/"
      var socketPath: String?
      var arguments = CommandLine.arguments.dropFirst().makeIterator()
      while let argument = arguments.next() {
        switch argument {
        case "--socket":
          guard socketPath == nil, let value = arguments.next() else { throw failure(EINVAL) }
          socketPath = value
        case "--root":
          guard let value = arguments.next(), validPath(value) else { throw failure(EINVAL) }
          root = value
        default: throw failure(EINVAL)
        }
      }
      guard let socketPath else { throw failure(EINVAL) }
      signal(SIGPIPE, SIG_IGN)
      for fd in [STDOUT_FILENO, STDERR_FILENO] {
        let flags = try checked(fcntl(fd, F_GETFL))
        try checked(fcntl(fd, F_SETFL, flags | O_NONBLOCK))
      }
      try configureDescriptorLimit()
      let server = try NFSServer(rootPath: root)
      let listener = try listenSocket(socketPath)
      acceptConnections(listener, server: server)
      try await server.hello()
      Task { await controlInput(server) }
      while true {
        try await Task.sleep(for: .seconds(5))
        await server.tick()
      }
    } catch {
      diagnostic("pifs: \(error)")
      exit(1)
    }
  }
}
