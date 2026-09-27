import AppKit
import Foundation

@MainActor
@main
final class StoreNovaConnectHelper: NSObject, NSApplicationDelegate {
  private var handlingURL = false

  static func main() {
    let app = NSApplication.shared
    let delegate = StoreNovaConnectHelper()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // An accidental direct launch must not leave an invisible process running.
    Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] _ in
      if self?.handlingURL == false { NSApp.terminate(nil) }
    }
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    guard !handlingURL, urls.count == 1, let url = urls.first,
          url.scheme == "storenova", url.absoluteString.utf8.count <= 2048 else {
      showFailure()
      return
    }
    handlingURL = true
    // Launch Services delivers custom schemes through this delegate callback,
    // not as a command-line argument. Never log the untrusted URL.
    let rawURL = url.absoluteString
    let pluginRoot = Bundle.main.bundleURL.deletingLastPathComponent()
    let script = pluginRoot.appendingPathComponent("scripts/connect-local-macos.mjs").path
    let node = pluginRoot.appendingPathComponent("runtime/node").path
    guard FileManager.default.isReadableFile(atPath: script),
          FileManager.default.isExecutableFile(atPath: node) else {
      showFailure()
      NSApp.terminate(nil)
      return
    }
    Task.detached {
      let succeeded = Self.runScript(node: node, script: script, rawURL: rawURL)
      await MainActor.run {
        if !succeeded { self.showFailure() }
        NSApp.terminate(nil)
      }
    }
  }

  nonisolated private static func runScript(node: String, script: String, rawURL: String) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = [script, rawURL]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus == 0
    } catch { return false }
  }

  private func showFailure() {
    let alert = NSAlert()
    alert.messageText = "Store Nova 连接未完成"
    alert.informativeText = "连接链接无效、已过期，或本地组件不可用。请返回商家后台重新发起连接。"
    alert.alertStyle = .warning
    alert.runModal()
  }
}
