import SwiftUI
import ImageIO
import CryptoKit
import UniformTypeIdentifiers

/// Only bytes already delivered to the client are decoded here. Markdown is not
/// permission to read the client's filesystem or contact an arbitrary URL.
@MainActor enum MarkdownImages {
    final class Decoded {
        let image: CGImage
        let data: Data
        let mimeType: String
        var size: CGSize { CGSize(width: image.width, height: image.height) }
        init(image: CGImage, data: Data, mimeType: String) {
            self.image = image; self.data = data; self.mimeType = mimeType
        }
    }
    enum Result { case image(Decoded), unavailable(String) }
    private final class Entry: NSObject {
        let result: Result
        init(_ result: Result) { self.result = result }
    }
    private static let cache: NSCache<NSString, Entry> = {
        let value = NSCache<NSString, Entry>()
        value.countLimit = 32; value.totalCostLimit = 64 * 1024 * 1024
        return value
    }()

    static func resolve(destination: String) -> Result {
        guard !destination.isEmpty else { return .unavailable("Image has no source.") }
        guard destination.prefix(5).lowercased() == "data:" else {
            if browserURL(destination) != nil {
                return .unavailable("Remote image not loaded automatically. Open the link to view it.")
            }
            if let scheme = URL(string: destination)?.scheme?.lowercased(), scheme != "file" {
                return .unavailable(["http", "https"].contains(scheme) ? "Invalid remote image URL." : "Unsupported image URL scheme.")
            }
            return .unavailable("Local image resources require an authorized resource loader.")
        }
        guard let comma = destination.firstIndex(of: ",") else { return .unavailable("Incomplete image data URI.") }
        let header = destination[destination.index(destination.startIndex, offsetBy: 5)..<comma].split(separator: ";", omittingEmptySubsequences: false)
        guard header.count == 2, header[1].lowercased() == "base64" else {
            return .unavailable("Only base64-encoded raster image data URIs are supported.")
        }
        return resolve(base64: String(destination[destination.index(after: comma)...]), mimeType: String(header[0]))
    }

    static func resolve(base64: String, mimeType: String) -> Result {
        let mime = mimeType.lowercased()
        guard let declared = UTType(mimeType: mime), declared.conforms(to: .image) else {
            return .unavailable("Unsupported image format: \(mimeType)")
        }
        var hash = SHA256()
        hash.update(data: Data(mime.utf8)); hash.update(data: Data(base64.utf8))
        let key = hash.finalize().map { String(format: "%02x", $0) }.joined() as NSString
        if let entry = cache.object(forKey: key) { return entry.result }
        func finish(_ result: Result, cost: Int = 1) -> Result {
            cache.setObject(Entry(result), forKey: key, cost: cost); return result
        }
        guard let data = Data(base64Encoded: base64), !data.isEmpty,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source), let actual = UTType(type as String),
              actual.conforms(to: declared) || declared.conforms(to: actual) else {
            return finish(.unavailable("Invalid image data or a format that does not match its MIME type."))
        }
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              width.isFinite, height.isFinite, width > 0, height > 0 else {
            return finish(.unavailable("This image has invalid dimensions."))
        }
        // Frame zero only, including GIF/WebP/HEIF. Apply EXIF orientation before
        // exposing pixels; never ask NSImage to lazily decode the original again.
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2048,
            kCGImageSourceShouldCacheImmediately: true]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              thumbnail.width > 0, thumbnail.height > 0, thumbnail.width <= 2048, thumbnail.height <= 2048,
              let color = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: thumbnail.width, height: thumbnail.height,
                  bitsPerComponent: 8, bytesPerRow: 0, space: color,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return finish(.unavailable("This image could not be decoded on this device."))
        }
        context.setBlendMode(.copy)
        context.draw(thumbnail, in: CGRect(x: 0, y: 0, width: thumbnail.width, height: thumbnail.height))
        guard let image = context.makeImage() else { return finish(.unavailable("Image conversion failed.")) }
        return finish(.image(Decoded(image: image, data: data, mimeType: mime)),
                      cost: data.count + image.bytesPerRow * image.height)
    }

    static func browserURL(_ destination: String) -> URL? {
        guard let url = URL(string: destination), let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme), url.host?.isEmpty == false else { return nil }
        return url
    }
}

/// Shared by Markdown data images and actual native image content blocks. No
/// AsyncImage/file reader: an unavailable resource stays an explicit placeholder.
struct MessageImageView: View {
    private enum Source { case destination(String), bytes(String, String), incomplete }
    private let source: Source
    private let alt: String
    init(base64: String, mimeType: String, alt: String = "Image") {
        source = .bytes(base64, mimeType); self.alt = alt
    }
    init(destination: String, alt: String, isComplete: Bool = true) {
        source = isComplete ? .destination(destination) : .incomplete; self.alt = alt
    }
    private var result: MarkdownImages.Result {
        switch source {
        case .destination(let destination): MarkdownImages.resolve(destination: destination)
        case .bytes(let data, let mime): MarkdownImages.resolve(base64: data, mimeType: mime)
        case .incomplete: .unavailable("Incomplete image reference.")
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch result {
            case .image(let decoded):
                Image(decoded.image, scale: 1, label: Text(alt.isEmpty ? "Image" : alt))
                    .resizable().aspectRatio(contentMode: .fit)
                    .frame(maxWidth: min(decoded.size.width, 640), maxHeight: 480, alignment: .leading)
                if !alt.isEmpty { Text(alt).font(.caption).foregroundStyle(.secondary) }
            case .unavailable(let reason):
                Label(alt.isEmpty ? "Image" : alt, systemImage: "photo")
                Text(reason).font(.caption).foregroundStyle(.secondary)
                if case .destination(let destination) = source, let url = MarkdownImages.browserURL(destination) {
                    Link("Open image in browser", destination: url).font(.caption)
                }
            }
        }
        .textSelection(.enabled)
    }
}

#if os(macOS)
import AppKit

@MainActor final class NativeMarkdownImageCell: NSTextAttachmentCell {
    let decoded: MarkdownImages.Decoded
    private var displaySize = NSSize.zero
    init(_ decoded: MarkdownImages.Decoded, width: CGFloat) {
        self.decoded = decoded
        super.init(imageCell: NSImage(cgImage: decoded.image, size: decoded.size))
        resize(width: width)
    }
    required init(coder: NSCoder) { fatalError("not used") }
    func resize(width: CGFloat) {
        let scale = min(1, min(min(640, max(1, width)) / decoded.size.width, 480 / decoded.size.height))
        displaySize = NSSize(width: decoded.size.width * scale, height: decoded.size.height * scale)
    }
    nonisolated override func cellSize() -> NSSize { MainActor.assumeIsolated { displaySize } }
    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        image?.draw(in: cellFrame, from: .zero, operation: .sourceOver, fraction: 1,
                    respectFlipped: true, hints: nil)
    }
}
#endif
