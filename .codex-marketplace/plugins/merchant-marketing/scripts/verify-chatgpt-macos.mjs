import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const OPENAI_TEAM_ID = '2DC432GLL2'
const OPENAI_AUTHORITY = `Authority=Developer ID Application: OpenAI OpCo, LLC (${OPENAI_TEAM_ID})`

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  return { ok: !result.error && result.status === 0, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

export function verifyChatGPTMacApp(appPath) {
  if (process.platform !== 'darwin') return { ok: false, reason: '仅支持 macOS。' }
  if (!existsSync(appPath)) return { ok: false, reason: '未找到 ChatGPT.app。', missing: true }
  const info = resolve(appPath, 'Contents/Info.plist')
  const bundle = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', info])
  if (!bundle.ok || bundle.output.trim() !== 'com.openai.codex') {
    return { ok: false, reason: 'ChatGPT.app 的 Bundle ID 不匹配。' }
  }
  const executableName = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', info])
  if (!executableName.ok || !/^[A-Za-z0-9._-]+$/u.test(executableName.output.trim())) {
    return { ok: false, reason: 'ChatGPT.app 的可执行文件信息无效。' }
  }
  const executable = resolve(appPath, 'Contents/MacOS', executableName.output.trim())
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  const binary = run('/usr/bin/file', ['-b', executable])
  if (!binary.ok || !binary.output.includes('Mach-O') || !binary.output.includes(architecture)) {
    return { ok: false, reason: `ChatGPT.app 不包含当前 Mac 的原生 ${architecture} 架构。` }
  }
  const seal = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  if (!seal.ok) return { ok: false, reason: 'ChatGPT.app 代码签名或文件封存校验失败。' }
  const identity = run('/usr/bin/codesign', ['--display', '--verbose=4', appPath])
  const lines = identity.output.split(/\r?\n/u)
  if (!identity.ok || !lines.includes(`TeamIdentifier=${OPENAI_TEAM_ID}`) ||
      !lines.includes(OPENAI_AUTHORITY) || !lines.some(line => line.startsWith('Timestamp='))) {
    return { ok: false, reason: 'ChatGPT.app 不是预期的 OpenAI Developer ID 签名。' }
  }
  const gatekeeper = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
  if (!gatekeeper.ok || !gatekeeper.output.includes('source=Notarized Developer ID')) {
    return { ok: false, reason: 'ChatGPT.app 未通过 Gatekeeper 公证评估。' }
  }
  return { ok: true, appPath }
}
