import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('real HTTP pilot capacity smoke', () => {
  it('runs 50 isolated workspaces through one temporary HTTP server and deduplicates writes', async () => {
    const runner = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
    const script = resolve(process.cwd(), 'tests/http-load-smoke.ts')
    const child = spawnSync(process.execPath, [runner, script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', CONNECTOR_FIXTURE_MODE: 'true', MERCHANT_TEST_APPROVED_RATES: 'true', PLUGIN_WRITE_ENABLED: 'true' },
    })
    expect(child.status, child.stderr).toBe(0)
    const summary = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
    expect(summary).toMatchObject({
      profile: 'pilot_50_http_fake',
      transport: 'real_http',
      connectorMode: 'fake',
      cloudGate: false,
      workspaces: 50,
      duplicatePublishRequests: 100,
      acceptedPublishJobs: 100,
      uniquePublishJobs: 50,
      duplicateWrites: 50,
    })
    expect(summary.requests).toBe(400)
    expect(summary.errors).toEqual([])
  }, 30_000)
})
