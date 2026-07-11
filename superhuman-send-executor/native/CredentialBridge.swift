import Foundation
import Security

private let shmPath = "/usr/local/libexec/pinet-superhuman-send-executor/current/shm"
private let service = "ai.pinet.superhuman-send-executor"
private let account = "root"

private func fail(_ code: String) -> Never {
    FileHandle.standardError.write(Data((code + "\n").utf8))
    exit(1)
}
private func boundedIdentifier(_ value: String) -> String {
    guard value.count > 0, value.count <= 128,
          value.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.:@")).contains($0) })
    else { fail("invalid_identifier") }
    return value
}
private func credential() -> String {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data,
          let value = String(data: data, encoding: .utf8), !value.isEmpty
    else { fail("credential_unavailable") }
    return value
}
private func run(_ arguments: [String]) -> Never {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: shmPath)
    process.arguments = arguments
    process.environment = ["PATH": "/usr/bin:/bin", "SHM_AUTH_TOKEN": credential()]
    process.standardOutput = FileHandle.standardOutput
    process.standardError = FileHandle.standardError
    do { try process.run(); process.waitUntilExit() } catch { fail("provider_helper_failed") }
    exit(process.terminationStatus)
}

guard geteuid() == 0 else { fail("root_required") }
let args = Array(CommandLine.arguments.dropFirst())
guard let operation = args.first else { fail("invalid_operation") }
switch operation {
case "render":
    guard args.count == 3 else { fail("invalid_arguments") }
    run(["draft", "get", "--account", boundedIdentifier(args[1]), "--id", boundedIdentifier(args[2]), "--json"])
case "send":
    guard args.count == 5, args[4].count == 64,
          args[4].allSatisfy({ $0.isHexDigit }) else { fail("invalid_arguments") }
    run(["draft", "send", "--account", boundedIdentifier(args[1]), "--id", boundedIdentifier(args[2]),
         "--if-revision", boundedIdentifier(args[3]), "--expected-rendered-sha256", args[4], "--json"])
default:
    fail("invalid_operation")
}
