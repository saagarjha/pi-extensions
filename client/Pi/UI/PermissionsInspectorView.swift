import SwiftUI
import AppKit

/// All edits are submitted against the revision and service generation visible when the
/// user made the choice. Admission is not completion: only canonical service frames
/// update `state`, and operation failures arrive separately in `error`.
struct PermissionsInspectorView: View {
    let state: PermissionState?
    let connected: Bool
    let canEdit: Bool
    let serviceGeneration: String?
    let pending: Bool
    let error: String?
    let mutate: (LinkPermissionMutation, Int, String) async -> Bool

    private enum EditorKind: String { case file, vm, execution, ssh }
    private struct GrantEditor: Identifiable {
        let id = UUID()
        let kind: EditorKind
        let revision: Int
        let generation: String
    }

    @Environment(\.localPathDirectory) private var localPathDirectory
    @State private var editor: GrantEditor?
    @State private var nameInput = ""
    @State private var detailInput = ""
    @State private var modeInput: LinkPermissionMutation.Mode = .ro
    @State private var execModeInput: LinkPermissionMutation.ExecMode = .ask
    @State private var submitting = false
    @State private var status: String?

    private var editable: Bool { canEdit && serviceGeneration != nil && !submitting }

    var body: some View {
        Group {
            if let state {
                Form {
                    Section {
                        sectionList {
                            accessPicker("Network", detail: "", symbol: "network",
                                         value: state.permissions.network ?? "deny",
                                         choices: LinkPermissionMutation.NetworkMode.allCases.map(\.rawValue),
                                         onSet: { raw in
                                             if let mode = LinkPermissionMutation.NetworkMode(rawValue: raw) {
                                                 request(.setNetwork(mode: mode), revision: state.revision)
                                             }
                                         })
                        }
                    }
                    Section {
                        sectionList {
                            if state.permissions.scopes.isEmpty {
                                Text("No file permissions").foregroundStyle(.secondary)
                            }
                            ForEach(state.permissions.scopes.indices, id: \.self) { index in
                                let scope = state.permissions.scopes[index]
                                accessPicker(scope.path, detail: "", symbol: "folder",
                                             value: scope.mode,
                                             choices: LinkPermissionMutation.Mode.allCases.map(\.rawValue),
                                             deletable: true, path: scope.path,
                                             onSet: { raw in
                                                 if let mode = LinkPermissionMutation.Mode(rawValue: raw) {
                                                     request(.setFile(path: scope.path, mode: mode), revision: state.revision)
                                                 }
                                             },
                                             onDelete: { request(.removeFile(path: scope.path), revision: state.revision) })
                            }
                        }
                        .dropDestination(for: URL.self) { urls, _ in
                            guard editable, localPathDirectory != nil, !urls.isEmpty,
                                  urls.count <= 128, urls.allSatisfy(\.isFileURL) else { return false }
                            request(.setFiles(paths: urls.map(\.path), mode: .askRW), revision: state.revision)
                            return true
                        }
                    } header: {
                        addableHeader("Files") { openEditor(.file, revision: state.revision) }
                    }
                    Section {
                        sectionList {
                            if state.permissions.vms.isEmpty {
                                Text("No VM permissions").foregroundStyle(.secondary)
                            }
                            ForEach(state.permissions.vms.indices, id: \.self) { index in
                                let vm = state.permissions.vms[index]
                                accessPicker(vm.vmId, detail: "", symbol: vmSymbol(vm.vmId),
                                             value: vm.mode,
                                             choices: LinkPermissionMutation.Mode.allCases.map(\.rawValue),
                                             deletable: true,
                                             network: Binding(
                                                 get: { vm.network == true },
                                                 set: { enabled in
                                                     request(.setVMNetwork(vmId: vm.vmId, enabled: enabled), revision: state.revision)
                                                 }),
                                             onSet: { raw in
                                                 if let mode = LinkPermissionMutation.Mode(rawValue: raw) {
                                                     request(.setVM(vmId: vm.vmId, mode: mode), revision: state.revision)
                                                 }
                                             },
                                             onDelete: { request(.removeVM(vmId: vm.vmId), revision: state.revision) })
                            }
                        }
                    } header: {
                        addableHeader("Virtual Machines") { openEditor(.vm, revision: state.revision) }
                    }
                    Section {
                        sectionList {
                            if state.permissions.execGrants.isEmpty {
                                Text("No execution grants").foregroundStyle(.secondary)
                            }
                            ForEach(state.permissions.execGrants.indices, id: \.self) { index in
                                let grant = state.permissions.execGrants[index]
                                accessPicker(grant.target, detail: grant.command, symbol: vmSymbol(grant.target),
                                             value: grant.mode,
                                             choices: LinkPermissionMutation.ExecMode.allCases.map(\.rawValue),
                                             deletable: true, monospaced: true,
                                             onSet: { raw in
                                                 if let mode = LinkPermissionMutation.ExecMode(rawValue: raw) {
                                                     request(.setExec(target: grant.target, command: grant.command, mode: mode),
                                                             revision: state.revision)
                                                 }
                                             },
                                             onDelete: {
                                                 request(.removeExec(target: grant.target, command: grant.command),
                                                         revision: state.revision)
                                             })
                            }
                        }
                    } header: {
                        addableHeader("Execution") { openEditor(.execution, revision: state.revision) }
                    }
                    Section {
                        sectionList {
                            let runningIDs = state.permissions.targets.map(\.id)
                            let ids = runningIDs + state.permissions.sshTargets.map(\.id).filter { !runningIDs.contains($0) }
                            if ids.isEmpty { Text("No targets").foregroundStyle(.secondary) }
                            ForEach(ids, id: \.self) { id in
                                targetRow(id, state: state, running: runningIDs.contains(id))
                            }
                        }
                    } header: {
                        addableHeader("Targets") { openEditor(.ssh, revision: state.revision) }
                    }
                }
                .formStyle(.grouped)
            } else {
                ContentUnavailableView(connected ? "Permissions unavailable" : "Not connected",
                                       systemImage: "lock.shield",
                                       description: Text(connected
                                           ? "Select a session with permission information."
                                           : "Connect to see the current permissions."))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .navigationTitle("Permissions")
        .inspectorColumnWidth(min: 260, ideal: 320, max: 420)
        .safeAreaInset(edge: .top, spacing: 0) {
            if let error, !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.regularMaterial)
            } else if pending {
                HStack { ProgressView().controlSize(.small); Text("Applying permission change…") }
                    .font(.caption)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.regularMaterial)
            } else if let status {
                Text(status).font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.regularMaterial)
            }
        }
        .onChange(of: serviceGeneration) { _, _ in
            editor = nil; status = nil
        }
        .sheet(item: $editor) { active in
            editorForm(active)
                .frame(minWidth: 380)
        }
    }

    private func targetRow(_ id: String, state: PermissionState, running: Bool) -> some View {
        let ssh = state.permissions.sshTargets.first { $0.id == id }
        return HStack {
            row(id, detail: "", symbol: running ? "status.running" : "status.inactive")
            Spacer(minLength: 8)
            if let ssh {
                Button("Edit", systemImage: "pencil") {
                    openEditor(.ssh, revision: state.revision, name: ssh.id,
                               detail: ssh.destination + ssh.port.map { ":\($0)" }.orEmpty)
                }
                .labelStyle(.iconOnly)
                .disabled(!editable)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if ssh != nil && editable {
                Button(role: .destructive) {
                    request(.removeSSH(id: id), revision: state.revision)
                } label: { Label("Delete", systemImage: "trash") }
            }
        }
    }

    private func request(_ mutation: LinkPermissionMutation, revision: Int) {
        guard editable, let serviceGeneration else { return }
        submit(mutation, revision: revision, generation: serviceGeneration)
    }

    private func submit(_ mutation: LinkPermissionMutation, revision: Int, generation: String) {
        guard canEdit, !submitting else { return }
        submitting = true
        status = nil
        Task {
            let admitted = await mutate(mutation, revision, generation)
            submitting = false
            if admitted {
                editor = nil
            } else {
                status = "Request not accepted. Review the error above and refresh permissions."
            }
        }
    }

    private func openEditor(_ kind: EditorKind, revision: Int, name: String = "", detail: String = "") {
        guard editable, let serviceGeneration else { return }
        nameInput = name
        detailInput = detail
        modeInput = .ro
        execModeInput = .ask
        editor = GrantEditor(kind: kind, revision: revision, generation: serviceGeneration)
    }

    private func editorForm(_ active: GrantEditor) -> some View {
        Form {
            TextField(active.kind == .file ? "Path" : active.kind == .vm ? "VM ID" : active.kind == .ssh ? "SSH ID" : "Target",
                      text: $nameInput)
            if active.kind == .execution {
                TextField("Command", text: $detailInput)
            } else if active.kind == .ssh {
                TextField("Destination[:port]", text: $detailInput)
                Text("Network access must be explicitly enabled before adding an SSH target.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if active.kind == .file || active.kind == .vm {
                Picker("Access", selection: $modeInput) {
                    ForEach(LinkPermissionMutation.Mode.allCases, id: \.self) { mode in
                        Text(accessDescription(mode.rawValue)).tag(mode)
                    }
                }
            } else if active.kind == .execution {
                Picker("Execution", selection: $execModeInput) {
                    ForEach(LinkPermissionMutation.ExecMode.allCases, id: \.self) { mode in
                        Text(accessDescription(mode.rawValue)).tag(mode)
                    }
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            else if let status { Text(status).font(.caption).foregroundStyle(.secondary) }
            HStack {
                Button("Close") { editor = nil }
                Spacer()
                Button("Submit") { submitEditor(active) }
                    .disabled(!canEdit || submitting || nameInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || ((active.kind == .execution || active.kind == .ssh)
                            && detailInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
        }
        .formStyle(.grouped)
    }

    private func submitEditor(_ active: GrantEditor) {
        let name = nameInput.trimmingCharacters(in: .whitespacesAndNewlines)
        let detail = detailInput.trimmingCharacters(in: .whitespacesAndNewlines)
        let mutation: LinkPermissionMutation
        switch active.kind {
        case .file: mutation = .setFile(path: name, mode: modeInput)
        case .vm: mutation = .setVM(vmId: name, mode: modeInput)
        case .execution: mutation = .setExec(target: name, command: detail, mode: execModeInput)
        case .ssh: mutation = .setSSH(id: name, destination: detail)
        }
        submit(mutation, revision: active.revision, generation: active.generation)
    }

    private func sectionList<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        List(content: content)
            .listStyle(.plain)
            .scrollDisabled(true)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func addableHeader(_ title: String, action: @escaping () -> Void) -> some View {
        HStack {
            Text(title)
            Spacer()
            Button(action: action) { Image(systemName: "plus") }
                .buttonStyle(.plain)
                .disabled(!editable)
                .accessibilityLabel("Add \(title.lowercased()) permission")
        }
    }

    @ViewBuilder private func accessPicker(_ title: String, detail: String, symbol: String,
                                            value: String, choices: [String], deletable: Bool = false,
                                            path: String? = nil, monospaced: Bool = false,
                                            network: Binding<Bool>? = nil,
                                            onSet: @escaping (String) -> Void,
                                            onDelete: @escaping () -> Void = {}) -> some View {
        if deletable && editable {
            pickerRow(title, detail: detail, symbol: symbol, value: value, choices: choices,
                      path: path, monospaced: monospaced, network: network, onSet: onSet)
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive, action: onDelete) {
                        Label("Delete", systemImage: "trash")
                    }
                }
        } else {
            pickerRow(title, detail: detail, symbol: symbol, value: value, choices: choices,
                      path: path, monospaced: monospaced, network: network, onSet: onSet)
        }
    }

    private func pickerRow(_ title: String, detail: String, symbol: String,
                           value: String, choices: [String], path: String?, monospaced: Bool,
                           network: Binding<Bool>?, onSet: @escaping (String) -> Void) -> some View {
        LabeledContent {
            Picker(title, selection: Binding(get: { value }, set: onSet)) {
                ForEach(choices, id: \.self) { choice in
                    Text(accessDescription(choice)).tag(choice)
                }
                if !choices.contains(value) {
                    Text(accessDescription(value)).tag(value)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .disabled(!editable)
        } label: {
            if let path {
                PathView(path: path, target: "local")
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                row(title, detail: detail, symbol: symbol, monospaced: monospaced, network: network)
            }
        }
    }

    private func vmSymbol(_ id: String) -> String {
        if id == "local" { return "local.computer" }
        if state?.permissions.sshTargets.contains(where: { $0.id == id }) == true { return "link" }
        return "cpu"
    }

    @ViewBuilder private func resourceIcon(_ symbol: String) -> some View {
        if symbol == "status.running" || symbol == "status.inactive" {
            Circle().fill(symbol == "status.running" ? Color.green : Color.gray).frame(width: 7, height: 7)
                .frame(width: 18, height: 18)
                .accessibilityLabel(symbol == "status.running" ? "Running" : "Inactive")
        } else if symbol == "local.computer", let image = NSImage(named: NSImage.computerName) {
            Image(nsImage: image).resizable().scaledToFit().frame(width: 18, height: 18)
        } else {
            Image(systemName: symbol == "local.computer" ? "desktopcomputer" : symbol)
                .foregroundStyle(.secondary).frame(width: 18)
        }
    }

    private func row(_ title: String, detail: String, symbol: String, monospaced: Bool = false,
                     network: Binding<Bool>? = nil) -> some View {
        HStack(alignment: .top, spacing: 10) {
            resourceIcon(symbol)
            VStack(alignment: .leading, spacing: 8) {
                Text(title).lineLimit(2).truncationMode(.middle).help(title)
                if let network {
                    Toggle("Network", isOn: network)
                        .toggleStyle(.checkbox)
                        .font(.caption)
                        .disabled(!editable)
                } else if !detail.isEmpty {
                    Text(detail).font(.system(.caption, design: monospaced ? .monospaced : .default)).foregroundStyle(.secondary)
                }
            }
        }
        .textSelection(.enabled)
        .padding(.vertical, 2)
    }

    private func accessDescription(_ mode: String) -> String {
        switch mode {
        case "ro": "Read only"
        case "rw": "Read & write"
        case "ask-ro": "Ask to read"
        case "ask-rw": "Ask to read & write"
        case "ro-ask-rw": "Read; ask to write"
        case "ask": "Ask"
        case "allow": "Allow"
        case "deny": "Deny"
        default: mode.capitalized
        }
    }
}

private extension Optional where Wrapped == String {
    var orEmpty: String { self ?? "" }
}

#Preview("Permissions inspector") {
    PermissionsInspectorView(
        state: PermissionState(revision: 1, permissions: PermissionsSnapshot(
            scopes: [.init(path: "/workspace/project", mode: "rw")],
            vms: [.init(vmId: "scratch-demo", mode: "rw", network: false)],
            execGrants: [.init(target: "scratch-demo", command: "*", mode: "allow")],
            sshTargets: [], network: "ask", targets: []
        )),
        connected: true, canEdit: true, serviceGeneration: "preview", pending: false, error: nil,
        mutate: { _, _, _ in true }
    )
}
