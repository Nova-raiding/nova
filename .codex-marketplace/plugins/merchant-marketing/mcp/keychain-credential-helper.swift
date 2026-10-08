import Darwin
import Foundation
import Security

struct Request: Decodable {
    let operation: String
    let service: String
    let account: String
    let data: String?
}

enum TrustFailure: String {
    case signingIdentityUnavailable = "helper_signing_identity_unavailable"
    case signedAncestorInvalid = "helper_signed_ancestor_invalid"
}

func fail(operation: String? = nil, status: OSStatus? = nil, trust: TrustFailure? = nil) -> Never {
    if let trust {
        FileHandle.standardError.write(Data("keychain_trust=\(trust.rawValue)\n".utf8))
    } else if let operation, let status {
        FileHandle.standardError.write(Data("keychain_osstatus=\(status) operation=\(operation)\n".utf8))
    } else {
        FileHandle.standardError.write(Data("keychain operation failed\n".utf8))
    }
    exit(1)
}

func signingInformation(_ code: SecCode) -> [String: Any]? {
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode else { return nil }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess else { return nil }
    return information as? [String: Any]
}

func codeForPid(_ pid: pid_t) -> SecCode? {
    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess else { return nil }
    return code
}

func parentPid(_ pid: pid_t) -> pid_t? {
    var info = proc_bsdinfo()
    let size = MemoryLayout<proc_bsdinfo>.stride
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(size)) == size else { return nil }
    return pid_t(info.pbi_ppid)
}

func validSignedAncestor() -> Bool {
    guard let selfCode = codeForPid(getpid()),
          let selfInfo = signingInformation(selfCode),
          let ownTeam = selfInfo[kSecCodeInfoTeamIdentifier as String] as? String,
          !ownTeam.isEmpty else { fail(trust: .signingIdentityUnavailable) }
    var pid = getppid()
    for _ in 0..<10 {
        guard pid > 1, let code = codeForPid(pid), let info = signingInformation(code) else { return false }
        let identifier = info[kSecCodeInfoIdentifier as String] as? String
        let team = info[kSecCodeInfoTeamIdentifier as String] as? String
        let accepted = (identifier == "com.openai.codex" && team == "2DC432GLL2")
            || (identifier == "com.storenova.connect-helper" && team == ownTeam)
        if accepted {
            var staticCode: SecStaticCode?
            var requirement: SecRequirement?
            guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess,
                  let staticCode,
                  SecCodeCopyDesignatedRequirement(staticCode, SecCSFlags(), &requirement) == errSecSuccess,
                  let requirement,
                  SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { return false }
            return true
        }
        guard let next = parentPid(pid), next != pid else { return false }
        pid = next
    }
    return false
}

func query(_ request: Request) -> [String: Any] {
    var value: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: request.service,
        kSecAttrAccount as String: request.account,
    ]
    if request.operation == "read" || request.operation == "read_optional" {
        value[kSecReturnData as String] = true
        value[kSecMatchLimit as String] = kSecMatchLimitOne
    }
    return value
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 1024 * 1024,
      let request = try? JSONDecoder().decode(Request.self, from: input),
      request.service == "com.storenova.merchant-mcp",
      ["read", "read_optional", "write"].contains(request.operation),
      request.account.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { fail() }
guard validSignedAncestor() else { fail(trust: .signedAncestorInvalid) }

if request.operation == "write" {
    guard let data = request.data?.data(using: .utf8), data.count <= 1024 * 1024 else { fail() }
    let match = query(request)
    let status = SecItemUpdate(match as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var add = match
        add[kSecValueData as String] = data
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { fail(operation: request.operation, status: added) }
    } else if status != errSecSuccess { fail(operation: request.operation, status: status) }
    exit(0)
}

var result: CFTypeRef?
let status = SecItemCopyMatching(query(request) as CFDictionary, &result)
if request.operation == "read_optional" && status == errSecItemNotFound {
    FileHandle.standardOutput.write(Data("null".utf8))
    exit(0)
}
guard status == errSecSuccess, let data = result as? Data, data.count <= 1024 * 1024 else {
    fail(operation: request.operation, status: status)
}
FileHandle.standardOutput.write(data)
