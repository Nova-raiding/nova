import Foundation
import Security

struct Request: Decodable {
    let operation: String
    let service: String
    let account: String
    let data: String?
}

func fail() -> Never {
    FileHandle.standardError.write(Data("keychain operation failed\n".utf8))
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
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { fail() }
    } else if status != errSecSuccess { fail() }
case "read":
    var readQuery = query
    readQuery[kSecReturnData as String] = true
    readQuery[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(readQuery as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data else { fail() }
    FileHandle.standardOutput.write(data)
default:
    fail()
}
