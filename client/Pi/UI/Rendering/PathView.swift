import SwiftUI

private struct LocalPathDirectoryKey: EnvironmentKey {
	static let defaultValue: String? = nil
}

private struct PathTargetsKey: EnvironmentKey {
	static let defaultValue: [PermissionsSnapshot.RunningTarget] = []
}

extension EnvironmentValues {
	/// Current permission targets from the same local daemon authority as this path.
	var pathTargets: [PermissionsSnapshot.RunningTarget] {
		get { self[PathTargetsKey.self] }
		set { self[PathTargetsKey.self] = newValue }
	}

	/// The local daemon's cwd; leave nil for remote daemons and previews.
	var localPathDirectory: String? {
		get { self[LocalPathDirectoryKey.self] }
		set { self[LocalPathDirectoryKey.self] = newValue }
	}
}

nonisolated enum PathTargetMetadata {
	static func targets(in value: PermissionState?) -> [PermissionsSnapshot.RunningTarget] {
		value?.permissions.targets ?? []
	}
}

/// Decode only when the permission value changes, never for each streamed token.
struct PathTargetsModifier: ViewModifier {
	let services: LinkActivityServices?
	@State private var targets: [PermissionsSnapshot.RunningTarget] = []
	@State private var decodedValue: PermissionState?
	private var value: PermissionState? { services?.permissions?.value }

	func body(content: Content) -> some View {
		content.environment(\.pathTargets, value == decodedValue ? targets : [])
			.onChange(of: value, initial: true) { _, value in
				targets = PathTargetMetadata.targets(in: value)
				decodedValue = value
			}
	}
}

struct PathView: View {
	enum DisplayMode: Equatable { case automatic, standard, popUp }

	let path: String
	let target: String?
	var isDirectory: Bool? = nil
	var displayMode: DisplayMode = .automatic

	@Environment(\.localPathDirectory) private var localPathDirectory
	@Environment(\.pathTargets) private var pathTargets

	var body: some View {
		#if os(macOS)
		if displayMode == .automatic {
			AdaptivePathLayout {
				// Let AppKit compress ancestors before switching to the menu.
				nativePath(.standard, adaptive: true)
				nativePath(.popUp)
			}
			.clipped()
		} else {
			nativePath(displayMode)
		}
		#else
		HStack {
			Label(path.isEmpty ? "Path" : path,
				systemImage: isDirectory == true ? "folder" : "doc")
				.lineLimit(1)
				.truncationMode(.middle)
			if let target, !target.isEmpty {
				Text(verbatim: target).foregroundStyle(.secondary)
			}
		}
		.help(path.isEmpty ? "Path" : path)
		#endif
	}

	#if os(macOS)
	private func nativePath(_ mode: DisplayMode, adaptive: Bool = false) -> NativePathView {
		NativePathView(path: path, target: target, isDirectory: isDirectory,
			localPathDirectory: localPathDirectory, pathTargets: pathTargets,
			displayMode: mode, adaptive: adaptive)
	}
	#endif
}

#if os(macOS)
/// Unlike ViewThatFits, query the child at the actual proposed width: the
/// breadcrumb's intrinsic width is its *uncompressed* width.
private struct AdaptivePathLayout: Layout {
	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		let standard = subviews[0].sizeThatFits(proposal)
		guard let width = proposal.width, standard.width > width else { return standard }
		return subviews[1].sizeThatFits(proposal)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize,
		subviews: Subviews, cache: inout ()) {
		let width = bounds.width
		let proposed = ProposedViewSize(width: width, height: bounds.height)
		let index = subviews[0].sizeThatFits(proposed).width > width ? 1 : 0
		subviews[index].place(at: bounds.origin, proposal: proposed)
		// Nonselected NSViewRepresentables still exist. Move the other outside
		// the clipped layout instead of leaving it over the active control.
		subviews[1 - index].place(at: CGPoint(x: bounds.maxX + 1, y: bounds.maxY + 1),
			proposal: .zero)
	}
}
#endif

