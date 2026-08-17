import SwiftUI

struct CopyToolCallView: View {
    let call: ToolCall
    let result: NativeMessage?
    private var details: CopyDetails? { result?.details?.copyValue }

    private var arguments: CopyArguments? { call.arguments?.copyValue }

    private func endpoint(source: Bool) -> some View {
        let endpoint = source ? details?.source : details?.destination
        let path = endpoint?.path ?? endpoint?.requestedPath
            ?? (source ? arguments?.sourcePath : arguments?.destPath) ?? ""
        let target = endpoint?.target ?? (source ? arguments?.sourceTarget : arguments?.destTarget)
        let directory = details?.sourceIsDirectory
        return PathView(path: path, target: target, isDirectory: directory)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    endpoint(source: true)
                    Image(systemName: "arrow.right").foregroundStyle(.secondary)
                    endpoint(source: false)
                }
                VStack(alignment: .leading, spacing: 6) {
                    endpoint(source: true)
                    Image(systemName: "arrow.down").foregroundStyle(.secondary)
                    endpoint(source: false)
                }
            }
            if (details?.overwrite ?? arguments?.overwrite) == true {
                Text("Overwrite enabled").foregroundStyle(.secondary)
            }
            if details?.permissionFiltered == true {
                Text("Some paths were excluded due to permissions.").foregroundStyle(.secondary)
            }
        }
        .textSelection(.enabled)
    }
}
