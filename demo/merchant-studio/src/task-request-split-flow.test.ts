import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTaskRequest } from './api.js'

const response = (data: unknown) => new Response(JSON.stringify({
  request_id: 'task-request-test',
  trace_id: 'task-request-test',
  workspace_id: 'ws_demo',
  data,
  warnings: [],
  next_actions: [],
  error: null,
}), { status: 201, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.stubEnv('VITE_API_TOKEN', 'merchant-api-test-token')
  vi.stubGlobal('window', globalThis)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('natural-language split task creation contract', () => {
  it('posts the confirmed intent with a stable idempotency key and returns every child task', async () => {
    const tasks = [
      { id: 'task-jd', platform: 'jd', productId: 'product-jd' },
      { id: 'task-pdd', platform: 'pinduoduo', productId: 'product-pdd' },
    ]
    const fetch = vi.fn(async () => response({ mode: 'split_by_platform', taskGroupId: 'group-1', taskIds: tasks.map(task => task.id), tasks, replayed: false }))
    vi.stubGlobal('fetch', fetch)
    try {
      const result = await createTaskRequest('https://api.example.test', '分别为京东和拼多多准备营销内容', 'intent-1', [
        { platform: 'jd', productId: 'product-jd' },
        { platform: 'pinduoduo', productId: 'product-pdd' },
      ])
      expect(fetch).toHaveBeenCalledOnce()
      const [url, init] = fetch.mock.calls[0]!
      expect(url).toBe('https://api.example.test/v1/task-requests')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('intent-1')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer merchant-api-test-token')
      expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_demo')
      expect(JSON.parse(String(init?.body))).toEqual({ request_text: '分别为京东和拼多多准备营销内容', expected_scopes: [
        { platform: 'jd', product_id: 'product-jd' },
        { platform: 'pinduoduo', product_id: 'product-pdd' },
      ] })
      expect(result.taskIds).toEqual(['task-jd', 'task-pdd'])
      expect(result.tasks).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('serializes the confirmed SKU split scope for the server pre-write guard', async () => {
    const fetch = vi.fn(async () => response({ mode: 'split_by_sku', taskGroupId: 'group-sku', taskIds: [], tasks: [], replayed: false }))
    vi.stubGlobal('fetch', fetch)
    try {
      await createTaskRequest('https://api.example.test', '逐 SKU 生成', 'intent-sku', [
        { platform: 'taobao', productId: 'product-1', skuIds: ['sku-a', 'sku-b'] },
      ])
      const [, init] = fetch.mock.calls[0]!
      expect(JSON.parse(String(init?.body))).toEqual({ request_text: '逐 SKU 生成', expected_scopes: [
        { platform: 'taobao', product_id: 'product-1', sku_ids: ['sku-a', 'sku-b'] },
      ] })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('routes the split confirmation through the group endpoint and exposes navigation for actual returned children', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(app).toContain("['split_by_platform', 'split_by_sku'].includes(understanding.executionPlan.mode)")
    expect(app).toContain("understanding.executionPlan.mode === 'split_by_sku'")
    expect(app).toContain('createTaskRequest(baseUrl, requestText.trim(), intentKey, taskRequestScopesForPlan(understanding.executionPlan))')
    expect(app).toContain('taskCreationIntentKey.current?.scope === scope')
    expect(app).toContain('taskRequestResultMatchesPlan(understanding.executionPlan, result.tasks)')
    expect(app).toContain("const isTaskRequestScopeChanged = (cause: unknown) => (cause as { code?: unknown } | null)?.code === 'TASK_REQUEST_SCOPE_CHANGED'")
    expect(app).toContain('data-testid="task-scope-changed-recovery"')
    expect(app).toContain('taskCreationScopeChanged && !task ? (')
    expect(app).toContain('taskCreationUnconfirmed = Boolean(')
    expect(app).toContain('taskCreationAttempted && error && !taskCreationScopeChanged')
    expect(app).toContain('重新分析当前需求')
    expect(app).toContain('taskIntentOverride.current = { targetScope: taskIntentTargetScope(target), key: newIntentKey }')
    expect(app).toContain('intentKey: newIntentKey')
    expect(app).toContain('data-testid="task-group-created"')
    expect(app).toContain('if (createdTaskGroup) return (')
    expect(app).toContain('createdTaskGroup.tasks.map((groupTask)')
    expect(app).toContain("target: { kind: 'task', taskId: groupTask.id }")
    expect(app).toContain("createdTaskGroup.mode === 'split_by_platform' ? '独立平台' : '独立 SKU'")
  })
})
