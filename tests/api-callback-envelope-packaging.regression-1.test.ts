import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('API callback signer runtime packaging', () => {
  it('packages the callback signer beside compiled API billing modules', () => {
    const dockerfile = readFileSync('infra/docker/api.Dockerfile', 'utf8')
    const runtime = dockerfile.split(/^FROM .* AS runtime\s*$/m)[1]
    expect(runtime).toBeDefined()

    for (const file of ['callback-envelope.mjs', 'callback-envelope.d.mts']) {
      expect(runtime!.split(/\r?\n/)).toContain(
        `COPY packages/billing/src/${file} ./dist/packages/billing/src/${file}`,
      )
    }
  })
})
