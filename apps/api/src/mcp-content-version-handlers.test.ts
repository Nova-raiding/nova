import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleMcpContentVersion, type McpContentVersionDependencies } from './mcp-content-version-handlers.js'

const request = {} as IncomingMessage
const task = { id: 'task_1', workspaceId: 'workspace_1', version: 3 } as never
const version = { id: 'version_1', taskId: 'task_1' } as never

function fixture() {
  const modifyContentVersion = vi.fn()
  const approveContent = vi.fn()
  const restoreContentVersion = vi.fn()
  const rulesForTask = vi.fn(async () => ({}))
  const persistSnapshot = vi.fn(async () => undefined)
  const persistEvent = vi.fn(async () => undefined)
  const deps = {
    service: { modifyContentVersion, approveContent, restoreContentVersion },
    required: (params: Record<string, unknown>, name: string) => {
      const value = params[name]
      if (typeof value !== 'string' || !value) throw new Error(`missing ${name}`)
      return value
    },
    scopeTask: vi.fn(() => task),
    scopeContentVersion: vi.fn(() => ({ task, version })),
    assertCanonicalTaskScopeForAction: vi.fn(async () => undefined),
    mcpPagination: vi.fn(() => ({ limit: 20, offset: 0 })),
    persistExpiredDeliveryIfNeeded: vi.fn(async () => undefined),
    verifyExportedBundle: vi.fn(),
    maxMcpExportBytes: 25 * 1024 * 1024,
    rulesForTask,
    persistSnapshot,
    persistEvent,
  } as unknown as McpContentVersionDependencies
  return { deps, modifyContentVersion, approveContent, restoreContentVersion, rulesForTask, persistSnapshot, persistEvent }
}

describe('MCP content version optimistic concurrency inputs', () => {
  it.each([
    ['number instead of schema string', 1],
    ['empty string', ''],
    ['negative string', '-1'],
    ['nonnumeric string', 'stale'],
    ['zero string', '0'],
    ['unsafe integer string', String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)],
  ])('rejects invalid expected_revision (%s) before modifying', async (_label, expectedRevision) => {
    const f = fixture()

    await expect(handleMcpContentVersion('content.modify', {
      content_version_id: 'version_1',
      changes_json: JSON.stringify({ title: 'must not be saved' }),
      reason: 'test',
      expected_revision: expectedRevision,
    }, request, 'workspace_1', f.deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(f.modifyContentVersion).not.toHaveBeenCalled()
    expect(f.deps.scopeContentVersion).toHaveBeenCalledWith(request, 'version_1')
    expect(f.deps.assertCanonicalTaskScopeForAction).toHaveBeenCalledWith(task)
    expect(f.persistSnapshot).not.toHaveBeenCalled()
    expect(f.persistEvent).not.toHaveBeenCalled()
  })

  it.each(['stale', '', '-1', '9007199254740992', true, 1])('rejects malformed optional approval expected_version %p', async expectedVersion => {
    const f = fixture()

    await expect(handleMcpContentVersion('content.approve', {
      task_id: 'task_1',
      content_version_id: 'version_1',
      expected_version: expectedVersion,
    }, request, 'workspace_1', f.deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(f.deps.scopeTask).toHaveBeenCalledWith(request, 'task_1')
    expect(f.deps.assertCanonicalTaskScopeForAction).toHaveBeenCalledWith(task)
    expect(f.approveContent).not.toHaveBeenCalled()
    expect(f.rulesForTask).not.toHaveBeenCalled()
    expect(f.persistSnapshot).not.toHaveBeenCalled()
    expect(f.persistEvent).not.toHaveBeenCalled()
  })

  it.each(['stale', '', true, 1])('rejects malformed optional restore expected_version %p before restore', async expectedVersion => {
    const f = fixture()

    await expect(handleMcpContentVersion('content.restore', {
      content_version_id: 'version_1',
      expected_version: expectedVersion,
    }, request, 'workspace_1', f.deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(f.deps.scopeContentVersion).toHaveBeenCalledWith(request, 'version_1')
    expect(f.deps.assertCanonicalTaskScopeForAction).toHaveBeenCalledWith(task)
    expect(f.restoreContentVersion).not.toHaveBeenCalled()
    expect(f.persistSnapshot).not.toHaveBeenCalled()
    expect(f.persistEvent).not.toHaveBeenCalled()
  })
})
