import { describe, expect, it, vi } from 'vitest'
import type { DurableOutboxEvent } from './durable.js'
import { createExecutionAuthorizationGuard, createUnavailableExecutionAuthorizationGuard, executeAfterAuthorizationCheck, type WorkerAuthorizationSnapshot } from './execution-authorization.js'

const now = Date.parse('2026-08-31T10:00:00.000Z')
function event(overrides: Record<string, unknown> = {}): DurableOutboxEvent {
  return {
    id: 'evt_publish', workspaceId: 'ws_a', aggregateId: 'publish_1', eventType: 'publish.requested', sequence: 1, createdAt: '2026-08-31T09:59:00.000Z',
    payload: {
      authorization_snapshot: {
        schema_version: 1, decision_id: 'decision_enqueue', actor_id: 'merchant_1', identity_id: 'identity_1', workspace_id: 'ws_a', workbench: 'workspace', context_id: 'workspace:ws_a', context_version: 'ctx_7', policy_version: 'policy_3', grant_revision: 'grant_11', grant_ids: [], scope_hash: 'a'.repeat(64), capability: 'publish.execute', resource_id: 'publish_1', resource_revision: '1', request_id: 'req_1', trace_id: 'trace_1', authorized: true, decided_at: '2026-08-31T09:59:00.000Z',
        ...overrides,
      },
    },
  }
}

