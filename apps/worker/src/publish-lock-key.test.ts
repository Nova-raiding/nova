import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { publishLockKey, resolvePublishRemoteId } from './main.js'

const workspaceId = 'ws-lock-1'
const platform = 'jd'
const accountId = 'acct-lock-1'
const aggregateId = 'publish-job-77'

/** `publish.requested` payload as built by `publishEventPayload(job)` in the API. */
const publishPayload = (remoteId?: string, fieldRemoteId?: string) => ({
  platform,
  account_id: accountId,
  payload_hash: 'a'.repeat(64),
  idempotencyKey: 'idem-77',
  fields: { title: '商品标题', ...(fieldRemoteId ? { remoteId: fieldRemoteId } : {}) },
  ...(remoteId ? { remote_id: remoteId } : {}),
})

/** `publish.reconcile_requested` payload as built by `publishReconcileEventPayload(job)` in the API. */
const reconcilePayload = (remoteId?: string) => ({
  id: aggregateId,
  workspaceId,
  platform,
  account_id: accountId,
  payload_hash: 'a'.repeat(64),
  idempotencyKey: 'idem-77',
  ...(remoteId ? { remote_id: remoteId } : {}),
})

/** Mirrors the shared key derivation both handlers now use. */
const keyFor = (payload: Record<string, unknown>) => publishLockKey({
  workspaceId,
  platform: String(payload.platform),
  accountId: String(payload.account_id),
  remoteId: resolvePublishRemoteId(payload),
  aggregateId,
})

describe('publish/reconcile lock key', () => {
  it('derives the same key for a create job that has no remote id yet', () => {
    const publishKey = keyFor(publishPayload())
    const reconcileKey = keyFor(reconcilePayload())
    expect(reconcileKey).toBe(publishKey)
    expect(publishKey).toBe(`publish:${workspaceId}:${platform}:${accountId}:create:${aggregateId}`)
    // A missing remote id must never be interpolated as the literal string
    // `undefined`: that key is shared by every create job on the account and
    // provides no mutex against the create it is meant to observe.
    expect(publishKey).not.toContain('undefined')
    expect(reconcileKey).not.toContain('undefined')
  })

  it('derives the same key for a job that already has a remote id', () => {
    expect(keyFor(publishPayload('JD-REMOTE-9'))).toBe(keyFor(reconcilePayload('JD-REMOTE-9')))
    expect(keyFor(publishPayload('JD-REMOTE-9'))).toContain(':JD-REMOTE-9')
  })

  it('resolves the pre-execution fields.remoteId binding for both handlers', () => {
    // The publish handler writes with `fields.remoteId` when `remote_id` is
    // absent, so reconcile must key on the same id instead of an account-wide key.
    expect(resolvePublishRemoteId(publishPayload(undefined, 'JD-FIELD-9'))).toBe('JD-FIELD-9')
    expect(keyFor(publishPayload(undefined, 'JD-FIELD-9'))).toContain(':JD-FIELD-9')
  })

  it('keeps distinct create jobs on distinct keys', () => {
    const other = publishLockKey({ workspaceId, platform, accountId, aggregateId: 'publish-job-78' })
    expect(other).not.toBe(keyFor(publishPayload()))
  })

  it('is the only key derivation the publish and reconcile handlers use', () => {
    const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    // No handler may build a publish lock key inline any more.
    expect(source).not.toMatch(/lock\.run\(`publish:/u)
    // Both handlers derive the key through the same helper call, and both
    // resolve the remote id the same way.
    const shared = 'publishLockKey({ workspaceId: event.workspaceId, platform: String(platform), accountId, remoteId, aggregateId: event.aggregateId })'
    expect(source.split(shared)).toHaveLength(3)
    expect(source.split('resolvePublishRemoteId(payload)')).toHaveLength(3)
    expect(source.split('lock.run(lockKey, ')).toHaveLength(3)
  })
})