/// Container file tools resolve relative paths against guest '/', not daemon cwd.
/// Keep logical titles untouched; normalize only the destination and reject escape.
nonisolated struct ContainerPathMapping {
	let root: URL

	init?(target: String?, localDirectory: String?, targets: [PermissionsSnapshot.RunningTarget]) {
		guard localDirectory?.hasPrefix("/") == true, let target,
			let value = targets.first(where: { $0.id == target }), value.kind == "linux",
			let filesystem = value.hostFilesystem, filesystem.kind == "orbstack-docker",
			filesystem.root.hasPrefix("/") else { return nil }
		let candidate = URL(fileURLWithPath: filesystem.root, isDirectory: true).resolvingSymlinksInPath().standardizedFileURL
		var directory: ObjCBool = false
		guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &directory), directory.boolValue else { return nil }
		root = candidate
	}

	func url(components: [String]) -> URL? {
		var normalized: [String] = []
		for component in components {
			guard !component.contains("\0"), !component.contains("/") else { return nil }
			if component == "." { continue }
			if component == ".." {
				guard !normalized.isEmpty else { return nil }
				normalized.removeLast()
			} else { normalized.append(component) }
		}
		return Self.confined(normalized.reduce(root) { $0.appendingPathComponent($1) }, to: root)
	}

	static func confined(_ url: URL, to root: URL) -> URL? {
		let canonical = url.resolvingSymlinksInPath().standardizedFileURL
		guard canonical.path == root.path || canonical.path.hasPrefix(root.path + "/"),
			FileManager.default.fileExists(atPath: root.path),
			FileManager.default.fileExists(atPath: canonical.path) else { return nil }
		return canonical
	}
}

#if os(macOS)
import AppKit
import UniformTypeIdentifiers

struct NativePathView: NSViewRepresentable {
	let path: String
	let target: String?
	let isDirectory: Bool?
	let localPathDirectory: String?
	var pathTargets: [PermissionsSnapshot.RunningTarget] = []
	var displayMode: PathView.DisplayMode = .standard
	var adaptive = false

	func makeCoordinator() -> Coordinator { Coordinator() }

	@MainActor final class Coordinator: NSObject, NSPathControlDelegate {
		var mappedRoot: URL?
		var nativeLocal = false

		static func localURL(for item: NSPathControlItem?, in control: NSPathControl) -> URL? {
			guard let coordinator = control.delegate as? Coordinator, let item,
				control.pathItems.contains(where: { $0 === item }),
				let url = item.url, url.isFileURL else { return nil }
			if let root = coordinator.mappedRoot {
				return ContainerPathMapping.confined(url, to: root)
			}
			return coordinator.nativeLocal ? url : nil
		}

		@objc func openComponent(_ control: NSPathControl) {
			guard let url = Self.localURL(for: control.clickedPathItem, in: control) else { return }
			NSWorkspace.shared.open(url)
		}

		func pathControl(_ pathControl: NSPathControl, shouldDrag pathItem: NSPathControlItem,
			with pasteboard: NSPasteboard) -> Bool {
			guard let url = Self.localURL(for: pathItem, in: pathControl) else { return false }
			pasteboard.clearContents()
			return pasteboard.writeObjects([url as NSURL])
		}

		func pathControl(_ pathControl: NSPathControl, validateDrop info: any NSDraggingInfo) -> NSDragOperation { [] }
		func pathControl(_ pathControl: NSPathControl, acceptDrop info: any NSDraggingInfo) -> Bool { false }
	}

	func makeNSView(context: Context) -> NSPathControl {
		let control = NSPathControl()
		control.isEditable = false
		control.pathStyle = displayMode == .popUp ? .popUp : .standard
		control.cell?.isSelectable = true
		control.delegate = context.coordinator
		control.target = context.coordinator
		control.action = #selector(Coordinator.openComponent(_:))
		control.doubleAction = #selector(Coordinator.openComponent(_:))
		control.setDraggingSourceOperationMask([], forLocal: true)
		control.setDraggingSourceOperationMask([], forLocal: false)
		control.unregisterDraggedTypes()
		control.placeholderString = "Path"
		control.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
		return control
	}

	func updateNSView(_ control: NSPathControl, context: Context) {
		control.pathStyle = displayMode == .popUp ? .popUp : .standard
		configure(control)
	}

