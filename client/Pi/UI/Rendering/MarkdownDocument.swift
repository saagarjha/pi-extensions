import Foundation

/// A small shared Markdown grammar. Each source is parsed completely; unfinished
/// syntax is not treated as an immutable prefix or as a malformed final message.
nonisolated struct MarkdownDocument: Equatable, Sendable {
    enum Alignment: Equatable, Sendable { case left, center, right }
    struct Table: Equatable, Sendable {
        let header: [String]
        let alignment: [Alignment]
        let rows: [[String]]
        var columnCount: Int { max(header.count, rows.map(\.count).max() ?? 0) }
        var allRows: [[String]] { [header] + rows }
        func alignment(at index: Int) -> Alignment { index < alignment.count ? alignment[index] : .left }
    }
    struct Image: Equatable, Sendable {
        let alt: String
        let destination: String
        let title: String?
        var isComplete = true
    }
    enum Block: Equatable, Sendable {
        case paragraph(String)
        case heading(String, Int)
        case bullet(String)
        case quote(String)
        case code(String, String)
        case table(Table)
        case image(Image)
    }

    let source: String
    let blocks: [Block]

    init(_ source: String) {
        self.source = source
        var result: [Block] = [], paragraph: [String] = [], code: [String] = []
        var language: String?
        let lines = source.components(separatedBy: "\n")
        var index = 0
        func flushParagraph() {
            if !paragraph.isEmpty {
                result.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph.removeAll()
            }
        }
        while index < lines.count {
            let line = lines[index]
            if line.hasPrefix("```") {
                flushParagraph()
                if let currentLanguage = language {
                    result.append(.code(code.joined(separator: "\n"), currentLanguage))
                    code.removeAll(); language = nil
                } else { language = String(line.dropFirst(3)) }
            } else if language != nil {
                code.append(line)
            } else if index + 1 < lines.count,
                      let header = Self.tableRow(line, requirePipe: true), header.count <= 32,
                      let separator = Self.tableAlignment(lines[index + 1]), separator.count == header.count {
                flushParagraph()
                var rows: [[String]] = []
                index += 2
                while index < lines.count, rows.count < 256,
                      !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                      !Self.interruptsTable(lines[index]),
                      let cells = Self.tableRow(lines[index], requirePipe: false), cells.count <= 32 {
                    rows.append(cells); index += 1
                }
                result.append(.table(Table(header: header, alignment: separator, rows: rows)))
                continue
            } else if line.isEmpty {
                flushParagraph()
            } else if line.hasPrefix("#") {
                let level = line.prefix(while: { $0 == "#" }).count
                if level <= 6, line.dropFirst(level).hasPrefix(" ") {
                    flushParagraph(); result.append(.heading(String(line.dropFirst(level + 1)), level))
                } else { paragraph.append(line) }
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                flushParagraph(); result.append(.bullet(String(line.dropFirst(2))))
            } else if line.hasPrefix("> ") {
                flushParagraph(); result.append(.quote(String(line.dropFirst(2))))
            } else if let fragments = Self.imageBlocks(line) {
                for fragment in fragments {
                    if case .paragraph(let text) = fragment { paragraph.append(text) }
                    else { flushParagraph(); result.append(fragment) }
                }
            } else { paragraph.append(line) }
            index += 1
        }
        flushParagraph()
        if let language { result.append(.code(code.joined(separator: "\n"), language)) }
        blocks = result
    }

    private static func interruptsTable(_ line: String) -> Bool {
        if line.hasPrefix("```") || line.hasPrefix("> ") || line.hasPrefix("- ") || line.hasPrefix("* ") { return true }
        let level = line.prefix(while: { $0 == "#" }).count
        return (1...6).contains(level) && line.dropFirst(level).hasPrefix(" ")
    }

    /// Pipes escaped with a backslash or inside code spans are cell content.
    /// Incomplete body rows are valid partial rows; missing cells remain empty.
    private static func tableRow(_ source: String, requirePipe: Bool) -> [String]? {
        // Most prose (and potentially large data URIs) contains no pipe. Avoid
        // materializing a Character array merely to rule out a table header.
        if requirePipe, !source.utf8.contains(124) { return nil }
        let value = source.trimmingCharacters(in: .whitespaces)
        let characters = Array(value)
        var cells: [String] = [], cell = "", index = 0, codeTicks = 0, separators: [Int] = []
        while index < characters.count {
            let character = characters[index]
            if character == "\\", index + 1 < characters.count {
                cell.append(character); cell.append(characters[index + 1]); index += 2; continue
            }
            if character == "`" {
                var end = index + 1
                while end < characters.count, characters[end] == "`" { end += 1 }
                let count = end - index
                if codeTicks == 0 { codeTicks = count } else if codeTicks == count { codeTicks = 0 }
                cell += String(repeating: "`", count: count); index = end; continue
            }
            if character == "|", codeTicks == 0 {
                cells.append(cell.trimmingCharacters(in: .whitespaces)); cell = ""; separators.append(index)
            } else { cell.append(character) }
            index += 1
        }
        if requirePipe, separators.isEmpty { return nil }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        if separators.last == characters.count - 1 { cells.removeLast() }
        if separators.first == 0, !cells.isEmpty { cells.removeFirst() }
        return cells.isEmpty ? nil : cells
    }
    private static func tableAlignment(_ line: String) -> [Alignment]? {
        guard line.allSatisfy({ $0 == "-" || $0 == ":" || $0 == "|" || $0.isWhitespace }) else { return nil }
        guard let cells = tableRow(line, requirePipe: false) else { return nil }
        var result: [Alignment] = []
        for cell in cells {
            var body = cell
            let left = body.hasPrefix(":"), right = body.hasSuffix(":")
            if left { body.removeFirst() }
            if right, !body.isEmpty { body.removeLast() }
            guard body.count >= 3, body.allSatisfy({ $0 == "-" }) else { return nil }
            result.append(left && right ? .center : right ? .right : .left)
        }
        return result
    }

    /// Images in ordinary prose are block-sized, retaining surrounding prose.
    /// In particular, adding prose after a completed image must not erase it.
    /// Code spans and ordinary link destinations are not image syntax.
    private static func imageBlocks(_ line: String) -> [Block]? {
        guard line.contains("![") else { return nil }
        var result: [Block] = [], start = line.startIndex, cursor = start
        var ticks = 0, destinationDepth = 0
        while cursor < line.endIndex {
            let character = line[cursor], next = line.index(after: cursor)
            if character == "\\", next < line.endIndex { cursor = line.index(after: next); continue }
            if character == "`" {
                var end = next
                while end < line.endIndex, line[end] == "`" { end = line.index(after: end) }
                let count = line.distance(from: cursor, to: end)
                if ticks == 0 { ticks = count } else if ticks == count { ticks = 0 }
                cursor = end; continue
            }
            if ticks == 0 {
                if character == "(", destinationDepth > 0 || (cursor > line.startIndex && line[line.index(before: cursor)] == "]") { destinationDepth += 1 }
                if character == ")", destinationDepth > 0 { destinationDepth -= 1 }
                if destinationDepth == 0, character == "!", let (image, remainder) = Self.image(line[cursor...]) {
                    let before = String(line[start..<cursor])
                    if !before.trimmingCharacters(in: .whitespaces).isEmpty { result.append(.paragraph(before)) }
                    result.append(.image(image)); cursor = remainder.startIndex; start = cursor; continue
                }
            }
            cursor = next
        }
        guard !result.isEmpty else { return nil }
        let remainder = String(line[start...])
        if !remainder.trimmingCharacters(in: .whitespaces).isEmpty { result.append(.paragraph(remainder)) }
        return result
    }

    /// Decode only after balanced syntax closes; pending references retain their
    /// alt text without exposing or repeatedly decoding a growing base64 string.
    /// Reference-style/HTML images remain outside this deliberately small grammar.
    private static let escapable = Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
    private static func image(_ value: Substring) -> (Image, Substring)? {
        guard value.hasPrefix("![") else { return nil }
        var cursor = value.index(value.startIndex, offsetBy: 2), altSource = "", escaped = false, brackets = 0
        while cursor < value.endIndex {
            let character = value[cursor]
            if !escaped, character == "]" { if brackets == 0 { break }; brackets -= 1 }
            if !escaped, character == "[" { brackets += 1 }
            altSource.append(character)
            if !escaped, character == "\\" { escaped = true } else { escaped = false }
            cursor = value.index(after: cursor)
        }
        guard cursor < value.endIndex else { return nil }
        let alt = (try? AttributedString(markdown: altSource, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            .map { String($0.characters) } ?? altSource
        cursor = value.index(after: cursor)
        guard cursor < value.endIndex, value[cursor] == "(" else { return nil }
        var depth = 1, quote: Character?, inAngle = false, escapedDestination = false
        var close: String.Index?
        var previous: Character = "("
        for position in value[value.index(after: cursor)...].indices {
            let character = value[position]
            defer { previous = character }
            if escapedDestination { escapedDestination = false; continue }
            if character == "\\" { escapedDestination = true; continue }
            if let current = quote { if character == current { quote = nil }; continue }
            if inAngle { if character == ">" { inAngle = false }; continue }
            if character == "<" { inAngle = true; continue }
            if (character == "\"" || character == "'"), previous.isWhitespace { quote = character; continue }
            if character == "(" { depth += 1 }
            if character == ")" {
                depth -= 1
                if depth == 0 { close = position; break }
            }
        }
        guard let close else { return (Image(alt: alt, destination: "", title: nil, isComplete: false), value[value.endIndex...]) }
        let inside = value[value.index(after: cursor)..<close].trimmingCharacters(in: .whitespaces)
        if inside.isEmpty { return (Image(alt: alt, destination: "", title: nil), value[value.index(after: close)...]) }
        var destination = "", remainder = ""
        if inside.hasPrefix("<") {
            guard let close = inside.firstIndex(of: ">") else { return nil }
            destination = String(inside[inside.index(after: inside.startIndex)..<close])
            remainder = String(inside[inside.index(after: close)...]).trimmingCharacters(in: .whitespaces)
        } else {
            var depth = 0, escaped = false, end = inside.endIndex
            for position in inside.indices {
                let character = inside[position]
                if escaped {
                    if !escapable.contains(character) { destination.append("\\") }
                    destination.append(character); escaped = false; continue
                }
                if character == "\\" { escaped = true; continue }
                if character.isWhitespace, depth == 0 { end = position; break }
                if character == "(" { depth += 1 }
                if character == ")" { depth -= 1; if depth < 0 { return nil } }
                destination.append(character)
            }
            guard depth == 0, !escaped else { return nil }
            remainder = String(inside[end...]).trimmingCharacters(in: .whitespaces)
        }
        var title: String?
        if !remainder.isEmpty {
            guard let first = remainder.first, first == "\"" || first == "'",
                  remainder.count >= 2, remainder.last == first else { return nil }
            title = String(remainder.dropFirst().dropLast())
        }
        return (Image(alt: alt, destination: destination, title: title), value[value.index(after: close)...])
    }
}
