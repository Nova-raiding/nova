import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const port = 5194
const studioUrl = `http://127.0.0.1:${port}`
const evidenceDir = resolve(root, 'docs/qa/evidence/2026-09-29-chatgpt-app/local-publish-history')
const vite = spawn(resolve(root, 'demo/merchant-studio/node_modules/.bin/vite'), [
  '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], { cwd: resolve(root, 'demo/merchant-studio'), env: { ...process.env, VITE_API_BASE_URL: '/api' }, stdio: 'ignore' })

try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (vite.exitCode !== null) break
    try {
      const response = await fetch(`${studioUrl}/publish-history-visual.html`)
      if (response.ok) { ready = true; break }
    } catch { /* Vite is still starting. */ }
    await sleep(250)
  }
  if (!ready) throw new Error('本地发布记录候选页面未启动')
  const browser = spawn(process.execPath, [
    resolve(root, 'node_modules/@playwright/test/cli.js'), 'test',
    'demo/merchant-studio/publish-history.browser.spec.js', '--workers=1', '--reporter=line', '--timeout=60000',
    ...(process.env.PUBLISH_HISTORY_TEST_GREP ? ['--grep', process.env.PUBLISH_HISTORY_TEST_GREP] : []),
  ], { cwd: root, env: { ...process.env, MERCHANT_STUDIO_URL: studioUrl, PUBLISH_HISTORY_EVIDENCE_DIR: evidenceDir }, stdio: 'inherit' })
  const code = await new Promise((resolveExit, reject) => {
    browser.on('error', reject)
    browser.on('exit', value => resolveExit(value ?? 1))
  })
  process.exitCode = code
} finally {
  vite.kill('SIGTERM')
}
