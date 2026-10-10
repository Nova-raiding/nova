import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../../packages/application/src/service.js'
import { handleHttpContentVersionRoutes } from './http-content-version-routes.js'

const request = { method: 'POST' } as IncomingMessage
const response = {} as ServerResponse
const task = { id: 'task_1', workspaceId: 'workspace_1', version: 3 } as never
const sourceVersion = { id: 'version_1', taskId: 'task_1' } as never

function fixture(expectedVersion: unknown) {
  const restoreContentVersion = vi.fn()
  const persistSnapshot = vi.fn(async () => undefined)
  const persistEvent = vi.fn(async () => undefined)
  const send = vi.fn(() => true)
  const deps = {
    service: { restoreContentVersion },
    scopeTask: vi.fn(() => task),
    scopeContentVersion: vi.fn(() => ({ task, version: sourceVersion })),
    assertCanonicalTaskScopeForAction: vi.fn(async () => undefined),
    body: vi.fn(async () => ({ expected_version: expectedVersion })),
    required: vi.fn((_input: Record<string, unknown>, key: string) => String(_input[key])),
    rulesForTask: vi.fn(async () => ({})),
    assertReviewDecisionPreflight: vi.fn(),
    enforceHttpCommercialAccess: vi.fn(async () => undefined),
    requestActor: vi.fn(() => 'actor_1'),
    persistSnapshot,
    persistEvent,
    persistExpiredDeliveryIfNeeded: vi.fn(async () => undefined),
    verifyExportedBundle: vi.fn(() => ({ artifact_sha256: '', manifest_hash: '', valid: true, scope: 'test' })),
    send,
    sendDownload: vi.fn(() => true),
  }
  return { deps, restoreContentVersion, persistSnapshot, persistEvent, send }
}

async function restore(f: ReturnType<typeof fixture>) {
  return handleHttpContentVersionRoutes(request, response, '/v1/content-versions/version_1/restore', new URL('http://localhost/v1/content-versions/version_1/restore'), f.deps as never)
}

describe('HTTP content version restore expected_version validation', () => {
  it.each([
    ['zero number', 0],
    ['zero string', '0'],
    ['negative number', -1],
    ['negative string', '-1'],
    ['null', null],
    ['unsafe integer number', Number.MAX_SAFE_INTEGER + 1],
    ['unsafe integer string', String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)],
  ])('rejects %s before restore or durable writes', async (_label, expectedVersion) => {
    const f = fixture(expectedVersion)

    await expect(restore(f)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(f.restoreContentVersion).not.toHaveBeenCalled()
    expect(f.persistSnapshot).not.toHaveBeenCalled()
    expect(f.persistEvent).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('returns the stale-version 409 without snapshot or event writes', async () => {
    const f = fixture(2)
    f.restoreContentVersion.mockImplementation(() => {
      throw new DomainError('VERSION_CONFLICT', 'task version changed', 409)
    })

    await expect(restore(f)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 })
    expect(f.restoreContentVersion).toHaveBeenCalledWith('workspace_1', 'version_1', 2)
    expect(f.persistSnapshot).not.toHaveBeenCalled()
    expect(f.persistEvent).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })
})
