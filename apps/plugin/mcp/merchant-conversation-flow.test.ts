import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'

type Json = Record<string, unknown>

const json = (value: Json) => JSON.stringify(value)

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return address
}

async function close(server: ReturnType<typeof createServer>) {
  server.close()
  await once(server, 'close').catch(() => undefined)
}

function nextLine(stream: NodeJS.ReadableStream): Promise<Json> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onError = (error: Error) => {
      stream.off('data', onData)
      reject(error)
    }
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      stream.off('data', onData)
      stream.off('error', onError)
      resolve(JSON.parse(buffer.slice(0, newline)) as Json)
    }
    stream.on('data', onData)
    stream.once('error', onError)
  })
}

async function request(child: ChildProcessWithoutNullStreams, id: number, name: string, args: Json = {}) {
  child.stdin.write(`${json({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
  return nextLine(child.stdout)
}

async function withBridge(handler: (request: Json, res: ServerResponse<IncomingMessage>) => Promise<void> | void, test: (child: ChildProcessWithoutNullStreams, calls: Json[]) => Promise<void>) {
  const calls: Json[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    const parsed = JSON.parse(body) as Json
    calls.push(parsed)
    await handler(parsed, res)
  })
  const address = await listen(server)
  const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    await test(child, calls)
  } finally {
    child.kill()
    await close(server)
  }
}

function ok(request: Json, result: Json) {
  return { data: { jsonrpc: '2.0', id: request.id, result }, warnings: [], next_actions: [], error: null }
}

function failure(code: string, message: string, details?: Json) {
  return { error: { code, message, ...(details ? { details } : {}) } }
}

describe('Codex App merchant conversation flow', () => {
  it('starts onboarding with one conversational question and removes dashboard-shaped fields', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, {
        greeting: '欢迎使用大麦',
        onboarding: { currentStep: 'connect_store', steps: ['connect_store', 'choose_product', 'add_assets', 'start_task'] },
        next_actions: [{ label: '选择平台和店铺', tool: 'platform.connect', required_inputs: ['platform'] }],
        action_cards: [{ method: 'platform.connect', label: '连接淘宝', description: '先绑定一家店铺' }],
      })))
    }, async (child, calls) => {
      const response = await request(child, 1, 'merchant.start')
      const result = response.result as Json
      expect(result.isError).toBe(false)
      expect(result.structuredContent).toEqual({
        conversation_state: { stage: 'start', status: 'needs_input', primary_action: { method: 'platform.connect', label: '连接店铺' } },
        completed_summary: '欢迎使用大麦',
        question: '你想先连接哪个平台？',
        expected_input: { kind: 'platform_selection', accepts: ['natural_language'] },
      })
      expect(JSON.stringify(result.structuredContent)).not.toMatch(/dashboard|capabilityCards|context_bar|action_cards/u)
      expect(calls.map(call => call.method)).toEqual(['merchant.start'])
    })
  })

  it('uses the server onboarding projection as the primary action source', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, {
        currentStep: { id: 'choose-product', state: 'required' },
        onboarding_v2: { current_step: { id: 'connect_store', title: '连接店铺', state: 'required', primary_action: { method: 'platform.connect', label: '连接平台店铺', required_inputs: ['platform'] } } },
        action_cards: [{ method: 'catalog.search', label: '选择商品', enabled: true }],
      })))
    }, async (child) => {
      const response = await request(child, 1, 'merchant.start')
      expect(response.result).toMatchObject({ structuredContent: { conversation_state: { stage: 'connect_store' }, question: '你想先连接哪个平台？', expected_input: { kind: 'platform_selection' } } })
    })
  })

  it.each([
    ['缺少已确认商品事实', 'FACTS_CONFIRMATION_REQUIRED', '请先确认商品事实'],
    ['缺少服务端权限', 'PERMISSION_DENIED', '当前账号没有执行这一步的权限。任务和已有内容已保留。'],
    ['余额不足', 'RECHARGE_REQUIRED', '余额不足，请先充值'],
  ])('surfaces the %s blocker without claiming task success', async (_label, code, message) => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      if (request.method === 'content.generate') {
        res.end(json(failure(code, message)))
      } else {
        res.end(json(ok(request, { enabled: true })))
      }
    }, async (child, calls) => {
      expect((await request(child, 1, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })).result).toMatchObject({ isError: false })
      const response = await request(child, 2, 'content.generate', { task_id: 'task_1' })
      expect(response.result).toMatchObject({ isError: true, structuredContent: { code, message } })
      expect(JSON.stringify(response.result)).not.toContain('success')
      expect(calls.map(call => call.method)).toEqual(['content.generate'])
    })
  })

  it('recovers an existing task in history order instead of creating a duplicate task', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      const result = request.method === 'task.history'
        ? { tasks: [{ id: 'task_1', state: 'waiting_for_answer', title: '淘宝详情页' }] }
        : request.method === 'task.resume'
          ? { taskId: 'task_1', state: 'waiting_for_answer', question: '请确认促销价格' }
          : { taskId: 'task_1', events: [{ type: 'resumed' }], next_actions: ['回答促销价格'] }
      res.end(json(ok(request, result)))
    }, async (child, calls) => {
      await request(child, 1, 'task.history')
      const resumed = await request(child, 2, 'task.resume', { task_id: 'task_1' })
      expect((resumed.result as Json).structuredContent).toMatchObject({ taskId: 'task_1', state: 'waiting_for_answer', question: '请确认促销价格' })
      await request(child, 3, 'task.timeline', { task_id: 'task_1' })
      expect(calls.map(call => call.method)).toEqual(['task.history', 'task.resume', 'task.timeline'])
      expect(calls.some(call => call.method === 'task.create' || call.method === 'task.clone')).toBe(false)
    })
  })

  it('preserves a new conversation goal and completes automatic scanning in the same turn', async () => {
    await withBridge((request, res) => {
      const method = request.method
      const result = method === 'merchant.start'
        ? { currentStep: { id: 'add-assets' }, action_cards: [{ method: 'asset.upload', label: '上传商品图片' }] }
        : method === 'asset.upload'
          ? { id: 'asset_new_session', scanStatus: 'quarantined' }
          : { assets: [{ id: 'asset_new_session', scanStatus: 'clean' }], asset_actions: [{ asset_id: 'asset_new_session', next_step: '确认素材商用权益' }] }
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, result)))
    }, async (child, calls) => {
      const started = await request(child, 1, 'merchant.start', { requested_platform: 'jd', requested_goal: 'generate_white_background_image', attachment_count: 1 })
      expect(started.result).toMatchObject({
        isError: false,
        structuredContent: {
          conversation_state: { stage: 'add_assets', status: 'needs_input', selected_platform: 'jd' },
          completed_summary: '已锁定京东。',
          question: '请上传商品图片或资料。',
          expected_input: { kind: 'attachment', accepts: ['attachment'] },
        },
      })
      expect(JSON.stringify((started.result as Json).structuredContent)).not.toMatch(/dashboard|capabilityCards|context_bar|action_cards|管理员|运营后台/u)
      expect(calls[0]).toMatchObject({ method: 'merchant.start', params: { requested_platform: 'jd', requested_goal: 'generate_white_background_image', attachment_count: '1', workspace_id: 'ws_test' } })

      await request(child, 2, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })
      const uploaded = await request(child, 3, 'asset.upload', { name: 'product.png', mime_type: 'image/png', content_base64: Buffer.from('image').toString('base64') })
      expect(uploaded.result).toMatchObject({
        isError: false,
        structuredContent: { scanStatus: 'clean', scan_wait: { state: 'completed', user_action_required: false }, next_step: '确认素材商用权益' },
      })
      expect((uploaded.result as Json)._meta).toBeUndefined()
      expect(JSON.stringify(uploaded.result)).not.toMatch(/管理员|运营后台|扫描证据|automation\.scan/u)
      expect(calls.map(call => call.method)).toEqual(['merchant.start', 'asset.upload', 'asset.list'])
    })
  })

  it('returns a successful deliverable as an actionable artifact card', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, request.method === 'content.generate'
        ? { status: 'completed', deliverable: { title: '轻云防晒外套详情页', version: 'v3' }, action_cards: [{ method: 'content.export', label: '导出交付包', description: '可下载的内容交付物' }] }
        : { enabled: true })))
    }, async (child) => {
      await request(child, 1, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })
      const response = await request(child, 2, 'content.generate', { task_id: 'task_1' })
      const result = response.result as Json
      expect(result).toMatchObject({ isError: false, structuredContent: { status: 'completed', deliverable: { version: 'v3' } } })
      expect((result.structuredContent as Json).action_cards).toEqual([expect.objectContaining({ tool: 'content.export', label: '导出交付包', requires_confirmation: false })])
    })
  })

  it('keeps publish writes closed until the current conversation confirms them', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, { accepted: true })))
    }, async (child, calls) => {
      const blocked = await request(child, 1, 'publish.confirm', { confirmation_hash: 'hash_1', remote_snapshot_hash: 'snapshot_1' })
      expect(blocked.result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' } })
      expect(calls).toHaveLength(0)

      await request(child, 2, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })
      const published = await request(child, 3, 'publish.confirm', { idempotency_key: 'publish:task_1:v3', confirmation_hash: 'hash_1', remote_snapshot_hash: 'snapshot_1' })
      expect(published.result).toMatchObject({ isError: false, structuredContent: { accepted: true } })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ method: 'publish.confirm', params: { workspace_id: 'ws_test', idempotency_key: 'publish:task_1:v3', confirmation_hash: 'hash_1', remote_snapshot_hash: 'snapshot_1' } })
    })
  })
})
