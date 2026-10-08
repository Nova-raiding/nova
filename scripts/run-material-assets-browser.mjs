import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const playwright = resolve(root, 'node_modules/.bin/playwright')
const specs = [
  'demo/merchant-studio/material-library-preview.browser.spec.js',
  'demo/merchant-studio/material-product-import.browser.spec.js',
]
const result = spawnSync(playwright, ['test', '--config=demo/merchant-studio', ...specs, '--workers=1'], {
  cwd: root,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
