import Foundation
import CoreGraphics


/// Immutable user-authorized image data. Keep the original bytes for retries;
/// the CGImage is decoded once for the attachment preview, not submitted.
nonisolated struct ComposerImage: Identifiable, @unchecked Sendable {
    let id: UUID
    let data: Data
    let base64: String
    let mimeType: String
    let thumbnail: CGImage

    var wire: LinkJSON { .object([
        "type": .string("image"), "data": .string(base64),
        "mimeType": .string(mimeType)
    ]) }
    var nativePart: SessionMessage.Part {
        .image(ImageContent(data: base64, mimeType: mimeType))
    }
}

#if os(macOS)
import AppKit
import ImageIO
import UniformTypeIdentifiers
import SwiftUI

@MainActor enum ComposerImageInput {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func prepare(_ bytes: Data, mimeType: String) throws -> ComposerImage {
        let decoded: MarkdownImages.Decoded
        switch MarkdownImages.resolve(base64: bytes.base64EncodedString(), mimeType: mimeType) {
        case .image(let image): decoded = image
        case .unavailable(let reason): throw Failure(message: reason)
        }
        // The thumbnail is display-only. The SDK receives the original decoded
        // bytes and MIME and owns conversion/normalization for the selected model.
        return ComposerImage(id: UUID(), data: decoded.data, base64: decoded.data.base64EncodedString(),
                             mimeType: decoded.mimeType, thumbnail: decoded.image)
    }

    static func append(_ incoming: [ComposerImage], to existing: [ComposerImage]) throws -> [ComposerImage] {
        existing + incoming
    }

    static func hasPastedImages() -> Bool {
        NSPasteboard.general.types?.contains(where: { type in
            if type == .fileURL { return true }
            guard let imageType = UTType(type.rawValue) else { return false }
            return imageType.conforms(to: .image) && imageType.preferredMIMEType != nil
        }) == true
    }

    static func pastedImages() throws -> [ComposerImage]? {
        let pasteboard = NSPasteboard.general
        if let files = pasteboard.readObjects(forClasses: [NSURL.self],
                                             options: [.urlReadingFileURLsOnly: true]) as? [URL], !files.isEmpty {
            return try files.map { try file($0) }
        }
        for type in pasteboard.types ?? [] {
            guard let imageType = UTType(type.rawValue), imageType.conforms(to: .image),
                  let mime = imageType.preferredMIMEType,
                  let bytes = pasteboard.data(forType: type) else { continue }
            return [try prepare(bytes, mimeType: mime)]
        }
        return nil // Text paste stays with the native field editor.
    }

    static func file(_ url: URL) throws -> ComposerImage {
        guard url.isFileURL else { throw Failure(message: "Only a dropped local image file can be attached.") }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw Failure(message: "Drop a regular image file, not a link or folder.")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.readToEnd() ?? Data()
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let type = CGImageSourceGetType(source),
              let mime = UTType(type as String)?.preferredMIMEType else {
            throw Failure(message: "This image could not be decoded on this device.")
        }
        return try prepare(data, mimeType: mime)
    }

    static func droppedFileURL(_ provider: NSItemProvider) async throws -> URL {
        if provider.canLoadObject(ofClass: NSURL.self) {
            do {
                let url: URL = try await withCheckedThrowingContinuation { continuation in
                    _ = provider.loadObject(ofClass: NSURL.self) { object, error in
                        if let error { continuation.resume(throwing: error); return }
                        guard let url = object as? URL, url.isFileURL else {
                            continuation.resume(throwing: Failure(message: "Drop an image file.")); return
                        }
                        continuation.resume(returning: url)
                    }
                }
                return url
            } catch {
                // Some legacy NSString registrations advertise NSURL but cannot decode it.
                // Retry URL data, including securely archived legacy NSString values.
            }
        }
        // Preserve UTF-8 URL data and securely archived legacy NSString representations.
        return try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, error in
                if let error { continuation.resume(throwing: error); return }
                guard let data, let text = String(data: data, encoding: .utf8) ??
                        (try? NSKeyedUnarchiver.unarchivedObject(ofClass: NSString.self, from: data)) as String?,
                      let url = URL(string: text), url.isFileURL else {
                    continuation.resume(throwing: Failure(message: "Drop an image file.")); return
                }
                continuation.resume(returning: url)
            }
        }
    }

    static func dropped(_ providers: [NSItemProvider]) async throws -> [ComposerImage] {
        guard !providers.isEmpty else { return [] }
        var images: [ComposerImage] = []
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                let url = try await droppedFileURL(provider)
                images.append(try file(url))
                continue
            }
            guard let identifier = provider.registeredTypeIdentifiers.first(where: {
                guard let type = UTType($0) else { return false }
                return type.conforms(to: .image) && type.preferredMIMEType != nil
            }) else { throw Failure(message: "Unsupported or unidentified image format.") }
            let bytes: Data = try await withCheckedThrowingContinuation { continuation in
                _ = provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
                    do {
                        if let error { throw error }
                        guard let url else { throw Failure(message: "No image data was provided.") }
                        let handle = try FileHandle(forReadingFrom: url)
                        defer { try? handle.close() }
                        continuation.resume(returning: try handle.readToEnd() ?? Data())
                    } catch { continuation.resume(throwing: error) }
                }
            }
            images.append(try prepare(bytes, mimeType: UTType(identifier)!.preferredMIMEType!))
        }
        return images
    }
}
#endif
