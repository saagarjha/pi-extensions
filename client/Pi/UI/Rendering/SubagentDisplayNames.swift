import SwiftUI

/// Presentation-only lookup. Native tool arguments/history retain stable IDs;
/// a service summary supplies the human-readable name when a call is pending.
private struct SubagentDisplayNamesKey: EnvironmentKey {
    static let defaultValue: [String: String] = [:]
}

extension EnvironmentValues {
    var subagentDisplayNames: [String: String] {
        get { self[SubagentDisplayNamesKey.self] }
        set { self[SubagentDisplayNamesKey.self] = newValue }
    }
}
