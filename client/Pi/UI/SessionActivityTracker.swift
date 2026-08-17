import Foundation

nonisolated struct LinkSessionActivity: Decodable, Sendable, Equatable {
    let sessionId: String
    let ownerIncarnation: String
    let revision: Int
    let working: Bool?
    let messageCount: Int
    let contentRevision: Int
    let removed: Bool?
}

nonisolated struct LinkActivitySubscription: Decodable, Sendable {
    let subscriptionId: String
    let activities: [LinkSessionActivity]
}

/// Small observation/read markers only. No transcript or session runtime is retained here.
nonisolated struct SessionActivityTracker: Equatable {
    private(set) var activities: [String: LinkSessionActivity] = [:]
    private(set) var unread: Set<String> = []
    private var seen: [String: Int] = [:]
    private var seenMessageCounts: [String: Int] = [:]
    private var retired: [String: Set<String>] = [:]

    mutating func install(_ baseline: [LinkSessionActivity], viewed: String?) {
        self = Self()
        for activity in baseline { apply(activity, baseline: true, viewed: viewed) }
    }

    mutating func viewed(_ id: String, messageCount: Int? = nil) {
        unread.remove(id)
        if let messageCount { seenMessageCounts[id] = messageCount }
        if let activity = activities[id] { seen[id] = activity.contentRevision }
    }

    mutating func apply(_ activity: LinkSessionActivity, baseline: Bool, viewed: String?) {
        let id = activity.sessionId
        guard activity.revision >= 0, activity.messageCount >= 0, activity.contentRevision >= 0,
              retired[id]?.contains(activity.ownerIncarnation) != true else { return }
        let previous = activities[id]
        if let previous, previous.ownerIncarnation == activity.ownerIncarnation {
            guard activity.revision > previous.revision else { return }
        } else {
            // Only an explicitly announced owner can replace the observed incarnation.
            guard baseline else { return }
            if let previous {
                retired[id, default: []].insert(previous.ownerIncarnation)
                seenMessageCounts.removeValue(forKey: id)
            }
            seen[id] = activity.contentRevision
            unread.remove(id)
        }
        activities[id] = activity
        guard activity.removed != true else { return } // Loss of a worker is not an idle transition.
        // The canonical append may have been displayed before this independent
        // metadata stream catches up, even if the user has since switched rows.
        if id == viewed || (seenMessageCounts[id].map { activity.messageCount <= $0 } ?? false) {
            self.viewed(id)
        } else if activity.working == false, activity.contentRevision > (seen[id] ?? activity.contentRevision) {
            unread.insert(id)
        }
    }
}
