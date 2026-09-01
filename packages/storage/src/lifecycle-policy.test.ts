import { describe, expect, it } from 'vitest'
import { decideStorageLifecycle, validateStorageLifecyclePolicy } from './lifecycle-policy.js'
const policy = { quarantineRetentionDays: 7, cleanRetentionDays: 30, deletionGraceDays: 7 }
const now = '2026-09-01T00:00:00.000Z'
describe('storage lifecycle policy', () => {
  it('retains referenced objects and deletes expired unreferenced objects', () => {
    expect(decideStorageLifecycle({ object: { key: 'clean/ws/a/file', zone: 'clean', createdAt: '2026-07-01T00:00:00Z', lastReferencedAt: '2026-08-31T00:00:00Z' }, policy, now })).toMatchObject({ action: 'retain', reason: 'active_reference' })
    expect(decideStorageLifecycle({ object: { key: 'quarantine/ws/a/file', zone: 'quarantine', createdAt: '2026-08-01T00:00:00Z' }, policy, now })).toMatchObject({ action: 'delete', reason: 'retention_expired' })
  })
  it('enforces minimum retention and deletion grace', () => {
    expect(() => validateStorageLifecyclePolicy({ ...policy, cleanRetentionDays: 1 })).toThrow('STORAGE_LIFECYCLE_POLICY_TOO_SHORT')
    expect(decideStorageLifecycle({ object: { key: 'clean/ws/a/file', zone: 'clean', createdAt: '2026-01-01T00:00:00Z', deletionRequestedAt: '2026-08-28T00:00:00Z' }, policy, now })).toMatchObject({ action: 'retain' })
    expect(decideStorageLifecycle({ object: { key: 'clean/ws/a/file', zone: 'clean', createdAt: '2026-01-01T00:00:00Z', deletionRequestedAt: '2026-08-20T00:00:00Z' }, policy, now })).toMatchObject({ action: 'delete', reason: 'deletion_grace_expired' })
  })

  it('fails closed for invalid lifecycle zones and future timestamps', () => {
    expect(() => decideStorageLifecycle({ object: { key: 'other/ws/a/file', zone: 'other' as never, createdAt: '2026-01-01T00:00:00Z' }, policy, now })).toThrow('STORAGE_LIFECYCLE_ZONE_INVALID')
    expect(() => decideStorageLifecycle({ object: { key: 'clean/ws/a/file', zone: 'clean', createdAt: '2026-09-02T00:00:00Z' }, policy, now })).toThrow('STORAGE_LIFECYCLE_CREATED_AT_IN_FUTURE')
    expect(() => decideStorageLifecycle({ object: { key: 'clean/ws/a/file', zone: 'clean', createdAt: '2026-01-01T00:00:00Z', deletionRequestedAt: '2026-09-02T00:00:00Z' }, policy, now })).toThrow('STORAGE_LIFECYCLE_DELETION_REQUEST_IN_FUTURE')
  })
})
