import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('isolated Ops OIDC reauthentication contract', () => {
  it('compiles the local gateway login URL into the acceptance UI', () => {
    const source = readFileSync('scripts/run-ops-oidc-e2e.ts', 'utf8')

    expect(source).toContain("VITE_OPS_LOGIN_URL: `${baseUrl}/login`")
  })
})