	func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSPathControl, context: Context) -> CGSize? {
		// SwiftUI adds the alignment insets; fittingSize already includes them.
		let size = nsView.intrinsicContentSize
		guard let width = proposal.width, width.isFinite else { return size }
		if adaptive, displayMode == .standard, width < size.width,
		   let cell = nsView.cell as? NSPathCell,
		   let last = cell.pathComponentCells.last {
			// Ask AppKit whether its final breadcrumb still has its full native
			// width at this proposal. Earlier components may collapse to icons.
			let full = cell.rect(of: last, withFrame: CGRect(origin: .zero, size: size), in: nsView)
			let proposed = cell.rect(of: last,
				withFrame: CGRect(x: 0, y: 0, width: max(0, width), height: size.height), in: nsView)
			if proposed.width < full.width { return size } // ViewThatFits selects pop-up.
		}
		return CGSize(width: min(width, size.width), height: size.height)
	}

	// Kept separate from the representable lifecycle for isolated control tests.
	func configure(_ control: NSPathControl) {
		// Clear both representations, including a previous native local URL. Setting
		// objectValue avoids asking AppKit to interpret a URL in the manual branch.
		let coordinator = control.delegate as? Coordinator
		coordinator?.mappedRoot = nil
		coordinator?.nativeLocal = false
		control.objectValue = nil
		control.pathItems = []
		control.setDraggingSourceOperationMask([], forLocal: true)
		control.setDraggingSourceOperationMask([], forLocal: false)
		control.toolTip = path.isEmpty ? "Path" : path
		defer { control.invalidateIntrinsicContentSize() }
		guard !path.isEmpty else { return }

		if let url = localURL {
			coordinator?.nativeLocal = true
			control.url = url
			// Dragging exports a file reference; it does not edit the control's path.
			control.setDraggingSourceOperationMask(.copy, forLocal: true)
			control.setDraggingSourceOperationMask(.copy, forLocal: false)
		} else {
			var components = path.split(separator: "/").map(String.init)
			// The root is last in the pop-up menu, like a local volume name.
			let root: String? = target.flatMap { $0.isEmpty ? nil : $0 }
				?? (path.hasPrefix("/") ? "/" : nil)
			if let root { components.insert(root, at: 0) }
			let mapping = ContainerPathMapping(target: target, localDirectory: localPathDirectory, targets: pathTargets)
			coordinator?.mappedRoot = mapping?.root
			var guestComponents: [String] = []
			let urls = components.enumerated().map { index, component -> URL? in
				if !(index == 0 && root != nil) { guestComponents.append(component) }
				return mapping?.url(components: guestComponents)
			}
			// Let AppKit construct URL-bearing items once, then relabel only the
			// verified guest subset. No hidden controls or deprecated cell setters.
			var nativeItems: [NSPathControlItem] = []
			if let deepest = urls.compactMap({ $0 }).last {
				control.url = deepest
				nativeItems = control.pathItems
				control.objectValue = nil
			}
			control.pathItems = components.enumerated().map { index, component in
				let item: NSPathControlItem
				if let url = urls[index], let nativeIndex = nativeItems.firstIndex(where: { $0.url?.isFileURL == true && $0.url?.standardizedFileURL.path == url.standardizedFileURL.path }) {
					item = nativeItems.remove(at: nativeIndex)
				} else {
					// Traversal/symlinks can leave a prefix outside the final ancestor
					// chain, or repeat a URL. Keep its title but never guess a URL or
					// reuse one mutable native item for two logical positions.
					item = NSPathControlItem()
				}
				item.attributedTitle = NSAttributedString(string: component)
				let type: UTType
				if (index == 0 && root != nil) || index < components.count - 1 || isDirectory == true {
					type = .folder
				} else if isDirectory == false {
					let ext = (component as NSString).pathExtension
					type = UTType(filenameExtension: ext) ?? .data
				} else {
					type = .data
				}
				// Type icons only: never resolve a remote name against the filesystem.
				item.image = NSWorkspace.shared.icon(for: type)
				return item
			}
			if mapping != nil {
				control.setDraggingSourceOperationMask(.copy, forLocal: true)
				control.setDraggingSourceOperationMask(.copy, forLocal: false)
			}
		}
	}

	private var localURL: URL? {
		guard target == "local", let cwd = localPathDirectory else { return nil }
		// A daemon cwd does not identify its user's home directory. Preserve ~
		// literally in manual mode rather than expanding the UI process's home.
		guard !path.hasPrefix("~") else { return nil }
		if path.hasPrefix("/") {
			return URL(fileURLWithPath: path, isDirectory: isDirectory ?? false)
		}
		guard cwd.hasPrefix("/") else { return nil }
		let base = URL(fileURLWithPath: cwd, isDirectory: true)
		return URL(fileURLWithPath: path, isDirectory: isDirectory ?? false, relativeTo: base).absoluteURL
	}
}
#endif
