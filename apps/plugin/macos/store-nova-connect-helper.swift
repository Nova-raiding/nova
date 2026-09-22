import AppKit
import Foundation

@main
struct StoreNovaConnectHelper {
  static func main() {
    let urls = CommandLine.arguments.dropFirst()
    guard urls.count == 1, let rawURL = urls.first, rawURL.utf8.count <= 2048 else {
      showFailure()
      return
    }

    // The JavaScript entrypoint owns strict parameter validation. Never log or display rawURL:
    // it is untrusted browser input even though the supported contract contains no credentials.
    let pluginRoot = Bundle.main.bundleURL
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let script = pluginRoot.appendingPathComponent("scripts/connect-local-macos.mjs").path
    guard FileManager.default.isReadableFile(atPath: script) else {
      showFailure()
      return
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", script, rawURL]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
      process.waitUntilExit()
      if process.terminationStatus != 0 { showFailure() }
    } catch {
      showFailure()
    }
  }

  private static func showFailure() {
    let alert = NSAlert()
    alert.messageText = "Store Nova 连接未完成"
    alert.informativeText = "连接链接无效、已过期，或本地组件不可用。请返回商家后台重新发起连接。"
    alert.alertStyle = .warning
    alert.runModal()
  }
}
