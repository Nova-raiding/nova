import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function location(source: string, declaration: string) {
  return source.split(`${declaration} {`)[1]?.split('}')[0] ?? ''
}

describe('Nginx upload and payment callback body boundaries', () => {
  it.each(['merchant-studio', 'ops-console'])('allows upload-capable browser RPC and REST without widening %s callback aliases', name => {
    const source = readFileSync(`infra/nginx/${name}.conf`, 'utf8')
    for (const path of ['/api/mcp', '/api/v1/assets/upload']) {
      expect(location(source, `location = ${path}`)).toContain('client_max_body_size 70m;')
    }
    expect(location(source, 'location /api/')).toContain('client_max_body_size 1m;')
  })

  it.each(['pilot-gateway', 'pilot-gateway-https'])('keeps real plugin, REST, and operations uploads reachable through %s', name => {
    const source = readFileSync(`infra/nginx/${name}.conf`, 'utf8')
    for (const path of ['/mcp', '/api/mcp', '/v1/assets/upload', '/api/v1/assets/upload', '/ops/api/mcp', '/ops/api/v1/assets/upload']) {
      const upload = location(source, `location = ${path}`)
      expect(upload, path).toContain('client_max_body_size 70m;')
      expect(upload, path).toContain('proxy_set_header Authorization $http_authorization;')
    }
    for (const prefix of ['/api/', '/ops/']) {
      expect(location(source, `location ^~ ${prefix}`)).toContain('client_max_body_size 1m;')
    }
    if (name.endsWith('https')) {
      expect(location(source, 'location ^~ /v1/')).toContain('client_max_body_size 1m;')
      expect(location(source, 'location ^~ /payment-gateway/')).toContain('client_max_body_size 1m;')
    }
  })
})
