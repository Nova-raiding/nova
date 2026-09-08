import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { requireIsolatedLocalRuntime, type LocalRuntimeTestContext } from './local-runtime-test-safety.js'

let runtime: LocalRuntimeTestContext
beforeEach(() => { runtime = requireIsolatedLocalRuntime() })

function docker(args: string[]) {
  return execFileSync('docker', [...runtime.dockerArgs, ...args], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function json(url: string) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  return { status: response.status, body: await response.json() as {
    data?: { ready?: boolean; persistence?: { mode?: string; ready?: boolean }; release?: Record<string, string | null> }
    error?: { code?: string }
    request_id?: string
    trace_id?: string
  } }
}

describe('local Docker migration and release gate', () => {
  it('proves healthy API release probes and honest local metadata blocking', async () => {
    const health = await json(`${runtime.apiBaseUrl}/healthz`)
    const release = await json(`${runtime.apiBaseUrl}/releasez`)

    expect(health.status).toBe(200)
    expect(health.body.error).toBeNull()
    expect(health.body.data?.persistence).toEqual({ mode: 'postgres', ready: true })
    expect(health.body.request_id).toMatch(/^req_/u)
    expect(health.body.trace_id).toBe(health.body.request_id)

    // Local Compose intentionally has no signed release metadata. The probe
    // remains observable but must not turn fixture mode into a release claim.
    expect(release.status).toBe(200)
    expect(release.body.error).toBeNull()
    expect(release.body.data).toMatchObject({
      ready: false,
      release: { release_id: null, release_git_sha: null, manifest_sha256: null, image_set_digest: null },
    })
  }, 15_000)

  it('proves Postgres has every source migration through the current tail', () => {
    const versions = readdirSync(join(process.cwd(), 'packages/persistence/src/migrations'))
      .map(name => /^(\d+)_.*\.sql$/u.exec(name)?.[1])
      .filter((version): version is string => version !== undefined)
      .map(Number)
      .sort((a, b) => a - b)
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, index) => index + 1))

    const row = docker([
      ...runtime.composeArgs,
      'exec', '-T', 'postgres', 'psql', '-U', 'merchant', '-d', 'merchant', '-Atqc',
      "SELECT count(*)::int || ':' || min(version)::int || ':' || max(version)::int || ':' || string_agg(version::text, ',' ORDER BY version) FROM schema_migrations",
    ])
    const [countText, minimumText, maximumText, versionsText] = row.split(':')
    const count = Number(countText)
    const minimum = Number(minimumText)
    const maximum = Number(maximumText)
    const databaseVersions = (versionsText ?? '').split(',').filter(Boolean).map(Number)
    expect({ count, minimum, maximum }).toEqual({ count: versions.length, minimum: 1, maximum: versions.at(-1) })
    // Count/min/max alone cannot detect a missing interior migration paired
    // with a duplicate. Compare the complete runtime chain as dynamic
    // evidence so the local gate fails closed on any gap or duplicate.
    expect(databaseVersions).toEqual(versions)
  }, 15_000)
})
