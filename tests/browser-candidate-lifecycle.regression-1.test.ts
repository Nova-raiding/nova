import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertContainerHealthy, candidateConfiguration, cleanupBrowserCandidate, type CleanupDocker } from '../scripts/merchant-browser-candidate.js'

// Regression: ISSUE-001 — inherited provider credentials and abandoned candidate containers escaped isolation.
// Found by /qa on 2026-09-15
// Report: .gstack/qa-reports/qa-report-local-browser-2026-09-15.md
const candidate = () => candidateConfiguration(process.env, 'a'.repeat(40), [28081, 28082, 28787, 15439, 16389], '0123456789ab')

describe('candidate environment and lifecycle', () => {
  it('drops real process.env contamination before Compose interpolation and fixes fail-closed fixture modes', () => {
    const pollution = { PAYMENT_PROVIDER_API_KEY: 'regression-provider-secret', MODEL_RELAY_API_KEY: 'regression-model-secret', VIDEO_MODEL_RELAY_API_KEY: 'regression-video-secret', DATABASE_URL: 'postgres://real-business-db/merchant', STORE_API_TOKEN: 'regression-store-secret', WORKER_API_CREDENTIALS: 'regression-worker-secret', COMPOSE_ENV_FILES: '/business/.env', NODE_OPTIONS: '--require business-hook', PAYMENT_MODE: 'provider', PERSISTENCE_MODE: 'memory' }
    const previous = Object.fromEntries(Object.keys(pollution).map(key => [key, process.env[key]]))
    try {
      Object.assign(process.env, pollution)
      const value = candidate()
      expect(value.env).toMatchObject({ PAYMENT_MODE: 'fixture', PERSISTENCE_MODE: 'postgres', CONNECTOR_FIXTURE_MODE: 'true', MODEL_RELAY_API_KEY: '', VIDEO_MODEL_RELAY_API_KEY: '', PLUGIN_WRITE_ENABLED: 'false', PAYMENT_RECONCILIATION_ENABLED: 'false', PAYMENT_REFUND_ENABLED: 'false' })
      for (const key of ['PAYMENT_PROVIDER_API_KEY', 'DATABASE_URL', 'STORE_API_TOKEN', 'WORKER_API_CREDENTIALS', 'COMPOSE_ENV_FILES', 'NODE_OPTIONS']) expect(value.env[key]).toBeUndefined()
      for (const sentinel of Object.values(pollution)) expect(JSON.stringify(value.env)).not.toContain(sentinel)
      expect(value.env.PATH).toBe(process.env.PATH)
    } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
  })

  it('refuses business env files in candidate mode', () => {
    expect(() => candidateConfiguration({ BROWSER_ENV_FILE: '/business/.env' }, 'a'.repeat(40), [28081, 28082, 28787, 15439, 16389], '0123456789ab')).toThrow(/refuses BROWSER_ENV_FILE/)
  })

  it('requires running healthy containers, not just a correct release probe', () => {
    expect(() => assertContainerHealthy({ State: { Running: true, Health: { Status: 'healthy' } } }, 'api')).not.toThrow()
    for (const value of [{}, { State: { Running: false, Health: { Status: 'healthy' } } }, { State: { Running: true, Health: { Status: 'starting' } } }, { State: { Running: true } }]) expect(() => assertContainerHealthy(value, 'api')).toThrow(/not running and healthy/)
  })

  it('stops only full exact IDs with verified own-project labels and preserves fixture data', async () => {
    const value = candidate()
    const own = 'a'.repeat(64); const foreign = 'b'.repeat(64); const exited = 'c'.repeat(64)
    const stopped: string[] = []
    const running = new Set([own, foreign])
    const docker: CleanupDocker = {
      async list(project) { expect(project).toBe(value.project); return [own, foreign, exited] },
      async inspect(id) { return { Id: id, Config: { Labels: { 'com.docker.compose.project': id === foreign ? 'business-runtime' : value.project!, 'com.docker.compose.service': 'api' } }, State: { Running: running.has(id) } } },
      async stop(id) { stopped.push(id); running.delete(id) },
    }
    const evidence = await cleanupBrowserCandidate(value, docker)
    expect(stopped).toEqual([own])
    expect(evidence).toMatchObject({ stopped: [own], leftRunning: [foreign], volumesRetained: true })
    expect(evidence.failures).toHaveLength(1)
  })

  it('reports failed stop/unknown enumeration rather than claiming cleanup success', async () => {
    const value = candidate(); const id = 'a'.repeat(64)
    const docker: CleanupDocker = { async list() { return [id] }, async inspect() { return { Id: id, Config: { Labels: { 'com.docker.compose.project': value.project!, 'com.docker.compose.service': 'api' } }, State: { Running: true } } }, async stop() { throw new Error('stop failed') } }
    expect(await cleanupBrowserCandidate(value, docker)).toMatchObject({ leftRunning: [id], stopped: [], volumesRetained: true })
    expect(await cleanupBrowserCandidate(value, { ...docker, async list() { throw new Error('daemon unavailable') } })).toMatchObject({ leftRunning: ['unknown: enumeration failed'], volumesRetained: true })
  })

  it('cleans in finally and aborts active process groups on SIGINT/SIGTERM without removing volumes', () => {
    const source = readFileSync('scripts/merchant-browser-candidate.ts', 'utf8')
    expect(source).toContain('} finally {\n    if (startupAttempted)')
    expect(source).toContain("process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)")
    expect(source).toContain('process.kill(-child.pid, signal)')
    expect(source).toContain("'--wait', '--wait-timeout', '180'")
    expect(source).toContain('/healthz')
    expect(source).not.toContain('down -v')
    expect(source).not.toContain("'rm'")
  })
})
