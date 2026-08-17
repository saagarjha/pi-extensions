import Foundation

/// The status extension's existing ownedFooter payload: the same memoized
/// totals/cache-hit reading consumed by the TUI, including its live child totals.
nonisolated struct LinkStatusFooterData: Decodable, Equatable, Sendable {
    let totals: Totals?
    let latestCacheHitRate: Double?

    nonisolated struct Totals: Decodable, Equatable, Sendable {
        let input: Double?
        let output: Double?
        let cacheRead: Double?
        let cacheWrite: Double?
        let cost: Double?
    }
}

/// Direct native AgentSession.getSessionStats() wire fields. Totals cover all
/// committed session entries, including summaries/compactions, not just a branch.
nonisolated struct LinkSessionStats: Decodable, Equatable, Sendable {
    let sessionId: String
    let tokens: Tokens?
    let cost: Double?

    nonisolated struct Tokens: Decodable, Equatable, Sendable {
        let input: Double?
        let output: Double?
        let cacheRead: Double?
        let cacheWrite: Double?
        let total: Double?
    }
}

/// Native context estimate and routed model limit; null tokens/percent after
/// compaction mean unknown until a trustworthy response, never zero.
nonisolated struct LinkContextUsage: Decodable, Equatable, Sendable {
    let tokens: Double?
    let contextWindow: Double?
    let percent: Double?
}
