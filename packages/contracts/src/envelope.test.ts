import { describe, expect, it } from 'vitest'
import { failure, success, type ApiEnvelope, type JobEnvelope } from './index.js'

describe('API and job envelopes', () => {
  it('uses the same serialized shape for successful responses', () => {
    const response: ApiEnvelope<{ ok: boolean }> = success({
      request_id: 'req_1', trace_id: 'tr_1' as never, workspace_id: 'ws_1' as never,
      data: { ok: true }, warnings: [], next_actions: [],
    })
    expect(response).toEqual({ request_id: 'req_1', trace_id: 'tr_1', workspace_id: 'ws_1', data: { ok: true }, warnings: [], next_actions: [], error: null })
  })

  it('never puts a job payload or credential in the job envelope', () => {
    const job: JobEnvelope = {
      job_id: 'job_1' as never, job_type: 'publish.product.update', workspace_id: 'ws_1' as never,
      actor_id: 'actor_1' as never, platform: 'tmall', account_id: 'acct_1' as never,
      task_id: 'task_1' as never, content_version_id: 'cv_1' as never,
      idempotency_key: 'sha256:key', attempt: 0, trace_id: 'tr_1' as never,
      created_at: '2026-08-22T00:00:00.000Z', not_before: null, quota_class: 'merchant_interactive',
    }
    expect(job).not.toHaveProperty('access_token')
    expect(failure({ request_id: 'req_2', trace_id: 'tr_1' as never, workspace_id: 'ws_1' as never, warnings: [], next_actions: [], error: { code: 'INVALID_REQUEST', message: 'bad' } })).toMatchObject({ data: null, error: { code: 'INVALID_REQUEST' } })
  })
})
