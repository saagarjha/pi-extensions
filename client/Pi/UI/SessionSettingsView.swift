import SwiftUI
#if os(macOS)

struct SessionSettingsView: View {
    @EnvironmentObject private var store: DaemonSessionStore
    @AppStorage("experimentalNativeTranscript") private var experimentalNativeTranscript = false

    var body: some View {
        Form {
            modelPicker
            thinkingPicker
            Toggle("Experimental native transcript", isOn: $experimentalNativeTranscript)
                .help("Try the native collection renderer. Turn off to restore the original transcript immediately. Includes experimental reading-position preservation and bottom-follow; scrolling or selecting yields to you.")
        }
        .formStyle(.columns)
        .padding(20)
        .frame(width: 360)
    }

    private var modelPicker: some View {
        Picker("Model", selection: Binding<LinkModelKey?>(
            get: { store.selectedModelKey },
            set: { key in
                guard let key, key != store.selectedModelKey, store.canSelectModel else { return }
                Task { await store.selectModel(key) }
            }
        )) {
            if store.selectedModelKey == nil {
                Text("Select Model").tag(Optional<LinkModelKey>.none)
            }
            if let current = store.currentModel, !store.availableModels.contains(where: { $0.key == current.key }) {
                Text(current.name ?? current.id).tag(Optional(current.key))
            }
            ForEach(store.availableModels, id: \.key) { model in
                Text("\(model.name ?? model.id) — \(model.provider)")
                    .tag(Optional(model.key))
            }
        }
        .pickerStyle(.menu)
        .disabled(!store.canSelectModel)
        .help(store.canSelectModel ? "Choose a model" : "Model selection requires control of the session")
    }

    private var thinkingPicker: some View {
        Picker("Thinking", selection: Binding<String?>(
            get: { store.live?.thinking },
            set: { level in
                guard let level, level != store.live?.thinking, store.canMutate,
                      store.live?.thinkingLevels?.contains(level) == true else { return }
                Task { await store.mutate("setThinkingLevel", args: [.string(level)]) }
            }
        )) {
            if store.live?.thinking == nil {
                Text("Not available").tag(Optional<String>.none)
            }
            if let current = store.live?.thinking, store.live?.thinkingLevels?.contains(current) != true {
                Text(current.capitalized).tag(Optional(current))
            }
            ForEach(store.live?.thinkingLevels ?? [], id: \.self) { level in
                Text(level.capitalized).tag(Optional(level))
            }
        }
        .pickerStyle(.menu)
        .disabled(!store.canMutate || (store.live?.thinkingLevels?.isEmpty ?? true))
    }
}

#Preview("Session settings") {
    SessionSettingsView()
        .environmentObject(PreviewFixtures.daemonStore())
}
#endif
