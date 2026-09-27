import { spawnSync } from 'node:child_process'
import { verifyChatGPTMacApp } from './verify-chatgpt-macos.mjs'

export function launchVerifiedChatGPT(appPath, { spawn = spawnSync, verify = verifyChatGPTMacApp } = {}) {
  const checked = verify(appPath)
  if (!checked.ok) throw new Error(`启动前 ChatGPT.app 校验失败：${checked.reason}`)

  // An existing ChatGPT process may still have a conversation open. Never quit it.
  const running = spawn('/usr/bin/pgrep', ['-U', String(process.getuid?.() ?? 0), '-x', 'ChatGPT'], { stdio: 'ignore' })
  if (running.error || ![0, 1].includes(running.status)) {
    return { launched: false, reason: '无法确认 ChatGPT 是否正在运行；请自行打开或重启已安装的应用。' }
  }
  if (running.status === 0) {
    return { launched: false, reason: 'ChatGPT 已在运行。请保存当前会话并自行退出、重新打开 ChatGPT，以加载新插件。' }
  }

  const opened = spawn('/usr/bin/open', ['-a', appPath], { stdio: 'ignore' })
  if (opened.error || opened.status !== 0) {
    return { launched: false, reason: `自动打开 ChatGPT 失败；请手动打开 ${appPath}。` }
  }
  return { launched: true }
}
