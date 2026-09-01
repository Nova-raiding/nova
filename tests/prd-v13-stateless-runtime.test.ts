import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('PRD v1.3 stateless runtime contract', () => {
  it('keeps the target-500 API fleet within the documented 3–12 replica envelope', () => {
    const overlay = readFileSync(`${root}/infra/kubernetes/overlays/target-500/kustomization.yaml`, 'utf8')
    expect(overlay).toMatch(/name: merchant-api\s+count: 12/)
    expect(overlay).not.toMatch(/name: merchant-api\s+count: (?:1|2)\b/)
  })

  it('uses rolling replacement with no planned API downtime', () => {
    const api = readFileSync(`${root}/infra/kubernetes/base/api.yaml`, 'utf8')
    expect(api).toMatch(/strategy:\s+type: RollingUpdate/)
    expect(api).toMatch(/maxUnavailable: 0/)
    expect(api).toMatch(/readinessProbe:\s+httpGet:\s+\{path: \/readyz, port: http\}/)
  })

  it('does not configure sticky sessions or an in-process session store', () => {
    const api = readFileSync(`${root}/infra/kubernetes/base/api.yaml`, 'utf8')
    expect(api).not.toMatch(/sessionAffinity:\s*(?!None)/)
    expect(api).not.toMatch(/sticky|affinityCookie|in[-_ ]process session/i)
  })
})
