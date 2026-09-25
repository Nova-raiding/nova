#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { verifyChatGPTMacApp } from './verify-chatgpt-macos.mjs'
import { launchVerifiedChatGPT } from './launch-verified-chatgpt-macos.mjs'

if (process.platform !== 'darwin') throw new Error('此安装入口仅支持 macOS。')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const userApplications = resolve(homedir(), 'Applications')
const appPaths = [resolve(userApplications, 'ChatGPT.app'), '/Applications/ChatGPT.app', resolve(userApplications, 'Store Nova/ChatGPT.app')]
const bundled = resolve(root, 'ChatGPT.app.zip')
let appPath = appPaths.find(path => existsSync(path) && verifyChatGPTMacApp(path).ok)
if (!appPath && existsSync(bundled)) {
  const temporary = mkdtempSync(resolve(tmpdir(), 'storenova-chatgpt-'))
  try {
    const expanded = spawnSync('/usr/bin/ditto', ['-x', '-k', bundled, temporary], { stdio: 'inherit' })
    if (expanded.error || expanded.status !== 0) throw new Error('随包 ChatGPT.app 解压失败。')
    const source = resolve(temporary, 'ChatGPT.app')
    const checked = verifyChatGPTMacApp(source)
    if (!checked.ok) throw new Error(`随包 ChatGPT.app 校验失败：${checked.reason}`)
    const target = appPaths[0] && !existsSync(appPaths[0]) ? appPaths[0] : appPaths[2]
    if (existsSync(target)) throw new Error(`安装位置 ${target} 已存在无效应用；请先手动移走该应用。`)
    mkdirSync(dirname(target), { recursive: true })
    const copied = spawnSync('/usr/bin/ditto', [source, target], { stdio: 'inherit' })
    if (copied.error || copied.status !== 0) throw new Error(`随包 ChatGPT.app 安装到 ${target} 失败。`)
    const installed = verifyChatGPTMacApp(target)
    if (!installed.ok) throw new Error(`安装后的 ChatGPT.app 校验失败：${installed.reason}`)
    appPath = target
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
const downloadPage = 'https://chatgpt.com/download/'

if (!appPath) {
  process.stdout.write(`请从 OpenAI 官方页面下载适合这台 Mac 的 ChatGPT，安装到“应用程序”文件夹：\n${downloadPage}\n`)
  const opened = spawnSync('/usr/bin/open', [downloadPage], { stdio: 'ignore' })
  if (opened.error || opened.status !== 0) process.stdout.write('浏览器未能自动打开；请手动访问上面的官方地址。\n')
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    while (!appPath) {
      const answer = (await prompt.question('官方 ChatGPT 安装完成后按回车继续；输入 q 退出：')).trim().toLowerCase()
      if (answer === 'q') process.exit(1)
      appPath = appPaths.find(path => existsSync(path) && verifyChatGPTMacApp(path).ok)
      if (!appPath) process.stdout.write('仍未在“应用程序”文件夹找到 ChatGPT.app。请完成官方安装后重试。\n')
    }
  } finally { prompt.close() }
}

const checked = verifyChatGPTMacApp(appPath)
if (!checked.ok) throw new Error(`${checked.reason} 插件安装已停止；请从 OpenAI 官方页面重新安装原版 ChatGPT。`)
process.stdout.write('OpenAI 原版 ChatGPT.app 的身份、架构、签名与公证验证通过。现在安装 Merchant Marketing 插件。\n')
const installer = spawnSync('/bin/sh', [resolve(root, 'install.command')], { stdio: 'inherit' })
if (!installer.error && installer.status === 42) {
  process.stderr.write('ChatGPT 与插件已安装，但工作区绑定未完成；请稍后运行 login.sh --workspace ws_...。\n')
  process.exitCode = 42
} else if (installer.error || installer.status !== 0) {
  throw new Error(`插件安装或登录失败：${installer.error?.message ?? installer.status}`)
} else {
  const launch = launchVerifiedChatGPT(appPath)
  process.stdout.write(launch.launched ? 'ChatGPT 已打开。\n' : `${launch.reason}\n`)
}
