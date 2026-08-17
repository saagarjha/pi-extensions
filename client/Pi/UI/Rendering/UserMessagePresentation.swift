import Foundation

/// Bounded visual matching, never delivery acknowledgement or native identity.
/// Register synchronously on submission, not on first render: SwiftUI may skip
/// intermediate outbox states. Retired claims still reserve their matching saved
/// copy so an identical later submission cannot claim it a second time.
@MainActor final class UserMessagePresentation {
    nonisolated struct Window: Sendable, Equatable {
        let presentation: UserMessagePresentation
        let id: String
        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.presentation === rhs.presentation && lhs.id == rhs.id
        }
    }
    private struct Slot {
        let id: String
        let parts: [SessionMessage.Part]
        let checkpoint: SessionMessage.CommittedContent.ArrivalCheckpoint
        let previousPartial: SessionMessage?
        let expires: ContinuousClock.Instant
        var savedID: String?
        var observedLive = false
    }
    private struct Claim { let id: String; let index: Int }
    private var slots: [Slot] = []
    private var claims: [Claim] = []
    private var ownerIncarnation: String?
    private var lineage: UUID?
    private var suspendedUntil: ContinuousClock.Instant?
    private var expiryTask: Task<Void, Never>?
    private let retire: (Set<String>) -> Void
    init(retire: @escaping (Set<String>) -> Void = { _ in }) { self.retire = retire }
    deinit { expiryTask?.cancel() }
    /// Store mutation must not occur during SwiftUI's presentation read.
    private func requestRetirement(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        Task { [retire] in retire(ids) }
    }
    func retains(_ id: String) -> Bool { slots.contains { $0.id == id && $0.savedID == nil } }
    func retired(_ ids: Set<String>) {
        guard slots.contains(where: { ids.contains($0.id) }) else { return }
        slots.removeAll { ids.contains($0.id) }
        // A completed input's old deadline must not abandon a newer input.
        // Saved claims remain bounded below and still reserve their copies.
        expiryTask?.cancel(); expiryTask = nil
        scheduleExpiry()
    }
    private func scheduleExpiry() {
        guard expiryTask == nil, let expires = slots.first?.expires else { return }
        expiryTask = Task { [weak self] in
            do { try await Task.sleep(until: expires, clock: .continuous) }
            catch { return }
            guard !Task.isCancelled else { return }
            self?.clear()
        }
    }
    private func clear() {
        expiryTask?.cancel(); expiryTask = nil
        requestRetirement(Set(slots.map(\.id)))
        slots.removeAll(); claims.removeAll()
    }
    private static let limit = 64
    private static let lifetime: Duration = .seconds(60)

    func register(_ submission: UserSubmission, in transcript: SessionMessage.Transcript,
                  now: ContinuousClock.Instant = .now) -> Window? {
        if ownerIncarnation != submission.ownerIncarnation {
            clear(); suspendedUntil = nil
            ownerIncarnation = submission.ownerIncarnation
        }
        prune(transcript, now: now)
        guard suspendedUntil == nil else { return nil }
        // Too many overlapping admissions are ambiguous. Prefer a duplicate over
        // donating an evicted slot's server copy to another identical input.
        guard slots.count < Self.limit else {
            clear()
            suspendedUntil = now.advanced(by: Self.lifetime)
            return nil
        }
        slots.append(Slot(id: submission.id, parts: submission.message.parts,
            checkpoint: transcript.committed.arrivalCheckpoint,
            previousPartial: transcript.partial?.isUser == true ? transcript.partial : nil,
            expires: now.advanced(by: Self.lifetime)))
        // An inactive panel must not retain admitted input text indefinitely.
        scheduleExpiry()
        return Window(presentation: self, id: submission.id)
    }

    private func prune(_ transcript: SessionMessage.Transcript, now: ContinuousClock.Instant) {
        let checkpoint = transcript.committed.arrivalCheckpoint
        if lineage != checkpoint.lineage {
            clear(); lineage = checkpoint.lineage
        }
        if let until = suspendedUntil, now >= until { suspendedUntil = nil }
        if slots.contains(where: { $0.expires <= now || transcript.committed.arrivals(since: $0.checkpoint, limit: Self.limit) == nil }) {
            // Do not let a remaining overlapping slot inherit an expired slot's
            // as-yet-unmatched copy. Abandon this cohort rather than guess.
            clear()
        }
        claims.removeAll {
            $0.index < checkpoint.count - Self.limit || $0.index >= checkpoint.count ||
                transcript.committed.messages[$0.index].id != $0.id
        }
    }

    private struct Observations {
        var hidden = Set<String>()
        var live = Set<String>()
        var hidesPartial = false
    }
    private func observations(in transcript: SessionMessage.Transcript,
                              now: ContinuousClock.Instant) -> Observations {
        prune(transcript, now: now)
        guard suspendedUntil == nil else { return Observations() }
        var claimed = Set(claims.map(\.id))
        var partialAvailable = transcript.partial.map(Self.isHumanObservation) == true
        var result = Observations()
        for index in slots.indices {
            if slots[index].observedLive { result.live.insert(slots[index].id) }
            if let saved = slots[index].savedID, claimed.contains(saved) {
                result.hidden.insert(slots[index].id)
                continue
            }
            guard let arrivals = transcript.committed.arrivals(since: slots[index].checkpoint, limit: Self.limit) else { continue }
            if let savedIndex = arrivals.first(where: {
                let message = transcript.committed.messages[$0]
                return !claimed.contains(message.id) && Self.isHumanObservation(message) &&
                    message.parts == slots[index].parts && !Self.preexisting(message, slot: slots[index])
            }) {
                let saved = transcript.committed.messages[savedIndex].id
                slots[index].savedID = saved
                claims.append(Claim(id: saved, index: savedIndex)); claimed.insert(saved)
                result.hidden.insert(slots[index].id)
                requestRetirement([slots[index].id])
            } else if partialAvailable, let partial = transcript.partial,
                      partial.parts == slots[index].parts, !Self.preexisting(partial, slot: slots[index]) {
                partialAvailable = false
                slots[index].observedLive = true
                result.live.insert(slots[index].id)
                // Keep the local bubble across ephemeral user observations. A
                // live partial disappearing is not a canonical replacement.
                result.hidesPartial = true
            }
        }
        return result
    }

    private static func isHumanObservation(_ message: SessionMessage) -> Bool {
        message.isUser && (message.author == "You" || message.author == "You (live observation)")
    }
    private static func preexisting(_ message: SessionMessage, slot: Slot) -> Bool {
        guard let previous = slot.previousPartial else { return false }
        return previous.observationHint == message.observationHint && previous.parts == message.parts
    }

    static func compose(_ transcript: SessionMessage.Transcript, queued: [SessionMessage],
                        local: [SessionMessage], now: ContinuousClock.Instant = .now) -> SessionMessage.Transcript {
        var partial = transcript.partial
        // Only the current saved tail, with matching observed timestamp/content.
        // Timestamp is a visual hint, not an ID; absent hints cannot prove overlap.
        if let live = partial, isHumanObservation(live), live.observationHint?.timestamp != nil,
           let saved = transcript.committed.messages.last, isHumanObservation(saved),
           saved.observationHint == live.observationHint, saved.parts == live.parts {
            partial = nil
        }
        let observed = SessionMessage.Transcript(committed: transcript.committed, partial: partial)
        var visited = Set<ObjectIdentifier>()
        var hidden = Set<String>()
        var live = Set<String>()
        for message in local {
            guard let window = message.submissionWindow,
                  visited.insert(ObjectIdentifier(window.presentation)).inserted else { continue }
            let result = window.presentation.observations(in: observed, now: now)
            hidden.formUnion(result.hidden); live.formUnion(result.live)
            if result.hidesPartial { partial = nil }
        }
        let pending = local.filter { message in
            guard let window = message.submissionWindow, message.localSubmission != nil else { return true }
            if case .failed = message.localSubmission { return true }
            return !hidden.contains(window.id)
        }.map { message in
            var message = message
            if let id = message.submissionWindow?.id, live.contains(id) { message.submissionMode = .prompt }
            return message
        }
        let prompts = pending.filter { $0.submissionMode == .prompt }
        let queuedLocals = pending.filter { $0.submissionMode != .prompt }
        var placed = Set<String>()
        // Substitute only an admitted queued local in the corresponding raw
        // queue projection, one-for-one and in queue order. This cannot prove
        // consumption; canonical overlap still requires every part exactly.
        let queue = queued.map { row in
            guard let projection = row.queuePresentation,
                  let local = queuedLocals.first(where: {
                      !placed.contains($0.id) && $0.submissionMode == projection.mode &&
                      $0.submissionQueueCut.map { $0 <= projection.seq } == true &&
                      $0.parts.first == .text(projection.text)
                  }) else { return row }
            placed.insert(local.id)
            return local
        }
        return SessionMessage.Transcript(committed: transcript.committed, partial: partial,
                                         pending: prompts + queue + queuedLocals.filter { !placed.contains($0.id) })
    }
}
