#if os(macOS)
import SwiftUI

struct RemoteConnectionSheet: View {
    @EnvironmentObject private var store: DaemonSessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var selectedProfile: String?
    @State private var importedProfile = ""
    @State private var working = false

    private var unavailable: Bool { working || store.busy }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Connect to Remote").font(.headline)

            if store.connected {
                LabeledContent("Connected to", value: store.remoteOrigin ?? "Local daemon")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Form {
                Picker("Saved server", selection: $selectedProfile) {
                    Text("Choose a server").tag(Optional<String>.none)
                    ForEach(store.savedRemoteProfiles, id: \.self) { profile in
                        Text(profile).tag(Optional(profile))
                    }
                }
                .disabled(unavailable || store.savedRemoteProfiles.isEmpty)
            }
            .formStyle(.columns)

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                Text("Import connection profile").font(.subheadline.weight(.medium))
                SecureField("Paste base64 connection profile", text: $importedProfile)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .privacySensitive()
                    .disabled(unavailable)
                HStack {
                    Text("Saved securely in Keychain.")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Import and Connect") { importAndConnect() }
                        .disabled(unavailable || importedProfile.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            if let error = store.error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }

            HStack {
                if store.remoteOrigin != nil {
                    Button("Use Local Daemon") {
                        perform { await store.connect() }
                    }
                    .disabled(unavailable)
                }
                if unavailable { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") {
                    importedProfile = ""
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                .disabled(unavailable)
                Button("Connect") {
                    guard let selectedProfile else { return }
                    perform { await store.connectRemote(profileID: selectedProfile) }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(unavailable || selectedProfile == nil)
            }
        }
        .padding(24)
        .frame(width: 480)
        .interactiveDismissDisabled(unavailable)
        .onAppear {
            selectedProfile = store.remoteOrigin ?? store.savedRemoteProfiles.first
        }
        .onDisappear { importedProfile = "" }
    }

    private func importAndConnect() {
        // Keep credentials out of durable view/app state and clear the field
        // before any asynchronous work. The store owns Keychain persistence.
        let profile = importedProfile.trimmingCharacters(in: .whitespacesAndNewlines)
        importedProfile = ""
        guard !profile.isEmpty else { return }
        perform { await store.importRemoteProfile(profile) }
    }

    private func perform(_ action: @escaping @MainActor () async -> Void) {
        guard !unavailable else { return }
        working = true
        store.error = nil
        Task {
            await action()
            working = false
            if store.connected, store.error == nil { dismiss() }
        }
    }
}

#Preview("Remote Connection") {
    RemoteConnectionSheet()
        .environmentObject(DaemonSessionStore())
}
#endif
