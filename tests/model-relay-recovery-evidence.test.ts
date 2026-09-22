import { describe, expect, it } from 'vitest'
import { buildRelayRecoveryEvidence } from '../scripts/model-relay-recovery-evidence.js'

const failure = { release_id: 'release-9df84aa1', observed_at: '2026-09-22T01:00:00Z', http_status: 503, provider_request_id: 'provider-failed', relay: 'https://relay.example.com', endpoint: '/chat/completions' }
const recovery = { ...failure, observed_at: '2026-09-22T01:01:00Z', http_status: 200, provider_request_id: 'provider-recovered' }

describe('model relay recovery evidence', () => {
  it('binds a passive real 503 and later recovery without generating either request', () => {
    expect(buildRelayRecoveryEvidence(failure, recovery, 'release-9df84aa1')).toMatchObject({ verified: true, failure_status: 503, failed_request_id: 'provider-failed', recovery_request_id: 'provider-recovered' })
  })
  it('rejects fabricated-looking or unrelated capture pairs', () => {
    expect(() => buildRelayRecoveryEvidence({ ...failure, http_status: 500 }, recovery, 'release-9df84aa1')).toThrow('HTTP 503')
    expect(() => buildRelayRecoveryEvidence(failure, { ...recovery, provider_request_id: 'provider-failed' }, 'release-9df84aa1')).toThrow('distinct')
    expect(() => buildRelayRecoveryEvidence(failure, { ...recovery, release_id: 'old-release' }, 'release-9df84aa1')).toThrow('requested release')
  })
})
