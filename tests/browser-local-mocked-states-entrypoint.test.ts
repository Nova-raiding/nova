import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('local mocked browser entrypoint', () => {
  it('runs only the canonical desktop spec through explicit loopback URLs', () => {
    const root = resolve(import.meta.dirname, '..')
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const command = packageJson.scripts['test:browser:local-mocked-states'] ?? ''
    expect(command).toContain('OPS_BASE_URL=http://127.0.0.1:18082/')
    expect(command).toContain('--config=dogfood/chatgpt-all-functions')
    expect(command).toContain('dogfood/chatgpt-all-functions/canonical-product-desktop.spec.js')
    expect(command).not.toContain('MERCHANT_STUDIO_URL')
  })
})
