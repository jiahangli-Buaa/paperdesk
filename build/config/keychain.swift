import Foundation
import Security

// Passwords arrive through stdin and never appear in command-line arguments.
let input = FileHandle.standardInput.readDataToEndOfFile()
do {
    guard let request = try JSONSerialization.jsonObject(with: input) as? [String: String],
          let account = request["account"] else {
        exit(2)
    }
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "local.paperdesk.desktop.journal-login",
        kSecAttrAccount as String: account
    ]
    if request["operation"] == "get" {
        var lookup = query
        lookup[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        guard status == errSecSuccess, let saved = result as? Data else { exit(1) }
        FileHandle.standardOutput.write(saved)
        exit(0)
    }
    if request["operation"] == "delete" {
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { print("deleted"); exit(0) }
        exit(1)
    }
    guard let password = request["password"] else { exit(2) }
    let data = Data(password.utf8)
    if request["operation"] == "verify" {
        var lookup = query
        lookup[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        guard status == errSecSuccess, let saved = result as? Data, saved == data else { exit(1) }
        print("verified")
        exit(0)
    }
    var status = SecItemUpdate(query as CFDictionary,
        [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "Paperdesk · " + (request["label"] ?? "期刊账号")
        status = SecItemAdd(item as CFDictionary, nil)
    }
    if status == errSecSuccess { print("saved") } else {
        FileHandle.standardError.write(Data("Keychain status: \(status)".utf8))
        exit(1)
    }
} catch { exit(2) }
