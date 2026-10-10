import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { Task } from '../../../packages/application/src/service.js'
import { optionalMcpExpectedVersion } from './mcp-expected-version.js'
import { handleMcpTaskContinuation } from './mcp-task-continuation-handlers.js'
import type { McpTaskContinuationDependencies } from './mcp-task-continuation-handlers.js'
import { handleMcpTaskWrite } from './mcp-task-write-handlers.js'
import type { McpTaskWriteDependencies } from './mcp-task-write-handlers.js'

const request = {} as IncomingMessage
const task = { id: 'task_1', workspaceId: 'workspace_1', productId: 'product_1', version: 3 } as unknown as Task
const invalidVersions: unknown[] = ['', 'stale', '-1', '0', '9007199254740992', null, true, 1]

function continuationFixture() {
  const service = {
    selectDirection: vi.fn(),
    confirmProductionPlan: vi.fn(),
    products: new Map(),
  }
  const persistSnapshot = vi.fn(async () => undefined)
  const persistEvent = vi.fn(async () => undefined)
  const recordOperationAudit = vi.fn(async () => undefined)
  const hydrateDurableRuleSnapshot = vi.fn(async () => undefined)
  const deps = {
    service,
    required: (params: Record<string, unknown>, key: string) => String(params[key]),
    scopeTask: vi.fn(() => task),
    taskWriteBrandForProduct: vi.fn(async () => undefined),
    supportedPlatforms: ['taobao'],
    assertCanonicalTaskScopeForAction: vi.fn(async () => undefined),
    resolveCanonicalTaskScope: vi.fn(async () => undefined),
    persistSnapshot,
    persistEvent,
    requestActor: vi.fn(() => 'merchant'),
    hydrateDurableRuleSnapshot,
    recordOperationAudit,
  } as unknown as McpTaskContinuationDependencies
  return { deps, service, persistSnapshot, persistEvent, recordOperationAudit, hydrateDurableRuleSnapshot }
}

function writeFixture() {
  const service = { answerTask: vi.fn(), products: new Map() }
  const persistSnapshot = vi.fn(async () => undefined)
  const persistEvent = vi.fn(async () => undefined)
  const persistTaskAnswerFactConfirmation = vi.fn(async () => undefined)
  const deps = {
    service,
    required: (params: Record<string, unknown>, key: string) => {
      const value = params[key]
      if (typeof value !== 'string' || !value) throw new Error(`missing ${key}`)
      return value
    },
    scopeTask: vi.fn(() => task),
    persistSnapshot,
    persistEvent,
    persistTaskAnswerFactConfirmation,
  } as unknown as McpTaskWriteDependencies
  return { deps, service, persistSnapshot, persistEvent, persistTaskAnswerFactConfirmation }
}

describe('MCP optimistic task version inputs', () => {
  it('keeps an omitted value optional and parses the wire-level integer string', () => {
    expect(optionalMcpExpectedVersion({}, 'expected_version')).toBeUndefined()
    expect(optionalMcpExpectedVersion({ expected_version: '3' }, 'expected_version')).toBe(3)
  })

  it.each(invalidVersions)('rejects malformed task.select_direction expected_version %p before writes', async expectedVersion => {
    const f = continuationFixture()
    await expect(handleMcpTaskContinuation('task.select_direction', {
      task_id: task.id,
      direction_id: 'A',
      expected_version: expectedVersion,
    }, request, task.workspaceId, f.deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(f.deps.scopeTask).toHaveBeenCalledWith(request, task.id)
    expect(f.service.selectDirection).not.toHaveBeenCalled()
    expect(f.persistSnapshot).not.toHaveBeenCalled()
    expect(f.persistEvent).not.toHaveBeenCalled()
  })

  it.each(invalidVersions)('rejects malformed task.plan.confirm expected_version %p before workflow reads or writes', async expectedVersion => {
    const f = continuationFixture()
    await expect(handleMcpTaskContinuation('task.plan.confirm', {
      task_id: task.id,
      expected_version: expectedVersion,
    }, request, task.workspaceId, f.deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(f.deps.scopeTask).toHaveBeenCalledWith(request, task.id)
    expect(f.deps.assertCanonicalTaskScopeForAction).toHaveBeenCalledWith(task)
    expect(f.hydrateDurableRuleSnapshot).not.toHaveBeenCalled()
    expect(f.service.confirmProductionPlan).not.toHaveBeenCalled()
    expect(f.persistSnapshot).not.toHaveBeenCalled()
    expect(f.persistEvent).not.toHaveBeenCalled()
    expect(f.recordOperationAudit).not.toHaveBeenCalled()
  })

  it.each(invalidVersions)('rejects malformed task.answer expected_version %p before service or durable writes', async expectedVersion => {
    const f = writeFixture()
    await expect(handleMcpTaskWrite('task.answer', {
      task_id: task.id,
      answers_json: JSON.stringify({ audience: '通勤人群' }),
      expected_version: expectedVersion,
    }, request, task.workspaceId, f.deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(f.deps.scopeTask).toHaveBeenCalledWith(request, task.id)
    expect(f.service.answerTask).not.toHaveBeenCalled()
    expect(f.persistSnapshot).not.toHaveBeenCalled()
    expect(f.persistEvent).not.toHaveBeenCalled()
    expect(f.persistTaskAnswerFactConfirmation).not.toHaveBeenCalled()
  })
})
