import SwiftUI

/// Occupies the composer's existing bottom padding, not layout space.
struct ComposerContextCaption: View {
    let usage: LinkContextUsage?
    var statusFooterData: LinkStatusFooterData? = nil

    // Pi's percent / capacity presentation, using localized system formatting.
    private func tokens(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0 else { return "?" }
        return value.formatted(.number.notation(.compactName))
    }
    private var percent: Double? {
        guard let value = usage?.percent, value.isFinite, value >= 0 else { return nil }
        return value
    }
    private var label: String {
        let used = percent.map { ($0 / 100).formatted(.percent.precision(.fractionLength(1))) } ?? "?"
        return "\(used)/\(tokens(usage?.contextWindow))"
    }

    private func number(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "Unknown" }
        return value.formatted(.number.notation(.compactName))
    }
    private func percentage(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "Unknown" }
        return (value / 100).formatted(.percent.precision(.fractionLength(1)))
    }
    private func cost(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "Unknown" }
        return value.formatted(.currency(code: "USD").precision(.significantDigits(1...6)))
    }
    private var details: String {
        var lines = ["Context: \(number(usage?.tokens)) tokens"]
        if let data = statusFooterData {
            lines += ["Input: \(number(data.totals?.input)) · Output: \(number(data.totals?.output))",
                      "Cache read: \(number(data.totals?.cacheRead)) · Write: \(number(data.totals?.cacheWrite)) · Hit: \(percentage(data.latestCacheHitRate))",
                      "Cost: \(cost(data.totals?.cost))"]
        }
        return lines.joined(separator: "\n")
    }

    var body: some View {
        HStack(spacing: 4) {
            ZStack {
                Circle().stroke(.secondary.opacity(0.25), lineWidth: 1.25)
                if let percent {
                    Circle().trim(from: 0, to: min(percent / 100, 1))
                        .stroke(.secondary, style: StrokeStyle(lineWidth: 1.25, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
            }
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
            Text(label)
        }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .modifier(ComposerStatusMaterial())
            .help(details)
    }
}

struct ComposerStatusMaterial: ViewModifier {
    func body(content: Content) -> some View {
        content.background {
            Rectangle()
                .fill(.bar)
                .padding(.horizontal, -18)
                .padding(.vertical, -11)
                .mask {
                    Capsule()
                        .padding(.horizontal, -10)
                        .padding(.vertical, -3)
                        .blur(radius: 4)
                }
                .allowsHitTesting(false)
        }
    }
}
