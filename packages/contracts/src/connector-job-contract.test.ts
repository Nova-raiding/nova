import { describe, expect, it } from 'vitest'
import { PLATFORMS, type PlatformConnector, type ConnectorContext, type PlatformWriteDraft, type JobEnvelope } from './index.js'

describe('connector and job contracts', () => {
  it('requires every connector operation and preserves workspace/account/trace context', () => {
    const context: ConnectorContext = { workspace_id: 'ws_1' as never, account_id: 'acct_1' as never, trace_id: 'trace_1' as never }
    const draft: PlatformWriteDraft = { remote_id: 'remote_1', fields: { title: 'Product' }, field_allowlist: ['title'] }
    const connector: PlatformConnector = {
      platform: 'tmall',
      authorize: async () => ({ authorization_url: 'https://example.test/oauth', state_expires_at: '2026-09-01T01:00:00Z' }),
      exchangeCode: async () => ({ secret_ref: 'vault://credential/1', platform: 'tmall', account_id: context.account_id, refreshable: true }),
      refreshCredential: async ref => ref,
      revoke: async () => undefined,
      listStores: async () => ({ items: [], next_cursor: undefined }),
      syncProducts: async () => ({ items: [], next_cursor: undefined }),
      getProduct: async () => ({ remote_id: 'remote_1', payload_ref: 'artifact://raw/1', observed_at: '2026-09-01T00:00:00Z' }),
      mapToCanonical: raw => ({ remote_id: raw.remote_id, fields: {} }),
      validateWrite: input => input.field_allowlist.includes('title') ? [] : [{ path: 'title', code: 'REQUIRED', message: 'title required', severity: 'error' }],
      createProduct: async () => ({ remote_id: 'remote_1', request_id: 'req_1', accepted_at: '2026-09-01T00:00:00Z' }),
      updateProduct: async () => ({ remote_id: 'remote_1', request_id: 'req_2', accepted_at: '2026-09-01T00:00:00Z' }),
      queryWrite: async () => ({ state: 'published', remote_id: 'remote_1' }),
      normalizeError: () => ({ code: 'PLATFORM_REQUEST_FAILED', message: 'failed', retryable: true, raw_code: 'E_TEST' }),
    }
    expect(PLATFORMS).toHaveLength(6)
    expect(connector.platform).toBe('tmall')
    expect(connector.validateWrite(draft)).toEqual([])
    expect(connector.normalizeError(new Error('raw'))).toEqual(expect.objectContaining({ retryable: true, raw_code: 'E_TEST' }))
  })

  it('keeps jobs traceable, retryable by attempt, and free of credentials or payloads', () => {
    const job: JobEnvelope = {
      job_id: 'job_1' as never, job_type: 'sync.platform', workspace_id: 'ws_1' as never, actor_id: 'actor_1' as never,
      platform: 'jd', account_id: 'acct_1' as never, remote_snapshot_id: 'snapshot_1', idempotency_key: 'idem_1', attempt: 2,
      trace_id: 'trace_1' as never, created_at: '2026-09-01T00:00:00Z', not_before: null, quota_class: 'merchant_background',
    }
    expect(job.attempt).toBeGreaterThanOrEqual(0)
    expect(job).toHaveProperty('workspace_id', 'ws_1')
    expect(job).toHaveProperty('trace_id', 'trace_1')
    expect(job).not.toHaveProperty('access_token')
    expect(job).not.toHaveProperty('payload')
  })
})
