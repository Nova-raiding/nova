import Darwin
import Foundation
import Security

struct Request: Decodable {
    let operation: String
    let service: String
    let account: String
    let data: String?
}

func fail(operation: String? = nil, status: OSStatus? = nil) -> Never {
    if let operation, let status {
        FileHandle.standardError.write(Data("keychain_osstatus=\(status) operation=\(operation)\n".utf8))
    } else {
        FileHandle.standardError.write(Data("keychain operation failed\n".utf8))
    }
    exit(1)
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
