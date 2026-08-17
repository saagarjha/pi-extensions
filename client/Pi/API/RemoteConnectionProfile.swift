#if os(macOS)
import Foundation
import Security

nonisolated struct RemoteConnectionProfile: Codable, Sendable {
    let version: Int
    let origin: String
    let certificate: String?
    let token: String
    let instanceId: String?

    static func importing(_ text: String) throws -> Self {
        guard let data = Data(base64Encoded: text.filter { !$0.isWhitespace }) else { throw LinkFailure("Invalid base64 connection profile") }
        let profile = try JSONDecoder().decode(Self.self, from: data)
        try profile.validate()
        return profile
    }
    var certificateData: Data? {
        Data(base64Encoded: (certificate ?? "").replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "").replacingOccurrences(of: "-----END CERTIFICATE-----", with: "").filter { !$0.isWhitespace })
    }
    func validate() throws {
        guard version == 1, let url = URL(string: origin), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/", token.utf8.count == 43,
              token.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
              let data = certificateData, SecCertificateCreateWithData(nil, data as CFData) != nil else {
            throw LinkFailure("Invalid HTTPS connection profile")
        }
    }
}

/// Profiles (including bearer secrets) never enter UserDefaults or files.
nonisolated enum RemoteProfileKeychain {
    static let service = "dev.pi.session-link.remote-profile"
    static func save(_ profile: RemoteConnectionProfile) throws {
        try profile.validate()
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: profile.origin]
        let data = try JSONEncoder().encode(profile)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw LinkFailure("Could not save remote credentials in Keychain") }
        } else if status != errSecSuccess { throw LinkFailure("Could not update remote credentials in Keychain") }
    }
    static func load(_ origin: String) throws -> RemoteConnectionProfile {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: origin, kSecReturnData as String: true] as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { throw LinkFailure("Remote credentials unavailable in Keychain") }
        let profile = try JSONDecoder().decode(RemoteConnectionProfile.self, from: data)
        try profile.validate()
        return profile
    }
    static func remove(_ origin: String) throws {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: origin] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw LinkFailure("Could not remove remote credentials from Keychain") }
    }
    static func origins() -> [String] {
        var result: CFTypeRef?
        guard SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll] as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]] else { return [] }
        return items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
    }
}

/// Exact leaf pin, explicit DNS SAN/serverAuth purpose, and Security signature/date validation.
/// BasicX509 intentionally avoids the public-PKI TLS maximum-certificate-lifetime rule:
/// these manually imported self-signed identities are long-lived, not CA-issued web certificates.
/// Actual notBefore/notAfter validity remains enforced; no wildcard or CN fallback is allowed.
/// Trust is anchored only to the exact imported certificate, never installed globally.
/// Redirects are refused so a bearer credential cannot cross origins.
nonisolated final class LinkTLSDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let certificate: Data?
    let host: String
    init(certificate: Data?, host: String) { self.certificate = certificate; self.host = host }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == host, let certificate,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              SecCertificateCopyData(leaf) as Data == certificate,
              let anchor = SecCertificateCreateWithData(nil, certificate as CFData),
              matchesHostname(leaf), permitsTLSServer(leaf),
              SecTrustSetPolicies(trust, SecPolicyCreateBasicX509()) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    private func permitsTLSServer(_ certificate: SecCertificate) -> Bool {
        guard let values = SecCertificateCopyValues(certificate, [kSecOIDExtendedKeyUsage] as CFArray, nil) as? [String: Any],
              let usage = values[kSecOIDExtendedKeyUsage as String] as? [String: Any],
              let identifiers = usage[kSecPropertyKeyValue as String] as? [Data] else { return false }
        // DER OID content for id-kp-serverAuth (1.3.6.1.5.5.7.3.1).
        return identifiers.contains(Data([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01]))
    }
    private func matchesHostname(_ certificate: SecCertificate) -> Bool {
        guard let values = SecCertificateCopyValues(certificate, [kSecOIDSubjectAltName] as CFArray, nil) as? [String: Any],
              let extensionValue = values[kSecOIDSubjectAltName as String] as? [String: Any],
              let names = extensionValue[kSecPropertyKeyValue as String] as? [[String: Any]] else { return false }
        return names.contains { name in
            guard name[kSecPropertyKeyLabel as String] as? String == "DNS Name",
                  let dns = name[kSecPropertyKeyValue as String] as? String else { return false }
            return dns.lowercased() == host.lowercased()
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
#endif
