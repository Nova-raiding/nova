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

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 1024 * 1024,
      let request = try? JSONDecoder().decode(Request.self, from: input),
      request.service == "com.storenova.merchant-mcp",
      request.account.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { fail() }
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: request.service,
    kSecAttrAccount as String: request.account,
]

switch request.operation {
case "write":
    guard let value = request.data?.data(using: .utf8) else { fail() }
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: value] as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = value
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { fail(operation: request.operation, status: addStatus) }
    } else if status != errSecSuccess { fail(operation: request.operation, status: status) }
case "read", "read_optional":
    var readQuery = query
    readQuery[kSecReturnData as String] = true
    readQuery[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(readQuery as CFDictionary, &result)
    if request.operation == "read_optional" && status == errSecItemNotFound {
        FileHandle.standardOutput.write(Data("null".utf8))
        break
    }
    guard status == errSecSuccess, let data = result as? Data else { fail(operation: request.operation, status: status) }
    FileHandle.standardOutput.write(data)
default:
    fail()
}
