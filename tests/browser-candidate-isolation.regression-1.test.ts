import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { assertCandidateGitState, assertContainerOwnership, assertLocalDockerEndpoint, assertProbeIdentity, assertUnoccupiedPorts, candidateConfiguration, verifyBrowserIdentity } from '../scripts/merchant-browser-candidate.js'

// Regression: ISSUE-001 — HTTP-success SSH tunnels were accepted as the current browser candidate.
// Found by /qa on 2026-09-15
// Report: .gstack/qa-reports/qa-report-merchant-candidate-2026-09-15.md
const sha = 'a'.repeat(40)
const ports = [28081, 28082, 28787, 15439, 16389]
const candidate = () => candidateConfiguration({}, sha, ports, '0123456789ab')

describe('browser candidate isolation', () => {
  it('refuses staged or unstaged tracked changes, an unfinished merge and untracked source', () => {
    expect(() => assertCandidateGitState(false, false, false)).not.toThrow()
    for (const state of [[true, false, false], [false, true, false], [false, false, true]] as const) expect(() => assertCandidateGitState(state[0], state[1], state[2])).toThrow(/clean tracked worktree, no MERGE_HEAD/)
  })
  it('keeps random candidate ports, project, images and child URLs in one environment', () => {
    const value = candidate()
    expect(value.project).toBe('merchant-browser-aaaaaaaaaaaa-0123456789ab')
    expect(value.env).toMatchObject({
      COMPOSE_PROJECT_NAME: value.project, LOCAL_API_IMAGE: value.apiImage, LOCAL_OPS_UI_IMAGE: value.opsImage,
      LOCAL_UI_PORT: '28081', LOCAL_OPS_UI_PORT: '28082', LOCAL_API_PORT: '28787', LOCAL_POSTGRES_PORT: '15439', LOCAL_REDIS_PORT: '16389',
      MERCHANT_STUDIO_URL: 'http://127.0.0.1:28081/', OPS_BASE_URL: 'http://127.0.0.1:28082/', RELEASE_ID: value.releaseId, RELEASE_GIT_SHA: sha,
    })
    expect(candidateConfiguration({}, sha, ports, '1123456789ab').project).not.toBe(value.project)
  })

  it('refuses documented SSH ports and silently supplied deployed URLs', () => {
    for (const port of [18081, 18082, 8787, 54329, 63799]) expect(() => candidateConfiguration({}, sha, [port, ...ports.slice(1)], '0123456789ab')).toThrow(/isolated ports/)
    expect(() => candidateConfiguration({ MERCHANT_STUDIO_URL: 'http://127.0.0.1:18081/' }, sha, ports, '0123456789ab')).toThrow(/explicit BROWSER_STACK_MODE=external/)
    expect(() => candidateConfiguration({}, sha, [28081, 28081, 28787, 15439, 16389], '0123456789ab')).toThrow(/distinct/)
  })

  it('requires external opt-in, full expected SHA and release ID', () => {
    const external = { BROWSER_STACK_MODE: 'external', MERCHANT_STUDIO_URL: 'http://127.0.0.1:18081/', OPS_BASE_URL: 'http://127.0.0.1:18082/' }
    expect(() => candidateConfiguration(external, '', [], '')).toThrow(/BROWSER_EXPECTED_RELEASE_GIT_SHA/)
    expect(() => candidateConfiguration({ ...external, BROWSER_EXPECTED_RELEASE_GIT_SHA: sha }, '', [], '')).toThrow(/BROWSER_EXPECTED_RELEASE_ID/)
    expect(candidateConfiguration({ ...external, BROWSER_EXPECTED_RELEASE_GIT_SHA: sha, BROWSER_EXPECTED_RELEASE_ID: 'release-1' }, '', [], '').mode).toBe('external')
  })

  it('rejects remote Docker contexts and stale API or static UI identities', () => {
    expect(() => assertLocalDockerEndpoint('unix:///var/run/docker.sock')).not.toThrow()
    for (const endpoint of ['ssh://101', 'tcp://101:2375', 'https://docker.example.com']) expect(() => assertLocalDockerEndpoint(endpoint)).toThrow(/remote Docker/)
    const value = candidate()
    expect(() => assertProbeIdentity({ data: { release: { release_id: value.releaseId, release_git_sha: sha } } }, value, 'api')).not.toThrow()
    expect(() => assertProbeIdentity({ data: { release: { release_id: null, release_git_sha: null } } }, value, 'api')).toThrow(/identity mismatch/)
    expect(() => assertProbeIdentity({ release_id: value.releaseId, release_git_sha: 'b'.repeat(40), surface: 'merchant-ui' }, value, 'ui', 'merchant-ui')).toThrow(/identity mismatch/)
    expect(() => assertProbeIdentity({ release_id: 'old-release', release_git_sha: sha, surface: 'ops-ui' }, value, 'ui', 'ops-ui')).toThrow(/identity mismatch/)
  })

  it('refuses an existing listener instead of reusing its successful response', async () => {
    const server = createServer((_request, response) => response.end('old runtime'))
    try {
      await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture port missing')
      await expect(assertUnoccupiedPorts([address.port])).rejects.toThrow(/already occupied; refusing to reuse any listener/)
    } finally { await new Promise<void>(accept => server.close(() => accept())) }
  })

  it('refuses containers from another project or the globally shared API image', () => {
    const value = candidate()
    const own = { Config: { Labels: { 'com.docker.compose.project': value.project!, 'com.docker.compose.service': 'api' }, Image: value.apiImage! } }
    expect(() => assertContainerOwnership(own, value, 'api')).not.toThrow()
    expect(() => assertContainerOwnership({ Config: { ...own.Config, Labels: { ...own.Config.Labels, 'com.docker.compose.project': 'local' } } }, value, 'api')).toThrow(/ownership labels/)
    expect(() => assertContainerOwnership({ Config: { ...own.Config, Image: 'local-api' } }, value, 'api')).toThrow(/incorrect image tag/)
  })

  it('probes both static UI builds and same-origin APIs without browser interaction', async () => {
    let staleOps = false
    const paths: string[] = []
    const servers = ['merchant-ui', 'ops-ui'].map(surface => createServer((request, response) => {
      paths.push(`${surface}:${request.url}`)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(request.url === '/releasez'
        ? { data: { release: { release_id: 'release-1', release_git_sha: sha } } }
        : { surface, release_id: 'release-1', release_git_sha: staleOps && surface === 'ops-ui' ? 'b'.repeat(40) : sha }))
    }))
    try {
      await Promise.all(servers.map(server => new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))))
      const urls = servers.map(server => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture port missing'); return `http://127.0.0.1:${address.port}/` })
      const value = candidateConfiguration({ BROWSER_STACK_MODE: 'external', BROWSER_EXPECTED_RELEASE_GIT_SHA: sha, BROWSER_EXPECTED_RELEASE_ID: 'release-1', MERCHANT_STUDIO_URL: urls[0], OPS_BASE_URL: urls[1] }, '', [], '')
      await expect(verifyBrowserIdentity(value)).resolves.toBeUndefined()
      expect(paths).toEqual(['merchant-ui:/releasez', 'ops-ui:/releasez', 'merchant-ui:/build-meta.json', 'ops-ui:/build-meta.json'])
      staleOps = true
      await expect(verifyBrowserIdentity(value)).rejects.toThrow(/ops-ui candidate identity mismatch/)
    } finally { await Promise.all(servers.map(server => new Promise<void>(accept => server.close(() => accept())))) }
  })

  it('wires forced candidate builds, ownership checks and non-secret build metadata', () => {
    const harness = readFileSync('scripts/merchant-browser-candidate.ts', 'utf8')
    expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:browser:merchant']).toBe('node --import tsx scripts/merchant-browser-candidate.ts')
    expect(harness).toContain("'--build', '--force-recreate'")
    expect(harness).toContain("'com.docker.compose.project'")
    expect(harness).toContain("'com.docker.compose.service'")
    expect(harness).toContain('refusing to reuse any listener')
    expect(harness).toContain("'--env-file', '/dev/null'")
    expect(readFileSync('infra/local/docker-compose.yml', 'utf8')).toContain('${LOCAL_API_IMAGE:-local-api}')
    expect(readFileSync('infra/local/docker-compose.yml', 'utf8')).toContain('${LOCAL_OPS_UI_IMAGE:-local-ops-ui}')
    for (const file of ['infra/docker/ui.Dockerfile', 'infra/docker/ops-console.Dockerfile']) {
      const dockerfile = readFileSync(file, 'utf8')
      expect(dockerfile).toContain('ARG RELEASE_GIT_SHA=unbound')
      expect(dockerfile).toContain('build-meta.json')
      expect(dockerfile).not.toContain('printenv')
    }
  })
})
