import { describe, expect, it } from 'vitest'
import { MemoryReconciliationEvidenceRepository, PostgresReconciliationEvidenceRepository, ReconciliationEvidenceIdempotencyConflictError } from './reconciliation-evidence-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class RecordingClient implements SqlClient {
  readonly calls: string[] = []
  private responses: Array<{ rows: any[] }> = []
  enqueue(...rows: any[]) { this.responses.push({ rows }) }
  async query<T = Record<string, unknown>>(text: string) { this.calls.push(text); return (this.responses.shift() ?? { rows: [] }) as { rows: T[] } }
  release() {}
}

const input = {
  workspaceId: 'ws-a', jobId: 'job-1', executionAttempt: 1, providerRequestId: 'provider-1', queryAttempt: 1,
  idempotencyKey: 'job-1:execution-1:query-1', providerState: 'processing' as const,
  responseDigest: 'a'.repeat(64), observedAt: '2026-08-31T00:00:00.000Z', nextAttemptAt: '2026-08-31T00:01:00.000Z',
}

describe('reconciliation evidence repository', () => {
  it('stores immutable per-query evidence and replays an identical attempt', async () => {
    const repository = new MemoryReconciliationEvidenceRepository()
    const first = await repository.append(input)
    expect(await repository.append(input)).toEqual(first)
    expect(await repository.getLatest({ workspaceId: 'ws-a', jobId: 'job-1' })).toEqual(first)
    expect(await repository.list({ workspaceId: 'ws-a', jobId: 'job-1' })).toEqual([first])
    expect(await repository.list({ workspaceId: 'ws-b' })).toEqual([])
  })

  it('rejects idempotency-key reuse with different evidence', async () => {
    const repository = new MemoryReconciliationEvidenceRepository()
    await repository.append(input)
    await expect(repository.append({ ...input, providerState: 'unknown', nextAttemptAt: undefined })).rejects.toBeInstanceOf(ReconciliationEvidenceIdempotencyConflictError)
  })

  it('requires failure details and rejects invalid attempts', async () => {
    const repository = new MemoryReconciliationEvidenceRepository()
    await expect(repository.append({ ...input, providerState: 'failed' })).rejects.toThrow('RECONCILIATION_EVIDENCE_FAILURE_DETAILS_REQUIRED')
    await expect(repository.append({ ...input, providerState: 'unknown', errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'status query timed out', idempotencyKey: 'job-1:execution-1:query-2' })).resolves.toMatchObject({ providerState: 'unknown', errorCode: 'PROVIDER_TIMEOUT' })
    await expect(repository.append({ ...input, queryAttempt: 0 })).rejects.toThrow('RECONCILIATION_EVIDENCE_QUERY_ATTEMPT_INVALID')
  })

  it('writes and reads evidence through a workspace-scoped Postgres transaction', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue() // idempotency lookup
    client.enqueue({ id: 'evidence-1', workspace_id: 'ws-a', job_id: 'job-1', execution_attempt: 1, provider_request_id: 'provider-1', query_attempt: 1, idempotency_key: input.idempotencyKey, provider_state: 'processing', provider_status: null, response_digest: input.responseDigest, artifact_digest: null, usage_ledger_id: null, action_ledger_id: null, usage: null, cost: null, observed_at: input.observedAt, next_attempt_at: input.nextAttemptAt, error_code: null, error_message: null, created_at: input.observedAt })
    client.enqueue() // COMMIT
    const repository = new PostgresReconciliationEvidenceRepository({ connect: async () => client } satisfies SqlPool)
    const row = await repository.append(input)
    expect(row).toMatchObject({ id: 'evidence-1', workspaceId: 'ws-a', providerRequestId: 'provider-1', responseDigest: input.responseDigest })
    expect(client.calls).toContain('SELECT id,workspace_id,job_id,execution_attempt,provider_request_id,query_attempt,idempotency_key,provider_state,provider_status,response_digest,artifact_digest,usage_ledger_id,action_ledger_id,usage,cost,observed_at,next_attempt_at,error_code,error_message,created_at FROM reconciliation_evidence WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE')
  })
})
