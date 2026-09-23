import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertCandidateRelease, installCandidateFetchRoute, readCandidateRoute, validateCandidateRoute } from '../infra/scripts/chatgpt-candidate-fetch-route.mjs'

const route = {
  origin: 'https://yxsona.com', loopback_host: '127.0.0.1', loopback_port: 18443,
  expected_release_id: 'release-20260923-abcdef', expected_git_sha: 'a'.repeat(40),
  expected_image_set_digest: `sha256:${'b'.repeat(64)}`,
}

describe('candidate-only ChatGPT HTTPS route', () => {
  it('requires exact canonical origin, loopback tunnel, and frozen release identity', () => {
    expect(validateCandidateRoute(route, route.origin).hostname).toBe('yxsona.com')
    for (const invalid of [
      { ...route, origin: 'http://yxsona.com' },
      { ...route, origin: 'https://yxsona.com:8443' },
      { ...route, origin: 'https://yxsona.com/mcp' },
      { ...route, loopback_host: '0.0.0.0' },
      { ...route, loopback_port: 443 },
      { ...route, expected_image_set_digest: 'sha256:broken' },
    ]) expect(() => validateCandidateRoute(invalid, route.origin)).toThrow()
    expect(() => validateCandidateRoute(route, 'https://other.example.com')).toThrow(/does not match/u)
  })

  it('rejects stale or incomplete candidate release responses', () => {
    const valid = { data: { ready: true, release: {
      release_id: route.expected_release_id, release_git_sha: route.expected_git_sha,
      image_set_digest: route.expected_image_set_digest,
    } } }
    expect(() => assertCandidateRelease(valid, route)).not.toThrow()
    expect(() => assertCandidateRelease({ ...valid, data: { ...valid.data, ready: false } }, route)).toThrow(/wrong release/u)
    expect(() => assertCandidateRelease({ ...valid, data: { ...valid.data, release: { ...valid.data.release, release_git_sha: 'c'.repeat(40) } } }, route)).toThrow(/wrong release/u)
  })

  it('reads only owner-only regular route configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candidate-chatgpt-'))
    const path = join(realpathSync(dir), 'route.json')
    writeFileSync(path, JSON.stringify(route), { mode: 0o600 })
    expect(readCandidateRoute(path, route.origin).loopback_port).toBe(18443)
    expect(() => readCandidateRoute(path, 'https://other.example.com')).toThrow()
  })

  it('fails closed before sending credentials to any other origin', async () => {
    const restore = installCandidateFetchRoute(validateCandidateRoute(route, route.origin))
    try {
      await expect(fetch('https://other.example.com/mcp', { method: 'POST', headers: { authorization: 'Bearer never-send' } })).rejects.toThrow(/unapproved origin/u)
    } finally { restore() }
  })

  it('checks release identity before a Bearer token reaches the candidate', async () => {
    const calls: string[] = []
    const candidate = validateCandidateRoute(route, route.origin)
    const transport = async (_route: typeof candidate, url: string) => {
      calls.push(url)
      return Response.json({ data: { ready: true, release: { release_id: 'old-release' } } })
    }
    const restore = installCandidateFetchRoute(candidate, transport)
    try {
      await expect(fetch(`${route.origin}/mcp`, { method: 'POST', headers: { authorization: 'Bearer must-not-leak' }, body: '{}' })).rejects.toThrow(/wrong release/u)
      expect(calls).toEqual([`${route.origin}/releasez`])
    } finally { restore() }
  })
})
