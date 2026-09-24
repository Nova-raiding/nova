import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { SCANNER_HEARTBEAT_SCHEMA } from '../../../packages/workers/src/scanner-heartbeat.js'
import { scannerContainerCanRecover } from './scanner-container-healthcheck.js'

const now = Date.parse('2026-09-24T06:00:00.000Z')
const baseHeartbeat = {
  schemaVersion: SCANNER_HEARTBEAT_SCHEMA,
  instanceId: 'scanner-test',
  observedAt: '2026-09-24T05:59:55.000Z',
  expiresAt: '2026-09-24T06:00:10.000Z',
  checks: { databaseReady: true, apiReady: true, redisReady: true },
  clamav: { reachable: true },
  eicar: { passed: true },
  callback: { configured: true, capable: true },
  queue: { backlog: 0, deadLetter: 0 },
  recoveryCapable: true,
}

describe('scanner container health marker', () => {
  it('accepts normal business-ready and recovery-only markers as process health', () => {
    expect(scannerContainerCanRecover({ state: 'ready', heartbeat: { ...baseHeartbeat, ready: true } }, now)).toBe(true)
    expect(scannerContainerCanRecover({ state: 'recovery', heartbeat: { ...baseHeartbeat, ready: false, callback: { configured: true, capable: false } } }, now)).toBe(true)
  })

  it('rejects contradictory marker states, missing recovery prerequisites and expired evidence', () => {
    const recoveryHeartbeat = { ...baseHeartbeat, ready: false, callback: { configured: true, capable: false } }
    expect(scannerContainerCanRecover({ state: 'ready', heartbeat: recoveryHeartbeat }, now)).toBe(false)
    expect(scannerContainerCanRecover({ state: 'recovery', heartbeat: { ...recoveryHeartbeat, recoveryCapable: false } }, now)).toBe(false)
    expect(scannerContainerCanRecover({ state: 'recovery', heartbeat: { ...recoveryHeartbeat, checks: { ...baseHeartbeat.checks, databaseReady: false } } }, now)).toBe(false)
    expect(scannerContainerCanRecover({ state: 'recovery', heartbeat: { ...recoveryHeartbeat, expiresAt: '2026-09-24T05:59:59.000Z' } }, now)).toBe(false)
    expect(scannerContainerCanRecover({ state: 'recovery', heartbeat: { ...recoveryHeartbeat, expiresAt: 'invalid' } }, now)).toBe(false)
  })

  it('fails closed when dependency checks contain truthy non-boolean values', () => {
    const recoveryHeartbeat = { ...baseHeartbeat, ready: false, callback: { configured: true, capable: false } }
    expect(scannerContainerCanRecover({ state: 'recovery', heartbeat: { ...recoveryHeartbeat, checks: { ...baseHeartbeat.checks, databaseReady: 'yes' as unknown as boolean } } }, now)).toBe(false)
    expect(scannerContainerCanRecover({ state: 'recovery', heartbeat: { ...recoveryHeartbeat, checks: { ...baseHeartbeat.checks, apiReady: 1 as unknown as boolean } } }, now)).toBe(false)
    expect(scannerContainerCanRecover({ state: 'recovery', heartbeat: { ...recoveryHeartbeat, checks: { ...baseHeartbeat.checks, redisReady: 'true' as unknown as boolean } } }, now)).toBe(false)
  })

  it('reads valid recovery, invalid JSON and expired markers through the CLI entrypoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-healthcheck-'))
    const markerPath = join(directory, 'ready')
    const entrypoint = fileURLToPath(new URL('./scanner-container-healthcheck.ts', import.meta.url))
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', entrypoint], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', WORKER_READY_FILE: markerPath },
    })
    try {
      const observedAt = new Date(Date.now() - 5_000).toISOString()
      const expiresAt = new Date(Date.now() + 60_000).toISOString()
      const currentHeartbeat = { ...baseHeartbeat, observedAt, expiresAt, ready: false, callback: { configured: true, capable: false } }
      await writeFile(markerPath, JSON.stringify({ state: 'recovery', heartbeat: currentHeartbeat }))
      expect(run().status).toBe(0)

      await writeFile(markerPath, '{not-json')
      expect(run().status).toBe(1)

      await writeFile(markerPath, JSON.stringify({ state: 'recovery', heartbeat: {
        ...currentHeartbeat, ready: false, observedAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(), callback: { configured: true, capable: false },
      } }))
      expect(run().status).toBe(1)
      expect(await readFile(markerPath, 'utf8')).toContain('expiresAt')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
