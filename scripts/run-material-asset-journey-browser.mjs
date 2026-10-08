import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const playwright = resolve(root, 'node_modules/.bin/playwright')
const spec = 'demo/merchant-studio/material-asset-journey.browser.spec.js'
const result = spawnSync(playwright, ['test', '--config=demo/merchant-studio', spec, '--workers=1'], {
  cwd: root,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
