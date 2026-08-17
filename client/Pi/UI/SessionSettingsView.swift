import SwiftUI
#if os(macOS)

struct SessionSettingsView: View {
    @EnvironmentObject private var store: DaemonSessionStore
    @AppStorage("experimentalNativeTranscript") private var experimentalNativeTranscript = false
    var sessionID: String?
    @State private var nameDraft = ""
    @State private var submittingName = false
    @State private var nameOperationID: String?

    private var targetSessionID: String? { sessionID ?? store.selectedID }
    private var nameOperation: LinkOperation? {
        guard let targetSessionID, let nameOperationID else { return nil }
        return store.windowOperations(for: targetSessionID).first { $0.operationId == nameOperationID }
    }

    private var live: LinkLive? {
        sessionID == nil ? store.live : store.windowPresentation(for: sessionID!)?.live
    }
    private var availableModels: [LinkModel] { live?.selectableModels ?? [] }
    private var currentModel: LinkModel? { live?.model }
    private var canMutate: Bool {
        sessionID == nil ? store.canMutate : store.windowPresentation(for: sessionID!)?.canMutate == true
    }

    var body: some View {
        Form {
            nameEditor
            modelPicker
            thinkingPicker
            Toggle("Experimental native transcript", isOn: $experimentalNativeTranscript)
                .help("Try the native collection renderer. Turn off to restore the original transcript immediately. Includes experimental reading-position preservation and bottom-follow; scrolling or selecting yields to you.")
        }
        .formStyle(.columns)
        .padding(20)
        .frame(width: 360)
        .onAppear { nameDraft = live?.sessionName ?? "" }
        .onChange(of: targetSessionID) { _, _ in
            nameDraft = live?.sessionName ?? ""
            nameOperationID = nil
        }
        .onChange(of: live?.sessionName) { _, name in nameDraft = name ?? "" }
        .onChange(of: nameOperation?.status) { _, status in
            if status == "completed" {
                nameDraft = live?.sessionName ?? ""
                nameOperationID = nil
            } else if status == "failed" {
                nameOperationID = nil
            }
        }
    }

    private var nameEditor: some View {
        TextField("Session name", text: $nameDraft)
            .onSubmit { renameSession() }
            .disabled(!canMutate || submittingName || nameOperationID != nil)
            .help(canMutate ? "Press Return to rename this session. An empty name clears its title." : "Take control to rename this session")
    }

    private func renameSession() {
        guard canMutate, !submittingName, nameOperationID == nil,
              nameDraft != (live?.sessionName ?? ""), let target = targetSessionID else { return }
        let name = nameDraft
        submittingName = true
        Task {
            let operation = await store.requestSessionName(name, for: target)
            submittingName = false
            guard targetSessionID == target else { return }
            nameOperationID = operation
            // The terminal frame can precede the HTTP admission response.
            if nameOperation?.status == "completed" {
                nameDraft = live?.sessionName ?? ""
                nameOperationID = nil
            } else if nameOperation?.status == "failed" {
                nameOperationID = nil
            }
        }
    }

    private var modelPicker: some View {
        Picker("Model", selection: Binding<LinkModelKey?>(
            get: { currentModel?.key },
            set: { key in
                guard let key, key != currentModel?.key, canMutate,
                      availableModels.contains(where: { $0.key == key }) else { return }
                Task {
                    if let sessionID { await store.selectModel(key, for: sessionID) }
                    else { await store.selectModel(key) }
                }
            }
        )) {
            if currentModel?.key == nil {
                Text("Select Model").tag(Optional<LinkModelKey>.none)
            }
            if let current = currentModel, !availableModels.contains(where: { $0.key == current.key }) {
                Text("\(current.name ?? current.id) — \(current.provider)")
                    .tag(Optional(current.key))
                    .disabled(true)
            }
            ForEach(availableModels, id: \.key) { model in
                Text("\(model.name ?? model.id) — \(model.provider)")
                    .tag(Optional(model.key))
            }
        }
        .pickerStyle(.menu)
        .disabled(!canMutate || availableModels.isEmpty)
        .help(!canMutate ? "Take control to change models" : availableModels.isEmpty ? "No models are available" : "Choose a model")
    }

    private var thinkingPicker: some View {
        Picker("Thinking", selection: Binding<String?>(
            get: { live?.thinking },
            set: { level in
                guard let level, level != live?.thinking, canMutate,
                      live?.thinkingLevels?.contains(level) == true else { return }
                Task {
                    if let sessionID { await store.mutate("setThinkingLevel", args: [.string(level)], for: sessionID) }
                    else { await store.mutate("setThinkingLevel", args: [.string(level)]) }
                }
            }
        )) {
            if live?.thinking == nil {
                Text("Not available").tag(Optional<String>.none)
            }
            if let current = live?.thinking, live?.thinkingLevels?.contains(current) != true {
                Text(current.capitalized).tag(Optional(current))
            }
            ForEach(live?.thinkingLevels ?? [], id: \.self) { level in
                Text(level.capitalized).tag(Optional(level))
            }
        }
        .pickerStyle(.menu)
        .disabled(!canMutate || (live?.thinkingLevels?.isEmpty ?? true))
    }
}

#Preview("Session settings") {
    SessionSettingsView()
        .environmentObject(PreviewFixtures.daemonStore())
}
#endif
