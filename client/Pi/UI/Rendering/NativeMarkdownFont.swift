#if os(macOS)
import AppKit
import SwiftUI

@MainActor enum NativeMarkdownFont {
    nonisolated struct LineMetrics { let height: CGFloat; let ascent: CGFloat }
    private struct Key: Equatable {
        let font: Font
        let resolved: Font.Resolved
        let context: Font.Context
        let scale: CGFloat
        let lineHeight: AttributedString.LineHeight?
    }
    // Font/context hashes were unstable across hosting environments in the
    // geometry probe. Compare these public values exactly, with a bounded cache.
    private static var metrics: [(key: Key, value: LineMetrics)] = []
    @MainActor private final class Result { var metrics: LineMetrics? }
    private nonisolated struct Measure: TextRenderer {
        let result: Result
        func draw(layout: Text.Layout, in context: inout GraphicsContext) {
            guard let first = layout.first else { return }
            let bounds = first.typographicBounds
            let value = LineMetrics(height: bounds.rect.height, ascent: bounds.ascent)
            MainActor.assumeIsolated { result.metrics = value }
        }
    }
    static func resolve(_ font: Font, context: Font.Context) -> NSFont {
        // Preserve semantic text-style metrics, features, variation, and cascades.
        // Reconstructing every resolved face from CGFont loses those metrics.
        unsafeBitCast(font.resolve(in: context).ctFont, to: NSFont.self)
    }
    static func firstLine(_ font: Font, environment: EnvironmentValues) -> LineMetrics {
        let key = Key(font: font, resolved: font.resolve(in: environment.fontResolutionContext),
                      context: environment.fontResolutionContext, scale: environment.displayScale,
                      lineHeight: environment.lineHeight)
        if let value = metrics.first(where: { $0.key == key }) { return value.value }
        // SwiftUI can impose a first-line minimum beyond the resolved CTFont's
        // metrics. Public TextRenderer also resolves opaque LineHeight values.
        // Retain scalar metrics, never a hosting view or EnvironmentValues graph.
        let result = Result()
        let image = ImageRenderer(content: Text(" ").font(font).unredacted()
            .textRenderer(Measure(result: result)).fixedSize().padding(1).environment(\.self, environment))
        image.scale = max(1, environment.displayScale)
        _ = image.cgImage
        guard let value = result.metrics else { preconditionFailure("A resolved font must provide space-line metrics") }
        if metrics.count == 128 { metrics.removeFirst() }
        metrics.append((key, value))
        return value
    }
}
#endif