describe('worker execution-time authorization', () => {
  it('binds the enqueue snapshot to fresh authoritative execution evidence', async () => {
    const recheck = vi.fn(async ({ snapshot }: { snapshot: WorkerAuthorizationSnapshot }) => ({
      recheckId: 'decision_execute', actorId: snapshot.actorId, identityId: snapshot.identityId, workspaceId: 'ws_a', workbench: 'workspace' as const, contextId: 'workspace:ws_a', contextVersion: 'ctx_8', policyVersion: 'policy_4', grantRevision: 'grant_12', grantIds: snapshot.grantIds, scopeHash: snapshot.scopeHash, capability: 'publish.execute' as const, resourceId: 'publish_1', resourceRevision: snapshot.resourceRevision, requestId: snapshot.requestId, traceId: snapshot.traceId, authorized: true, checkedAt: '2026-08-31T09:59:59.000Z',
    }))
    const guard = createExecutionAuthorizationGuard(recheck, { now: () => now })
    await expect(guard.assertAuthorized(event(), 'publish.execute')).resolves.toMatchObject({ recheckId: 'decision_execute', authorized: true })
    expect(recheck).toHaveBeenCalledOnce()
  })

  it('fails closed before recheck when the durable snapshot is missing or cross-tenant', async () => {
    const recheck = vi.fn()
    const guard = createExecutionAuthorizationGuard(recheck, { now: () => now })
    await expect(guard.assertAuthorized({ ...event(), payload: {} }, 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID', retryable: false })
    await expect(guard.assertAuthorized(event({ workspace_id: 'ws_b' }), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' })
    await expect(guard.assertAuthorized(event({ scope_hash: undefined }), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' })
    await expect(guard.assertAuthorized(event({ trace_id: undefined }), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' })
    expect(recheck).not.toHaveBeenCalled()
  })

  it('rejects revoke, stale evidence and resource substitution', async () => {
    const base = { recheckId: 'decision_execute', actorId: 'merchant_1', identityId: 'identity_1', workspaceId: 'ws_a', workbench: 'workspace' as const, contextId: 'workspace:ws_a', contextVersion: 'ctx_8', policyVersion: 'policy_4', grantRevision: 'grant_12', grantIds: [] as string[], scopeHash: 'a'.repeat(64), capability: 'publish.execute' as const, resourceId: 'publish_1', resourceRevision: '1', requestId: 'req_1', traceId: 'trace_1', authorized: true, checkedAt: '2026-08-31T09:59:59.000Z' }
    await expect(createExecutionAuthorizationGuard(async () => ({ ...base, authorized: false }), { now: () => now }).assertAuthorized(event(), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RECHECK_DENIED', retryable: false })
    await expect(createExecutionAuthorizationGuard(async () => ({ ...base, checkedAt: '2026-08-31T09:00:00.000Z' }), { now: () => now }).assertAuthorized(event(), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RECHECK_INVALID', retryable: true })
    await expect(createExecutionAuthorizationGuard(async () => ({ ...base, resourceId: 'publish_2' }), { now: () => now }).assertAuthorized(event(), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RECHECK_INVALID' })
    await expect(createExecutionAuthorizationGuard(async () => ({ ...base, scopeHash: 'b'.repeat(64) }), { now: () => now }).assertAuthorized(event(), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RECHECK_INVALID' })
    await expect(createExecutionAuthorizationGuard(async () => ({ ...base, identityId: 'identity_2' }), { now: () => now }).assertAuthorized(event(), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RECHECK_INVALID' })
  })

  it('does not call the provider for a queued event after its grant is revoked', async () => {
    const provider = vi.fn(async () => 'sent')
    const guard = createExecutionAuthorizationGuard(async () => ({
      recheckId: 'decision_execute', actorId: 'merchant_1', identityId: 'identity_1', workspaceId: 'ws_a', workbench: 'workspace', contextId: 'workspace:ws_a', contextVersion: 'ctx_8', policyVersion: 'policy_4', grantRevision: 'grant_12', grantIds: [], scopeHash: 'a'.repeat(64), capability: 'publish.execute', resourceId: 'publish_1', resourceRevision: '1', requestId: 'req_1', traceId: 'trace_1', authorized: false, checkedAt: '2026-08-31T09:59:59.000Z',
    }), { now: () => now })
    await expect(executeAfterAuthorizationCheck({ guard, event: event({}), operation: 'publish.execute', providerCall: provider })).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RECHECK_DENIED', retryable: false })
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['scope', { scopeHash: 'b'.repeat(64), resourceRevision: undefined }],
    ['revision', { scopeHash: undefined, resourceRevision: '2' }],
  ])('does not call the provider for a queued event after %s mismatch', async (_kind, mismatch) => {
    const provider = vi.fn(async () => 'sent')
    const guard = createExecutionAuthorizationGuard(async ({ snapshot }) => ({
      recheckId: 'decision_execute', actorId: snapshot.actorId, identityId: snapshot.identityId, workspaceId: 'ws_a', workbench: 'workspace', contextId: 'workspace:ws_a', contextVersion: 'ctx_8', policyVersion: 'policy_4', grantRevision: 'grant_12', grantIds: snapshot.grantIds, scopeHash: mismatch.scopeHash ?? snapshot.scopeHash, capability: 'publish.execute', resourceId: 'publish_1', resourceRevision: mismatch.resourceRevision ?? snapshot.resourceRevision, requestId: snapshot.requestId, traceId: snapshot.traceId, authorized: true, checkedAt: '2026-08-31T09:59:59.000Z',
    }), { now: () => now })
    await expect(executeAfterAuthorizationCheck({ guard, event: event({}), operation: 'publish.execute', providerCall: provider })).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RECHECK_INVALID', retryable: true })
    expect(provider).not.toHaveBeenCalled()
  })

  it('exposes an explicit unavailable-authority blocker instead of manufacturing an allow', async () => {
    await expect(createUnavailableExecutionAuthorizationGuard().assertAuthorized(event(), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RECHECK_UNAVAILABLE', retryable: true })
  })

  it('supports a redriven asset scan capability without weakening its event binding', async () => {
    const scanEvent = {
      ...event({ capability: 'asset.scan.execute', resource_id: 'asset_1' }),
      id: 'evt_scan_redrive', aggregateId: 'asset_1', eventType: 'asset.scan_redrive_requested',
    }
    const guard = createExecutionAuthorizationGuard(async ({ snapshot }) => ({
      recheckId: 'decision_scan_execute', actorId: snapshot.actorId, identityId: snapshot.identityId, workspaceId: 'ws_a', workbench: 'workspace', contextId: 'workspace:ws_a', contextVersion: 'ctx_8', policyVersion: 'policy_4', grantRevision: 'grant_12', grantIds: snapshot.grantIds, scopeHash: snapshot.scopeHash, capability: 'asset.scan.execute', resourceId: 'asset_1', resourceRevision: snapshot.resourceRevision, requestId: snapshot.requestId, traceId: snapshot.traceId, authorized: true, checkedAt: '2026-08-31T09:59:59.000Z',
    }), { now: () => now })
    await expect(guard.assertAuthorized(scanEvent, 'asset.scan.execute')).resolves.toMatchObject({ authorized: true, capability: 'asset.scan.execute' })
    await expect(guard.assertAuthorized({ ...scanEvent, aggregateId: 'asset_2' }, 'asset.scan.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' })
  })
})
