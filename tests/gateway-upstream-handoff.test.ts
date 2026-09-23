import { describe, expect, it } from 'vitest'
import { rewriteApiUpstream, sha256 } from '../infra/scripts/rotation/gateway-upstream-handoff.mjs'

const old = 'merchant-production-api-replica-1'
const next = 'merchant-production-api-rotated-1'
const config = `events {}\nupstream pilot_api {\n  zone pilot_api 64k;\n  resolver 127.0.0.11 valid=10s ipv6=off;\n  server ${old}:8787 resolve;\n}\nserver {\n  proxy_pass http://pilot_api;\n}\n`

describe('gateway API upstream handoff', () => {
  it('changes exactly the API target and supports digest-bound reversal', () => {
    const changed = rewriteApiUpstream(config, old, next)
    expect(changed.before_sha256).toBe(sha256(config))
    expect(changed.after_sha256).toBe(sha256(changed.config))
    expect(changed.config).toBe(config.replace(`${old}:8787 resolve`, `${next}:8787 resolve`))
    expect(rewriteApiUpstream(changed.config, next, old).config).toBe(config)
  })

  it('rejects a changed target, extra target, and duplicate block', () => {
    expect(() => rewriteApiUpstream(config, 'api-replica', next)).toThrow('API_UPSTREAM_SERVER_DRIFT')
    expect(() => rewriteApiUpstream(config.replace('}\nserver', `  server second:8787 resolve;\n}\nserver`), old, next)).toThrow('API_UPSTREAM_SERVER_DRIFT')
    expect(() => rewriteApiUpstream(config + config, old, next)).toThrow('API_UPSTREAM_BLOCK_NOT_UNIQUE')
  })

  it('rejects invalid hostnames and no-op changes', () => {
    expect(() => rewriteApiUpstream(config, old, old)).toThrow('INVALID_GATEWAY_HANDOFF_INPUT')
    expect(() => rewriteApiUpstream(config, old, 'bad; include secret')).toThrow('INVALID_GATEWAY_HANDOFF_INPUT')
  })
})
