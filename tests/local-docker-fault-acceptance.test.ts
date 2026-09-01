import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { validateLocalFaultEvidence } from './fault-acceptance.js'

const compose = ['compose', '-p', 'local', '--env-file', '.env', '-f', 'infra/local/docker-compose.yml']
const redisService = 'redis'
const healthUrl = 'http://127.0.0.1:8787/healthz'

type HealthEnvelope = {
  request_id?: string
  trace_id?: string
  error?: { code?: string }
  data?: { status?: string; redis?: { ready?: boolean } }
}

function docker(args: string[]) {
  return execFileSync('docker', [...compose, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function health(): Promise<{ status: number; body: HealthEnvelope }> {
  const response = await fetch(healthUrl, { headers: { 'x-request-id': 'local-fault-acceptance' } })
  return { status: response.status, body: await response.json() as HealthEnvelope }
}

async function waitFor(predicate: (result: Awaited<ReturnType<typeof health>>) => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let latest = await health()
  while (!predicate(latest) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250))
    latest = await health()
  }
  return latest
}

describe('local Docker fault acceptance', () => {
  it('reports Redis outage with correlation evidence and recovers after restart', async () => {
    const initial = await waitFor(result => result.status === 200 && result.body.data?.redis?.ready === true)
    expect(initial.status).toBe(200)

    try {
      docker(['stop', redisService])
      const degraded = await waitFor(result => result.status === 503 && result.body.error?.code === 'REDIS_UNAVAILABLE')
      expect(degraded.status).toBe(503)
      expect(degraded.body.error?.code).toBe('REDIS_UNAVAILABLE')
      // Error responses intentionally keep data null; the stable error code is
      // the machine-readable dependency signal, while correlation IDs link it
      // to the request observation and downstream logs.
      expect(degraded.body.data).toBeNull()
      expect(degraded.body.request_id).toBeTruthy()
      expect(degraded.body.trace_id).toBeTruthy()

      docker(['start', redisService])
      const recovered = await waitFor(result => result.status === 200 && result.body.data?.redis?.ready === true)
      expect(recovered.status).toBe(200)
      expect(recovered.body.data?.redis?.ready).toBe(true)
      expect(recovered.body.request_id).toBeTruthy()
      expect(recovered.body.trace_id).toBeTruthy()

      const evidence = {
        schema_version: '1' as const,
        release_id: process.env.RELEASE_ID?.trim() || 'local-test-release',
        software_version: process.env.SOFTWARE_VERSION?.trim() || 'local-api@workspace',
        config_version: process.env.CONFIG_VERSION?.trim() || 'compose-test-v1',
        data_version: process.env.DATA_VERSION?.trim() || 'migration-128',
        environment: 'test' as const,
        cloud_gate: false as const,
        status: 'pass' as const,
        generated_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        scenarios: [{
          name: 'redis_restart', status: 'pass' as const,
          degraded_status: degraded.status,
          degraded_code: degraded.body.error?.code ?? '',
          recovered_status: recovered.status,
          recovered_ready: recovered.body.data?.redis?.ready === true,
          request_id: degraded.body.request_id ?? '',
          trace_id: degraded.body.trace_id ?? '',
        }],
      }
      expect(validateLocalFaultEvidence(evidence)).toEqual([])
    } finally {
      // Restore the shared local stack even if an assertion or probe fails.
      docker(['start', redisService])
      await waitFor(result => result.status === 200 && result.body.data?.redis?.ready === true)
    }
  }, 45_000)
})
