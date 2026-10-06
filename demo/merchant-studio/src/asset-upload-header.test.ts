import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../../../apps/api/src/http-asset-routes.ts', import.meta.url), 'utf8')

describe('asset upload header encoding', () => {
  it('encodes Unicode material categories before putting them in HTTP headers', () => {
    expect(api).toContain("'x-asset-category': encodeURIComponent(materialCategory)")
    expect(routes).toContain('decodeURIComponent(categoryHeader)')
  })
})
