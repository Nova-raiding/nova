import { describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const verifier = resolve(process.cwd(), 'apps/plugin/scripts/verify-chatgpt-macos.mjs')
function verify(appPath: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const { verifyChatGPTMacApp } = await import(process.argv[1]); console.log(JSON.stringify(verifyChatGPTMacApp(process.argv[2])))',
    new URL(`file://${verifier}`).href, appPath], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as { ok: boolean; reason?: string; missing?: boolean }
}

describe.skipIf(process.platform !== 'darwin')('Mac one-entry host verification', () => {
  it('stops when the official app is missing', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'storenova-missing-chatgpt-'))
    try { expect(verify(resolve(directory, 'ChatGPT.app'))).toMatchObject({ ok: false, missing: true }) }
    finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('rejects an unsigned lookalike with the expected bundle ID and native architecture', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'storenova-fake-chatgpt-'))
    const app = resolve(directory, 'ChatGPT.app')
    try {
      mkdirSync(resolve(app, 'Contents/MacOS'), { recursive: true })
      writeFileSync(resolve(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleExecutable</key><string>ChatGPT</string></dict></plist>\n`)
      cpSync('/usr/bin/true', resolve(app, 'Contents/MacOS/ChatGPT'))
      expect(verify(app)).toMatchObject({ ok: false, reason: 'ChatGPT.app 代码签名或文件封存校验失败。' })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it.skipIf(!existsSync('/Applications/ChatGPT.app'))('accepts the installed OpenAI signed and notarized app', () => {
    expect(verify('/Applications/ChatGPT.app')).toMatchObject({ ok: true })
  }, 90_000)
})
