import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('API release image ECS gateway handoff packaging', () => {
  it('copies the handoff module required by the root composite build', () => {
    // Regression: ISSUE-001 — API release image build could not resolve the ECS gateway handoff module
    // Found by /qa on 2026-09-22
    // Report: .gstack/qa-reports/qa-report-yxsona-com-2026-09-22.md
    const dockerfile = readFileSync('infra/docker/api.Dockerfile', 'utf8')

    expect(dockerfile).toContain(
      'COPY infra/scripts/ecs-external-gateway-handoff.mjs infra/scripts/ecs-external-gateway-handoff.d.mts ./infra/scripts/',
    )
  })
})
