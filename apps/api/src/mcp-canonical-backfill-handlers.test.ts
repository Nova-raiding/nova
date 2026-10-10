import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { handleMcpCanonicalBackfill, type McpCanonicalBackfillDependencies } from './mcp-canonical-backfill-handlers.js'

const depsWithConflicts = (conflicts: Record<string, ReturnType<typeof vi.fn>>) => ({
  persistenceReady: Promise.resolve(),
  getPersistence: () => ({ mode: 'postgres', canonicalBackfillRuns: {}, canonicalBackfillConflicts: conflicts }),
  requireOperationsRole: vi.fn(() => 'platform_ops'),
  requestActor: vi.fn(() => 'operator-1'),
  recordOperationAudit: vi.fn(async () => undefined),
}) as unknown as McpCanonicalBackfillDependencies

describe('canonical backfill workspace scope', () => {
  it('rejects a missing workspace before persistence access', async () => {
    const requireOperationsRole = vi.fn(() => 'platform_ops')
    const getPersistence = vi.fn(() => { throw new Error('persistence must not be accessed') })
    const deps = {
      persistenceReady: Promise.resolve(), getPersistence, requireOperationsRole,
      requestActor: vi.fn(() => 'actor-id'), recordOperationAudit: vi.fn(),
    }

    await expect(handleMcpCanonicalBackfill(
      'ops.canonical.backfill.conflicts.list', {}, {} as IncomingMessage, '', deps,
    )).rejects.toMatchObject({ code: ERROR_CODES.WORKSPACE_SCOPE_REQUIRED, status: 400 })

    expect(requireOperationsRole).toHaveBeenCalledOnce()
    expect(getPersistence).not.toHaveBeenCalled()
  })

  it('rejects an unsupported conflict filter instead of silently returning an empty queue', async () => {
    const list = vi.fn(async () => [])
    const deps = depsWithConflicts({ list })

    await expect(handleMcpCanonicalBackfill(
      'ops.canonical.backfill.conflicts.list', { status: 'waiting' }, {} as IncomingMessage, 'workspace-a', deps,
    )).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST, status: 400 })

    expect(list).not.toHaveBeenCalled()
  })

  it.each([42, [], {}, '  '])('rejects a malformed conflict status filter before repository access: %j', async status => {
    const list = vi.fn(async () => [])
    const deps = depsWithConflicts({ list })

    await expect(handleMcpCanonicalBackfill(
      'ops.canonical.backfill.conflicts.list', { status }, {} as IncomingMessage, 'workspace-a', deps,
    )).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST, status: 400 })

    expect(list).not.toHaveBeenCalled()
  })

  it.each([0, 501])('rejects conflict list limit outside 1..500 before repository access: %s', async limit => {
    const list = vi.fn(async () => [])
    const deps = depsWithConflicts({ list })

    await expect(handleMcpCanonicalBackfill(
      'ops.canonical.backfill.conflicts.list', { limit }, {} as IncomingMessage, 'workspace-a', deps,
    )).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST, status: 400 })

    expect(list).not.toHaveBeenCalled()
  })

  it.each([1, 500])('passes valid conflict list boundary %s to repository', async limit => {
    const list = vi.fn(async () => [])
    const deps = depsWithConflicts({ list })

    await expect(handleMcpCanonicalBackfill(
      'ops.canonical.backfill.conflicts.list', { limit }, {} as IncomingMessage, 'workspace-a', deps,
    )).resolves.toEqual([])

    expect(list).toHaveBeenCalledWith({ workspaceId: 'workspace-a', limit })
  })

  it.each([0, 5001])('rejects create batch_limit outside repository range 1..5000 before create: %s', async batch_limit => {
    const create = vi.fn()
    const deps = {
      persistenceReady: Promise.resolve(),
      getPersistence: () => ({ mode: 'postgres', canonicalBackfillRuns: { create } }),
      requireOperationsRole: vi.fn(() => 'platform_ops'),
      requestActor: vi.fn(() => 'operator-1'),
      recordOperationAudit: vi.fn(async () => undefined),
    } as unknown as McpCanonicalBackfillDependencies

    await expect(handleMcpCanonicalBackfill(
      'ops.canonical.backfill.create', { batch_limit, reason: 'test boundary' }, {} as IncomingMessage, 'workspace-a', deps,
    )).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST, status: 400 })

    expect(create).not.toHaveBeenCalled()
  })

  it.each([1, 5000])('accepts create batch_limit repository boundary %s', async batch_limit => {
    const create = vi.fn(async input => ({ id: 'run-1', ...input }))
    const deps = {
      persistenceReady: Promise.resolve(),
      getPersistence: () => ({ mode: 'postgres', canonicalBackfillRuns: { create } }),
      requireOperationsRole: vi.fn(() => 'platform_ops'),
      requestActor: vi.fn(() => 'operator-1'),
      recordOperationAudit: vi.fn(async () => undefined),
    } as unknown as McpCanonicalBackfillDependencies

    await expect(handleMcpCanonicalBackfill(
      'ops.canonical.backfill.create', { batch_limit, reason: 'test boundary' }, {} as IncomingMessage, 'workspace-a', deps,
    )).resolves.toMatchObject({ id: 'run-1', batchLimit: batch_limit })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-a', batchLimit: batch_limit }))
  })

  it('allows claiming a conflict without a resolution-only status field', async () => {
    const claim = vi.fn(async () => ({ id: 'conflict-1' }))
    const deps = depsWithConflicts({ claim })

    await expect(handleMcpCanonicalBackfill(
      'ops.canonical.backfill.conflict.claim', { conflict_id: 'conflict-1', expected_revision: 1, reason: 'reviewing ownership' }, {} as IncomingMessage, 'workspace-a', deps,
    )).resolves.toEqual({ id: 'conflict-1' })

    expect(claim).toHaveBeenCalledWith({ workspaceId: 'workspace-a', id: 'conflict-1', expectedRevision: 1, assigneeId: 'operator-1' })
  })

  it('rejects invalid resolution states before repository mutation', async () => {
    const resolve = vi.fn()
    const deps = depsWithConflicts({ resolve })

    await expect(handleMcpCanonicalBackfill(
      'ops.canonical.backfill.conflict.resolve', { conflict_id: 'conflict-1', expected_revision: 1, reason: 'review complete', status: 'open', resolution_note: 'done' }, {} as IncomingMessage, 'workspace-a', deps,
    )).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST, status: 400 })

    expect(resolve).not.toHaveBeenCalled()
  })
})
