import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type ComposeService = {
  build?: { dockerfile?: string; args?: Record<string, string> }
  depends_on?: Record<string, { condition?: string }>
  environment?: Record<string, string>
  healthcheck?: { test?: string[] }
  ports?: Array<{ host_ip?: string; published?: string; target?: number }>
}

type ComposeConfig = { services: Record<string, ComposeService> }

function renderedCompose(): ComposeConfig {
  const output = execFileSync(
    'docker',
    ['compose', '-f', 'infra/local/docker-compose.yml', 'config', '--format', 'json'],
    { encoding: 'utf8' },
  )
  return JSON.parse(output) as ComposeConfig
}

describe('local Compose Ops UI', () => {
  it('builds and serves an independent local-auth Ops Console through its API proxy', () => {
    const services = renderedCompose().services
    const merchantUi = services.ui
    const opsUi = services['ops-ui']
    const api = services.api
    const apiReplica = services['api-replica']

    expect(merchantUi?.build?.dockerfile).toBe('infra/docker/ui.Dockerfile')
    expect(merchantUi?.ports).toContainEqual(expect.objectContaining({ host_ip: '127.0.0.1', published: '18081', target: 8080 }))

    expect(opsUi?.build?.dockerfile).toBe('infra/docker/ops-console.Dockerfile')
    expect(opsUi?.build?.args).toMatchObject({
      OPS_CONSOLE_BUILD_MODE: 'local',
      VITE_API_BASE: '/api',
      VITE_OPS_AUTH_MODE: 'local',
    })
    expect(opsUi?.environment?.OPS_API_UPSTREAM).toBe('http://api:8787')
    expect(opsUi?.ports).toContainEqual(expect.objectContaining({ host_ip: '127.0.0.1', published: '18082', target: 8080 }))
    expect(opsUi?.depends_on?.api?.condition).toBe('service_healthy')
    expect(opsUi?.healthcheck?.test?.join(' ')).toContain('127.0.0.1:8080/api/readyz')
    expect(opsUi?.healthcheck?.test?.join(' ')).toContain('Merchant Operations Console')

    // Local Compose carries bootstrap credentials and must never publish them
    // on a LAN-facing interface by default.
    expect(api?.ports).toContainEqual(expect.objectContaining({ host_ip: '127.0.0.1', published: '8787', target: 8787 }))
    expect(apiReplica?.ports).toContainEqual(expect.objectContaining({ host_ip: '127.0.0.1', published: '8788', target: 8787 }))

    const apiHealthcheck = api?.healthcheck?.test?.join(' ') ?? ''
    expect(apiHealthcheck).toContain('127.0.0.1:8787/readyz')
    expect(apiHealthcheck).toContain('Authorization: Bearer')
    expect(apiHealthcheck).not.toContain('ASSET_SCAN_TRUSTED_PUBLIC_KEYS')
  })

  it('keeps all host-published local services on loopback', () => {
    const services = renderedCompose().services
    for (const name of ['ui', 'ops-ui', 'api', 'api-replica', 'postgres', 'redis']) {
      for (const port of services[name]?.ports ?? []) {
        expect(port.host_ip, `${name} must not publish beyond loopback`).toBe('127.0.0.1')
      }
    }
  })

  it('does not report the scanner healthy before its fail-closed readiness heartbeat is proven', () => {
    const scanner = renderedCompose().services['worker-scan']
    const healthcheck = scanner?.healthcheck?.test?.join(' ') ?? ''

    expect(healthcheck).toContain('test -s /tmp/merchant-worker-$${WORKER_ROLE}-ready')
    expect(healthcheck).toContain('process.kill(1, 0)')
    expect(healthcheck).not.toMatch(/process\.kill\(1, 0\).*\|\| exit 1$/)
  })

  it('keeps the removed feature-flags page unavailable at the served nginx boundary', () => {
    const nginxConfig = readFileSync('infra/nginx/ops-console.conf', 'utf8')

    expect(nginxConfig).toContain('^/(?:.*?/)?ops/feature-flags/?$')
    expect(nginxConfig).toContain('add_header Cache-Control "no-store" always;')
    expect(nginxConfig).toContain('return 404 "feature-flags page has been removed";')
  })
})
