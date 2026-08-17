#if os(macOS)
import Foundation

/// Bounded, read-only search of the attached local session's working directory.
nonisolated enum LocalFileCompletions {
    struct Match: Sendable {
        let path: String
        let directory: Bool
    }

    static func search(cwd: String, query: String) async -> [Match] {
        let task = Task.detached(priority: .userInitiated) { scan(cwd: cwd, query: query) }
        return await withTaskCancellationHandler {
            await task.value
        } onCancel: { task.cancel() }
    }

    private static func scan(cwd: String, query: String) -> [Match] {
        let root = URL(fileURLWithPath: cwd, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        guard root.isFileURL, root.path != "/" else { return [] } // Never crawl the entire volume.
        let manager = FileManager.default
        guard let walker = manager.enumerator(at: root,
                                              includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                                              options: [.skipsHiddenFiles, .skipsPackageDescendants],
                                              errorHandler: { _, _ in true }) else { return [] }
        var matches: [Match] = []
        var visited = 0
        for case let url as URL in walker {
            if Task.isCancelled || visited >= 4_000 { break }
            visited += 1
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            let directory = values?.isDirectory == true
            if directory && ["node_modules", ".git", ".build", "build", "DerivedData"].contains(url.lastPathComponent) {
                walker.skipDescendants()
                continue
            }
            if values?.isSymbolicLink == true { continue }
            let absolute = url.standardizedFileURL.path
            guard absolute.hasPrefix(root.path + "/") else { continue }
            let path = String(absolute.dropFirst(root.path.count + 1))
            guard !path.isEmpty, query.isEmpty || path.localizedCaseInsensitiveContains(query) else { continue }
            matches.append(Match(path: path, directory: directory))
        }
        return Array(matches.sorted {
            let leftDepth = $0.path.filter { $0 == "/" }.count
            let rightDepth = $1.path.filter { $0 == "/" }.count
            return leftDepth == rightDepth ? $0.path.localizedStandardCompare($1.path) == .orderedAscending : leftDepth < rightDepth
        }.prefix(30))
    }
}
#endif
