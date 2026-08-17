import Foundation

/// Shared local outbox lifecycle. Target adapters own routing and authority;
/// this value never asserts which native transcript entry represents the input.
nonisolated struct UserSubmission: Identifiable, Sendable {
    enum Mode: Sendable, Equatable {
        case prompt, steering, followUp
        var command: String {
            switch self { case .prompt: "prompt"; case .steering: "steer"; case .followUp: "followUp" }
        }
        var author: String {
            switch self { case .prompt: "You"; case .steering: "Steering"; case .followUp: "Follow-up" }
        }
    }
    let id: String
    let text: String
    let images: [ComposerImage]
    let mode: Mode
    var state: SessionMessage.SubmissionState = .sending
    var operationID: String? = nil
    let ownerIncarnation: String
    var presentationWindow: UserMessagePresentation.Window? = nil
    var handoff: LinkOperation.Handoff? = nil

    init(id: String, text: String, images: [ComposerImage] = [], mode: Mode, ownerIncarnation: String) {
        self.id = id; self.text = text; self.images = images; self.mode = mode
        self.ownerIncarnation = ownerIncarnation
    }

    var parts: [SessionMessage.Part] { [.text(text)] + images.map(\.nativePart) }
    /// The daemon fingerprints the complete RPC arguments, including immutable
    /// image bytes. Retrying a submission never reloads a file or clipboard.
    var mutationArgs: [LinkJSON] {
        guard !images.isEmpty else { return [.string(text)] }
        let blocks = LinkJSON.array(images.map(\.wire))
        switch mode {
        case .prompt: return [.string(text), .object(["images": blocks])]
        case .steering, .followUp: return [.string(text), blocks]
        }
    }
    /// Root dispatch always uses native prompt so extension commands and
    /// streaming routing retain the same semantics as text-only submissions.
    func promptMutationArgs(streamingBehavior: String) -> [LinkJSON] {
        var options: [String: LinkJSON] = ["streamingBehavior": .string(streamingBehavior)]
        if !images.isEmpty { options["images"] = .array(images.map(\.wire)) }
        return [.string(text), .object(options)]
    }
    var message: SessionMessage {
        let displayMode: Mode = handoff?.disposition == .queued && mode == .prompt ? .steering : mode
        var value = SessionMessage(id: "local-submission:" + id, author: displayMode.author, text: text,
                                   isUser: true, parts: parts)
        value.localSubmission = state
        value.submissionMode = displayMode
        value.submissionQueueCut = handoff?.disposition == .queued ? handoff?.seq : nil
        value.submissionWindow = presentationWindow
        return value
    }

    mutating func receivedHandoff(_ value: LinkOperation.Handoff, operationID: String) {
        self.operationID = operationID
        handoff = value
        switch state {
        case .sending, .failed(_, retryable: true): state = .accepted
        default: break
        }
    }

    enum ReceiptEffect {
        case none, handoff(LinkOperation.Handoff), failure(String)
    }
    func receiptEffect(_ operation: LinkOperation) -> ReceiptEffect {
        guard operation.submissionId == id,
              operationID == nil || operationID == operation.operationId else { return .none }
        if let error = operation.error { return .failure(error) }
        if let handoff = operation.handoff { return .handoff(handoff) }
        return .none
    }

    /// Both target adapters use exactly the same acknowledgement and failure rules.
    /// A successful HTTP receipt is acceptance, not native-message identity or
    /// operation completion. An uncertain transport failure can retry the same ID.
    @MainActor static func dispatch(
        _ value: UserSubmission,
        request: () async throws -> LinkOperationAcceptance,
        update: (String, (inout UserSubmission) -> Void) -> Void,
        reconcile: (LinkOperation) -> Void
    ) async {
        do {
            let receipt = try await request()
            guard receipt.submissionId == value.id, receipt.ownerIncarnation == value.ownerIncarnation else {
                throw LinkFailure("Mismatched submission receipt", code: "SUBMISSION_RECEIPT_MISMATCH")
            }
            var matchesOperation = true
            update(value.id) { current in
                if let known = current.operationID, known != receipt.operationId {
                    matchesOperation = false
                    return
                }
                current.operationID = receipt.operationId
                if case .sending = current.state { current.state = .accepted }
            }
            guard matchesOperation else {
                throw LinkFailure("Mismatched submission operation receipt", code: "SUBMISSION_RECEIPT_MISMATCH")
            }
            if let operation = receipt.operation { reconcile(operation) }
        } catch {
            let code = (error as? LinkFailure)?.code
            let retryable = code == nil || code == "OUTCOME_UNCERTAIN"
            update(value.id) {
                // The independent SSE receipt already resolved transport
                // uncertainty. Losing HTTP cannot retract SDK admission.
                guard !retryable || $0.handoff == nil else { return }
                $0.state = .failed(error.localizedDescription, retryable: retryable)
            }
        }
    }
}
