import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { MCP_METHODS, validateMcpRequest } from '@merchant-marketing/contracts'

const BRIDGE_PATH = fileURLToPath(new URL('./bridge.mjs', import.meta.url))

const MERCHANT_HIDDEN_METHODS = new Set([
  'billing.model-usage.reconciliation.run',
  'billing.model-usage.resolve',
  'billing.usage.consume',
  'billing.usage.refund',
  'billing.refund',
  'billing.reconciliation.run',
  'platform.settings.update',
  'platform.revoke',
  'platform.model.status',
  'asset.scan',
  'content.codex.prepare',
  'content.codex.commit',
])

function nextLine(stream: NodeJS.ReadableStream): Promise<any> {
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
      resolve(JSON.parse(buffer.slice(0, newline)))
    }
    stream.on('data', onData)
    stream.once('error', onError)
  })
}

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

describe('Codex stdio MCP bridge', () => {
  it('blocks non-read-only tools before API forwarding unless interactive writes are explicitly enabled', async () => {
    let requests = 0
    const server = createServer((_req, res) => {
      requests += 1
      res.writeHead(500).end()
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'asset.facts.confirm', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'multimodal.image.edit', arguments: { request_json: '{}' } } })}\n`)
      const imageEditResponse = await nextLine(child.stdout)
      expect(imageEditResponse.result).toMatchObject({
        isError: true,
        structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' },
      })
      expect(imageEditResponse.result._meta).toBeUndefined()
      for (const [index, name] of ['platform.media.spec.create', 'platform.media.spec.update', 'platform.media.spec.approve', 'platform.media.spec.expire'].entries()) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 3, method: 'tools/call', params: { name, arguments: { id: 'spec_1', expected_revision: '1', idempotency_key: `media:${index}:write`, reason: 'verified production evidence' } } })}\n`)
        expect((await nextLine(child.stdout)).result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' } })
      }
      expect(requests).toBe(0)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('requires current-session confirmation for protected writes even when the legacy write env is enabled', async () => {
    let requests = 0
    let idempotencyHeader: string | string[] | undefined
    const server = createServer(async (req, res) => {
      requests += 1
      idempotencyHeader = req.headers['idempotency-key']
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { accepted: true } }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const writes = ['platform.media.spec.create', 'platform.media.spec.update', 'platform.media.spec.approve', 'platform.media.spec.expire', 'campaign.batch.pause', 'campaign.batch.resume', 'campaign.batch.retry_failed']
      for (const [index, name] of writes.entries()) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: {} } })}\n`)
        expect((await nextLine(child.stdout)).result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' } })
      }
      expect(requests).toBe(0)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' } } })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { enabled: true } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'campaign.batch.pause', arguments: { campaign_id: 'campaign_1', expected_revision: '1', idempotency_key: 'campaign:pause:1', reason: 'operator requested pause' } } })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { accepted: true } })
      expect(requests).toBe(1)
      expect(idempotencyHeader).toBe('campaign:pause:1')
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('forwards catalog.image.select with the candidate-bound confirmation ticket and no session confirmation', async () => {
    const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: any }> = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { preferred: true, review_status: 'pending', published: false } }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const baseArguments = { job_id: 'job_1', visual_ref: 'visual_2', expected_revision: '7', idempotency_key: 'image-select-visual-2', reason: '用户选择首选主图' }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'catalog.image.select', arguments: baseArguments } })}\n`)
      expect((await nextLine(child.stdout)).error).toMatchObject({ code: -32602 })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'catalog.image.select', arguments: { ...baseArguments, confirmation_ticket_nonce_hash: 'A'.repeat(64), confirmation_ticket_intent_hash: 'b'.repeat(64) } } })}\n`)
      expect((await nextLine(child.stdout)).error).toMatchObject({ code: -32602 })
      expect(requests).toHaveLength(0)
      const arguments_ = { ...baseArguments, confirmation_ticket_nonce_hash: 'a'.repeat(64), confirmation_ticket_intent_hash: 'b'.repeat(64) }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'catalog.image.select', arguments: arguments_ } })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { preferred: true, review_status: 'pending', published: false } })
      expect(requests).toHaveLength(1)
      expect(requests[0]!.headers['idempotency-key']).toBe('image-select-visual-2')
      expect(requests[0]!.body).toMatchObject({ method: 'catalog.image.select', params: { ...arguments_, workspace_id: 'ws_test' } })
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('does not let DEPLOY_ENV production bypass the interactive write gate', async () => {
    let requests = 0
    const server = createServer((_req, res) => { requests += 1; res.writeHead(200).end('{}') })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'development', DEPLOY_ENV: 'production', MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content.approve', arguments: { content_version_id: 'version_1', expected_version: '1' } } })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' } })
      expect(requests).toBe(0)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('opens a short-lived interactive write session without requiring a manual env toggle', async () => {
    let requests = 0
    const server = createServer(async (_req, res) => {
      requests += 1
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ request_id: `req_${requests}`, trace_id: `trace_${requests}`, data: { jsonrpc: '2.0', id: requests, result: { accepted: true } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' } } })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { enabled: true, automation: 'read_only' } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'catalog.facts.confirm', arguments: { product_id: 'product_1', confirmation_json: '{}' } } })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { accepted: true } })
      expect(requests).toBe(1)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('allows onboarding, recharge-order, and read-only sync tools without interactive-write mode', async () => {
    let requests = 0
    const server = createServer(async (_req, res) => {
      requests += 1
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ request_id: `req_${requests}`, trace_id: `trace_${requests}`, workspace_id: 'ws_test', data: { jsonrpc: '2.0', id: requests, result: { accepted: true } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      for (const [index, name] of ['platform.connect', 'billing.recharge.create', 'catalog.sync', 'catalog.sync.start', 'platform.media.spec.list', 'platform.media.spec.get', 'platform.mapping.preflight', 'delivery.bundle.verify', 'task.understand'].entries()) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: {} } })}\n`)
        expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { accepted: true } })
      }
      expect(requests).toBe(9)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('renders safe clickable authorization and recharge links for Codex App users', async () => {
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      const method = JSON.parse(body).method
      const result = method === 'platform.connect'
        ? { authorizationUrl: 'https://seller.example.com/oauth/authorize?state=opaque' }
        : { paymentUrl: 'https://pay.example.com/checkout?order_id=order_1', state: 'pending' }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      for (const [id, name] of [[1, 'platform.connect'], [2, 'billing.recharge.create']] as const) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })}\n`)
        const response = await nextLine(child.stdout)
        expect(response.result.content).toContainEqual(expect.objectContaining({ type: 'resource_link', uri: expect.stringMatching(/^https:\/\//u), annotations: { audience: ['user'] } }))
      }
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('renders trusted payment deep links without turning arbitrary schemes into links', async () => {
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      const method = JSON.parse(body).method
      const result = method === 'billing.recharge.create'
        ? { paymentUrl: 'weixin://wxpay/bizpayurl?pr=opaque' }
        : { authorizationUrl: 'javascript:alert(1)' }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'billing.recharge.create', arguments: {} } })}\n`)
      expect((await nextLine(child.stdout)).result.content).toContainEqual(expect.objectContaining({ type: 'resource_link', uri: 'weixin://wxpay/bizpayurl?pr=opaque' }))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'platform.connect', arguments: {} } })}\n`)
      expect((await nextLine(child.stdout)).result.content).not.toContainEqual(expect.objectContaining({ type: 'resource_link' }))
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('returns standardized action cards in structuredContent with a concise user-facing next step', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        data: { jsonrpc: '2.0', id: 1, result: {
          status: 'needs_input',
          next_actions: ['请使用 catalog.search 读取 product_id=prod_123456'],
          action_cards: [{
            method: 'subscription.change',
            label: '调用 subscription.change 处理 task_id=task_123456',
            description: '当前店铺额度不足；详情见 https://internal.example/tasks/task_123456',
            confirmation: 'interactive_confirmation',
          }],
        } },
        warnings: [],
        next_actions: ['请使用 catalog.search 读取 product_id=prod_123456'],
        error: null,
      }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'billing.status', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      const card = response.result.structuredContent.action_cards[0]
      expect(response.result.structuredContent).toMatchObject({ status: 'needs_input', next_actions: ['请使用 catalog.search 读取 product_id=prod_123456'] })
      expect(card).toMatchObject({
        id: 'billing-status-1',
        type: 'upgrade',
        tool: 'subscription.change',
        arguments: {},
        required_inputs: [],
        enabled: true,
        reason: '当前店铺额度不足；详情见 相关链接',
        requires_confirmation: true,
      })
      expect(card.label).toBe('调整店铺额度')
      expect(card.reason).toBe('当前店铺额度不足；详情见 相关链接')
      expect(response.result.content[0].text).toBe('还需要补充信息。\n下一步：调整店铺额度')
      expect(response.result.content[0].text).not.toContain('subscription.change')
      expect(response.result.content[0].text).not.toContain('catalog.search')
      expect(response.result.content[0].text).not.toContain('product_id')
      expect(response.result.content[0].text).not.toContain('prod_123456')
      expect(response.result.content[0].text).not.toContain('billing-status-1')
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('keeps internal identifiers and URLs out of merchant-facing summaries', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: {
        summary: '任务 task_1234567890 已完成，详情见 https://internal.example/tasks/task_1234567890，下一步调用 content.generate',
      } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merchant.start', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      const text = response.result.content[0].text as string
      expect(text).toContain('相关记录')
      expect(text).toContain('相关链接')
      expect(text).not.toContain('task_1234567890')
      expect(text).not.toContain('content.generate')
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('projects merchant.start to one minimal conversational question without exposing dashboard fields', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: {
        workspace_id: 'ws_test',
        action_cards: [{ method: 'catalog.search', label: '调用 catalog.search 选择商品', enabled: true }],
      } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merchant.start', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result._meta).toBeUndefined()
      expect(response.result.structuredContent).toEqual({
        conversation_state: { stage: 'start', status: 'needs_input', primary_action: { method: 'catalog.search', label: '选择平台、店铺和商品' } },
        completed_summary: '可以开始了。',
        question: '你要处理哪个平台、店铺或商品？',
        expected_input: { kind: 'platform_store_or_product_selection', accepts: ['natural_language'] },
      })
      expect(response.result.content[0].text).toBe('可以开始了。\n你要处理哪个平台、店铺或商品？')
      expect(response.result.content[0].text).not.toContain('catalog.search')
      expect(JSON.stringify(response.result.structuredContent)).not.toMatch(/dashboard|capabilityCards|context_bar|action_cards/u)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('exposes exactly one structured merchant action', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: {
        onboarding_v2: { current_step: { id: 'connect_store', primary_action: { method: 'platform.connect', label: '连接平台店铺', required_inputs: ['platform'] } } },
        action_cards: [
          { method: 'catalog.search', label: '选择平台、店铺和商品' },
          { method: 'asset.upload', label: '上传资料' },
          { method: 'merchant.first_value', label: '查看示例' },
          { method: 'content.generate', label: '生成内容' },
        ],
      } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], { cwd: process.cwd(), env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' }, stdio: ['pipe', 'pipe', 'ignore'] })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merchant.start', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.structuredContent.conversation_state).toMatchObject({
        primary_action: { method: 'platform.connect', label: '连接平台店铺', required_inputs: ['platform'] },
      })
      expect(response.result.structuredContent.conversation_state).not.toHaveProperty('secondary_actions')
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('reads object next actions as one merchant-facing step', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { next_actions: [{ tool: 'platform.connect', label: '连接一家店铺' }, { tool: 'catalog.search', label: '选择商品' }] } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], { cwd: process.cwd(), env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' }, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merchant.start', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.structuredContent).toMatchObject({
        conversation_state: { stage: 'start', status: 'needs_input' },
        question: '你想先连接哪个平台？',
        expected_input: { kind: 'platform_selection' },
      })
      expect(response.result.content[0].text).toContain('你想先连接哪个平台？')
      expect(response.result.content[0].text).not.toContain('[object Object]')
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('projects platform, store, source and write status as one explicit selection unit', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: {
        status: 'ok',
        workspace: { status: 'ready' },
        storeDirectory: [
          { platform: 'jd', accountId: 'jd-demo', label: '京东示例店', state: 'fixture', dataMode: 'fixture', readable: true, writeEnabled: true },
          { platform: 'jd', accountId: 'jd-real', label: '京东旗舰店', state: 'connected', dataMode: 'official_api', readable: true, writeEnabled: false },
        ],
        action_cards: [{ method: 'catalog.search', label: '选择店铺商品' }],
      } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], { cwd: process.cwd(), env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' }, stdio: ['pipe', 'pipe', 'ignore'] })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.structuredContent.conversation_state.store_options).toEqual([
        expect.objectContaining({ platform: 'jd', store_name: '京东示例店', status: '演示店铺', data_source: '演示数据', selectable: false }),
        expect.objectContaining({ platform: 'jd', store_name: '京东旗舰店', status: '可读取', data_source: '官方 API', selectable: true, action: { method: 'catalog.search', arguments: { scope: 'store', platform: 'jd', account_id: 'jd-real' } } }),
      ])
      expect(response.result.content[0].text).toContain('已更新 2 家店铺的连接状态。')
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('uses an explicitly requested JD platform without asking for the platform again', async () => {
    const forwarded: Array<Record<string, unknown>> = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      forwarded.push(JSON.parse(body).params)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: {
        workspace_id: 'ws_test',
        action_cards: [{ method: 'catalog.search', label: '选择平台、店铺和商品', enabled: true }],
      } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], { cwd: process.cwd(), env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' }, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merchant.start', arguments: { requested_platform: 'jd', requested_goal: 'generate_white_background_image', attachment_count: 1 } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.structuredContent).toEqual({
        conversation_state: { stage: 'start', status: 'needs_input', selected_platform: 'jd', primary_action: { method: 'catalog.search', label: '选择平台、店铺和商品' } },
        completed_summary: '已锁定京东。',
        question: '你要使用哪个京东店铺或商品？',
        expected_input: { kind: 'store_or_product_selection', accepts: ['natural_language'] },
      })
      expect(response.result.content[0].text).toBe('已锁定京东。\n你要使用哪个京东店铺或商品？')
      expect(response.result.content[0].text).not.toContain('generate_white_background_image')
      expect(response.result.content[0].text).not.toContain('附件：1 个')
      expect(response.result.content[0].text).not.toContain('选择平台')
      expect(response.result.content[0].text).not.toContain('你准备在哪个平台经营')
      expect(forwarded).toEqual([expect.objectContaining({
        requested_platform: 'jd',
        requested_goal: 'generate_white_background_image',
        attachment_count: '1',
        idempotency_key: expect.stringMatching(/^merchant-start-[a-f0-9]{32}$/u),
        workspace_id: 'ws_test',
      })])
    } finally {
      child.kill()
      await close(server)
    }
  })

  it.each([
    ['merchant.start', { currentStep: { id: 'automatic-scan', state: 'in_progress' }, capabilityCards: { title: '大麦工作台' }, context_bar: { labels: {} }, action_cards: [{ method: 'asset.scan', label: '请管理员在运营后台提交扫描证据' }], automation: { asset_scan: 'automatic' } }, { requested_platform: 'jd', requested_goal: 'generate_white_background_image', attachment_count: 1 }, '图片已收到，正在自动检查。通过后会等待你的确认再继续生成。'],
    ['workspace.health', { status: 'ok', workspace: { status: 'ready' }, storeDirectory: [{ platform: 'jd', label: '京东旗舰店' }], capabilityCards: { title: '大麦工作台' }, context_bar: { labels: {} }, action_cards: [{ method: 'asset.scan', label: '请管理员扫描' }] }, {}, '已更新 1 家店铺的连接状态。'],
  ])('removes dashboard and administrator-scan guidance from %s', async (method, upstreamResult, args, expectedSummary) => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: upstreamResult }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], { cwd: process.cwd(), env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' }, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: method, arguments: args } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result._meta).toBeUndefined()
      expect(response.result.structuredContent.completed_summary).toBe(expectedSummary)
      expect(Object.keys(response.result.structuredContent).sort()).toEqual(expect.arrayContaining(['completed_summary', 'conversation_state', 'expected_input']))
      expect(Object.keys(response.result.structuredContent).filter(key => key === 'question')).toHaveLength(response.result.structuredContent.question ? 1 : 0)
      expect(JSON.stringify(response.result)).not.toMatch(/dashboard|capabilityCards|context_bar|action_cards|管理员|运营后台|扫描证据/u)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('redacts bare UUIDs and SHA-256 values from merchant-facing summaries', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: {
        summary: '任务已完成：550e8400-e29b-41d4-a716-446655440000，证据 sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merchant.start', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      const text = response.result.content[0].text as string
      expect(text).toContain('相关记录')
      expect(text).not.toContain('550e8400-e29b-41d4-a716-446655440000')
      expect(text).not.toContain('sha256:0123456789abcdef')
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('never emits an ops-only tool as a merchant store-capacity action', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { jsonrpc: '2.0', id: 1, result: { store_capacity: { upgrade_actions: ['升级套餐增加店铺数', '购买店铺加购包'] } } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], { cwd: process.cwd(), env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' }, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'billing.status', arguments: {} } })}\n`)
      const cards = (await nextLine(child.stdout)).result.structuredContent.action_cards
      expect(cards).toHaveLength(2)
      expect(cards.every((card: { tool: string }) => !card.tool.startsWith('ops.'))).toBe(true)
      expect(cards.every((card: { tool: string }) => card.tool === 'subscription.change')).toBe(true)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('sanitizes nested store-capacity action cards from the server response', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { jsonrpc: '2.0', id: 1, result: { store_capacity: { action_cards: [{ tool: 'ops.commercial.addons.list', label: '购买加购包' }] } } }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], { cwd: process.cwd(), env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' }, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'billing.status', arguments: {} } })}\n`)
      const nested = (await nextLine(child.stdout)).result.structuredContent.store_capacity.action_cards[0]
      expect(nested).toMatchObject({ tool: 'subscription.change', type: 'upgrade', requires_confirmation: true })
      expect(nested.tool).not.toMatch(/^ops\./u)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('does not expose or invoke operator-sensitive methods from the merchant bridge', async () => {
    let requests = 0
    const server = createServer((_req, res) => {
      requests += 1
      res.writeHead(500).end()
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
      const listedNames = (await nextLine(child.stdout)).result.tools.map((tool: { name: string }) => tool.name)
      for (const name of MERCHANT_HIDDEN_METHODS) expect(listedNames).not.toContain(name)
      for (const [index, name] of [...MERCHANT_HIDDEN_METHODS].entries()) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name, arguments: {} } })}\n`)
        expect((await nextLine(child.stdout)).error).toMatchObject({ code: -32602, message: `Unknown tool: ${name}` })
      }
      expect(requests).toBe(0)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('exposes standard discovery and forwards the scoped API envelope', async () => {
    const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: any }> = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ request_id: 'req_1', trace_id: 'trace_1', workspace_id: 'ws_test', data: { jsonrpc: '2.0', id: 1, result: { items: [] } }, warnings: [], next_actions: [], error: null }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_ASSET_RESOURCE_DOMAINS: 'https://assets.example.test', MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({ capabilities: { tools: {} }, serverInfo: { name: 'merchant-marketing', version: '0.1.0+codex.20260831225927' } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1.5, method: 'initialize', params: { protocolVersion: 'unsupported' } })}\n`)
      expect((await nextLine(child.stdout)).error).toMatchObject({ code: -32602, data: { supportedProtocolVersion: '2025-06-18' } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'resources/list' })}\n`)
      const resources = await nextLine(child.stdout)
      expect(resources.result.resources).toContainEqual(expect.objectContaining({ uri: 'ui://merchant-marketing/recharge-v1.html', mimeType: 'text/html;profile=mcp-app' }))
      expect(resources.result.resources).toContainEqual(expect.objectContaining({ uri: 'ui://merchant-marketing/image-local-edit-v1.html', mimeType: 'text/html;profile=mcp-app' }))
      expect(resources.result.resources).toContainEqual(expect.objectContaining({ uri: 'ui://merchant-marketing/image-candidate-choice-v15.html', mimeType: 'text/html;profile=mcp-app' }))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'ui://merchant-marketing/recharge-v1.html' } })}\n`)
      const rechargeUi = await nextLine(child.stdout)
      expect(rechargeUi.result.contents[0]).toMatchObject({ uri: 'ui://merchant-marketing/recharge-v1.html', mimeType: 'text/html;profile=mcp-app' })
      expect(rechargeUi.result.contents[0].text).toContain('订单与账单')
      expect(rechargeUi.result.contents[0].text).toContain('充值订单已创建')
      expect(rechargeUi.result.contents[0].text).toContain('立即充值')
      expect(rechargeUi.result.contents[0].text).toContain('call("billing.status")')
      expect(rechargeUi.result.contents[0].text).toContain('call("billing.export"')
      expect(rechargeUi.result.contents[0].text).not.toMatch(/mock/iu)
      expect(rechargeUi.result.contents[0].text).not.toMatch(/Codex/iu)
      expect(rechargeUi.result.contents[0].text).toContain('role="radiogroup"')
      expect(rechargeUi.result.contents[0].text).toContain('aria-labelledby="checkoutTitle"')
      expect(rechargeUi.result.contents[0].text).toContain('aria-busy="false"')
      expect(rechargeUi.result.contents[0].text).toMatch(/failed:\s*["']未成功["']/u)
      expect(rechargeUi.result.contents[0].text).toContain('已退款')
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'resources/read', params: { uri: 'ui://merchant-marketing/image-local-edit-v1.html' } })}\n`)
      const imageEditUi = await nextLine(child.stdout)
      expect(imageEditUi.result.contents[0]).toMatchObject({ uri: 'ui://merchant-marketing/image-local-edit-v1.html', mimeType: 'text/html;profile=mcp-app' })
      expect(imageEditUi.result.contents[0].text).toContain('拖拽框选要修改的区域')
      expect(imageEditUi.result.contents[0].text).toContain('Shift 加方向键缩放')
      expect(imageEditUi.result.contents[0].text).toContain("callTool('multimodal.image.edit',args)")
      expect(imageEditUi.result.contents[0].text).toContain("window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*')")
      expect(imageEditUi.result.contents[0].text).toContain("modelVersion:fieldValue('modelVersion')")
      expect(imageEditUi.result.contents[0].text).toContain("nonModifiableRegions:protectedRegions")
      expect(imageEditUi.result.contents[0].text).toContain("x:round(clamp(rect.x,0,1-MIN_SIZE))")
      expect(imageEditUi.result.contents[0].text).not.toMatch(/<script[^>]+src=/iu)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'resources/read', params: { uri: 'ui://merchant-marketing/image-candidate-choice-v15.html' } })}\n`)
      const imageCandidateUi = await nextLine(child.stdout)
      expect(imageCandidateUi.result.contents[0]).toMatchObject({ uri: 'ui://merchant-marketing/image-candidate-choice-v15.html', mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: { resourceDomains: [`http://127.0.0.1:${address.port}`, 'https://assets.example.test'] } } } })
      expect(imageCandidateUi.result.contents[0].text).toContain('选择一张作为主图')
      expect(imageCandidateUi.result.contents[0].text).toContain("input.type='radio'")
      expect(imageCandidateUi.result.contents[0].text).toContain("callTool('catalog.image.select'")
      expect(imageCandidateUi.result.contents[0].text).not.toContain("callTool('workspace.interactive.confirm'")
      expect(imageCandidateUi.result.contents[0].text).toContain("meta['merchant/candidateSelectionTickets']")
      expect(imageCandidateUi.result.contents[0].text).toContain('confirmation_ticket_nonce_hash:ticket.nonce_hash')
      expect(imageCandidateUi.result.contents[0].text).toContain('confirmation_ticket_intent_hash:ticket.intent_hash')
      expect(imageCandidateUi.result.contents[0].text).toContain("currentState==='failed'?'regenerate':'query'")
      expect(imageCandidateUi.result.contents[0].text).toContain('sendFollowUpMessage')
      expect(imageCandidateUi.result.contents[0].text).toContain('请直接说“重新生成主图”')
      expect(imageCandidateUi.result.contents[0].text).toContain('已保存为首选主图，尚未审核或发布')
      expect(imageCandidateUi.result.contents[0].text).toContain("button.textContent='已保存';button.disabled=true")
      expect(imageCandidateUi.result.contents[0].text).toContain("button.textContent='重新读取图片'")
      expect(imageCandidateUi.result.contents[0].text).toContain("input.disabled=true")
      expect(imageCandidateUi.result.contents[0].text).toContain('if(!fallbackTried&&fallback')
      expect(imageCandidateUi.result.contents[0].text).toContain('disableCandidate(input,label,title,image,ordinal,subject)')
      expect(imageCandidateUi.result.contents[0].text).toContain("callTool('catalog.image.get',{job_id:")
      expect(imageCandidateUi.result.contents[0].text).toContain('ui/notifications/tool-result')
      expect(imageCandidateUi.result.contents[0].text).toContain('排队中')
      expect(imageCandidateUi.result.contents[0].text).toContain('处理中')
      expect(imageCandidateUi.result.contents[0].text).toContain('失败')
      expect(imageCandidateUi.result.contents[0].text).toContain('待确认')
      expect(imageCandidateUi.result.contents[0].text).toContain('aria-live="polite"')
      expect(imageCandidateUi.result.contents[0].text).toContain('aria-busy="false"')
      expect(imageCandidateUi.result.contents[0].text).toContain("status.setAttribute('role',error?'alert':'status')")
      expect(imageCandidateUi.result.contents[0].text).toContain("if(button.disabled||inFlight)return")
      expect(imageCandidateUi.result.contents[0].text).toContain("code==='IMAGE_GENERATION_REVISION_CONFLICT'")
      expect(imageCandidateUi.result.contents[0].text).toContain("code==='INTERACTIVE_CONFIRMATION_TICKET_INVALID'")
      expect(imageCandidateUi.result.contents[0].text).toContain("code==='INTERACTIVE_CONFIRMATION_INTENT_MISMATCH'")
      expect(imageCandidateUi.result.contents[0].text).toContain("return'confirmation_expired'")
      expect(imageCandidateUi.result.contents[0].text).toContain('maxAttempts')
      expect(imageCandidateUi.result.contents[0].text).toContain('Math.pow(2,pollAttempt)')
      expect(imageCandidateUi.result.contents[0].text).toContain("setTimeout(async function()")
      expect(imageCandidateUi.result.contents[0].text).toContain("自动查询已暂停")
      expect(imageCandidateUi.result.contents[0].text).toContain("button.textContent='刷新候选'")
      expect(imageCandidateUi.result.contents[0].text).toContain("button.textContent='重试保存'")
      expect(imageCandidateUi.result.contents[0].text).toContain("button.textContent='先查询结果'")
      expect(imageCandidateUi.result.contents[0].text).toContain("markSelectedInvalid()")
      expect(imageCandidateUi.result.contents[0].text).toContain("var alt='方案 '")
      expect(imageCandidateUi.result.contents[0].text).toContain("selected_visual_ref:String(candidate.visual_ref||'')")
      expect(imageCandidateUi.result.contents[0].text).toContain("callTool('catalog.image.get',{job_id:String(request.job_id||'')})")
      expect(imageCandidateUi.result.contents[0].text).toContain('image.src=src')
      expect(imageCandidateUi.result.contents[0].text).toContain('payload.image_urls')
      expect(imageCandidateUi.result.contents[0].text).toContain("merchant/candidateImageFallbacks")
      expect(imageCandidateUi.result.contents[0].text).toContain('responseMetadata.mcp_tool_result')
      expect(imageCandidateUi.result.contents[0].text).toContain("entry.type==='image'")
      expect(imageCandidateUi.result.contents[0].text).toContain("image.referrerPolicy='no-referrer'")
      expect(imageCandidateUi.result.contents[0].text).toContain("input.setAttribute('aria-disabled'")
      expect(imageCandidateUi.result.contents[0].text).toContain("image.alt='方案 '")
      expect(imageCandidateUi.result.contents[0].text).toContain('max-height:520px')
      expect(imageCandidateUi.result.contents[0].text).toContain(':focus-visible')
      expect(imageCandidateUi.result.contents[0].text).toContain('@media(prefers-color-scheme:dark)')
      expect(imageCandidateUi.result.contents[0].text).toContain('@media(prefers-reduced-motion:reduce)')
      expect((imageCandidateUi.result.contents[0].text.match(/<button\b/g) ?? []).length).toBe(1)
      expect(imageCandidateUi.result.contents[0].text).not.toMatch(/dashboard|工作台|管理员|运营后台|asset_id/iu)
      expect(imageCandidateUi.result.contents[0].text).not.toContain('票据')
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
      const listed = await nextLine(child.stdout)
      expect(listed.result.tools).toHaveLength(150)
      const catalogImageGet = listed.result.tools.find((tool: { name: string }) => tool.name === 'catalog.image.get')
      expect(catalogImageGet).toMatchObject({ name: 'catalog.image.get', annotations: { readOnlyHint: true } })
      expect(catalogImageGet).not.toHaveProperty('_meta')
      expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...new Set([...MCP_METHODS.filter(method => !method.startsWith('ops.') && !MERCHANT_HIDDEN_METHODS.has(method)), 'catalog.image.select'])].sort())
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'catalog.image.select')).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { required: ['job_id', 'visual_ref', 'expected_revision', 'idempotency_key', 'reason', 'confirmation_ticket_nonce_hash', 'confirmation_ticket_intent_hash'] },
      })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'catalog.image.retry')).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: { required: ['job_id', 'idempotency_key'] },
      })
      const imageSelectSchema = listed.result.tools.find((tool: { name: string }) => tool.name === 'catalog.image.select').inputSchema
      expect(imageSelectSchema.properties.confirmation_ticket_nonce_hash).toEqual({ type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 })
      expect(imageSelectSchema.properties.confirmation_ticket_intent_hash).toEqual({ type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 })
      expect(listed.result.tools.some((tool: { name: string }) => tool.name.startsWith('ops.'))).toBe(false)
      for (const name of ['ops.support.ticket.create', 'ops.incident.transition', 'ops.feature-flag.emergency.set', 'ops.finance.search']) {
        expect(listed.result.tools.some((tool: { name: string }) => tool.name === name)).toBe(false)
      }
      for (const name of MERCHANT_HIDDEN_METHODS) expect(listed.result.tools.some((tool: { name: string }) => tool.name === name)).toBe(false)
      /*
        'workspace.health', 'workspace.bootstrap', 'workspace.metrics', 'workspace.commercial.get', 'workspace.commercial.update', 'workspace.usage.get', 'ops.audit.list', 'ops.audit.export', 'ops.members.list', 'ops.workspaces.list', 'ops.commercial.offers.list', 'ops.commercial.offer.upsert', 'ops.commercial.addons.list', 'ops.commercial.addon.upsert', 'ops.commercial.coupons.list', 'ops.commercial.coupon.upsert', 'ops.commercial.rollouts.list', 'ops.commercial.rollout.upsert', 'ops.growth.funnel', 'ops.alerts.list', 'ops.alert.ack', 'ops.marketing.queue', 'ops.marketing.generation.retry', 'ops.marketing.publish.acknowledge', 'ops.marketing.revision.create', 'ops.member.upsert', 'ops.member.suspend', 'subscription.get', 'subscription.orders.list', 'subscription.order.create', 'subscription.change', 'billing.usage.consume', 'billing.usage.refund', 'billing.refund', 'billing.reconciliation', 'billing.export', 'platform.settings.get', 'platform.settings.update', 'billing.status', 'billing.recharge.create', 'billing.recharge.get', 'billing.transactions', 'workspace.deactivate', 'workspace.activate', 'ops.data.delete.list', 'ops.data.delete.cancel', 'ops.data.delete.approve', 'workspace.data.delete.request', 'platform.connect', 'platform.store.alias.set', 'catalog.search', 'catalog.categories', 'catalog.title.optimize', 'publish.batch.prepare', 'publish.batch.confirm', 'publish.batch.get', 'publish.batch.pause', 'publish.batch.resume', 'publish.batch.retry_failed', 'automation.policy.get', 'automation.policy.update', 'automation.scan', 'automation.pause', 'catalog.import', 'catalog.facts.confirm', 'catalog.product.disable', 'catalog.product.enable', 'catalog.image.generate', 'catalog.image.get', 'catalog.image.review', 'sync.retry_failed', 'rule.list', 'rule.sync.status', 'rule.history', 'rule.audit', 'rule.publish', 'rule.status', 'asset.list', 'asset.parse', 'asset.facts.confirm', 'asset.preference.update', 'brand.get', 'brand.extract', 'brand.upsert', 'brand.tone.preview', 'asset.upload', 'asset.upload.batch', 'asset.scan', 'asset.rights.update', 'catalog.sync', 'catalog.sync.start', 'catalog.sync.get', 'deliverable.list', 'task.history', 'task.clone', 'task.timeline', 'feedback.list', 'platform.revoke', 'task.create', 'task.answer',
        'task.understand', 'task.request.create', 'task.sku.split', 'task.group.create', 'creative.directions', 'creative.brief', 'creative.preview', 'creative.directions.update', 'task.select_direction', 'task.plan.confirm', 'content.generate', 'content.codex.prepare', 'content.codex.commit', 'generation.get', 'content.review', 'content.review.decide', 'content.visual.select',
        'content.versions', 'content.diff', 'content.export', 'content.approve', 'content.modify', 'content.restore',
        'publish.prepare', 'publish.confirm', 'publish.get',
        'knowledge.rule.create', 'knowledge.rule.list', 'knowledge.asset.create', 'knowledge.asset.update', 'knowledge.asset.list', 'knowledge.feedback.record', 'knowledge.learning.list', 'knowledge.learning.confirm', 'knowledge.learning.dismiss', 'knowledge.competitor.create', 'knowledge.competitor.list', 'knowledge.competitor.reference', 'multimodal.image.edit', 'multimodal.generate', 'multimodal.video.request', 'multimodal.video.get',
      ]) */
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'task.select_direction').inputSchema.properties.expected_version).toBeDefined()
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'content.approve').inputSchema.properties.expected_version).toBeDefined()
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'workspace.health').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'task.understand').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      for (const name of ['merchant.start', 'workspace.health', 'asset.upload', 'automation.scan']) {
        expect(listed.result.tools.find((tool: { name: string }) => tool.name === name)._meta).toBeUndefined()
      }
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'merchant.start').inputSchema.properties).toMatchObject({
        requested_platform: { type: 'string', enum: expect.arrayContaining(['jd']) },
        requested_goal: { type: 'string' },
        attachment_count: { type: 'integer', minimum: 0 },
      })
      for (const name of ['catalog.search', 'billing.status', 'billing.transactions', 'billing.recharge.get', 'publish.batch.get', 'multimodal.image.edit']) {
        expect(listed.result.tools.find((tool: { name: string }) => tool.name === name)._meta).toBeUndefined()
      }
      const taskComponents = {
        'creative.directions': ['ui://merchant-marketing/creative-choice-v1.html', '正在准备创意方向…', '创意方向已准备'],
        'content.diff': ['ui://merchant-marketing/content-diff-v1.html', '正在比较内容版本…', '版本差异已准备'],
        'publish.prepare': ['ui://merchant-marketing/publish-confirm-v1.html', '正在准备最终发布确认…', '发布确认已准备'],
        'publish.batch.prepare': ['ui://merchant-marketing/publish-confirm-v1.html', '正在准备批量发布确认…', '批量发布确认已准备'],
      } as const
      for (const [name, [resourceUri, invoking, invoked]] of Object.entries(taskComponents)) {
        expect(listed.result.tools.find((tool: { name: string }) => tool.name === name)._meta).toMatchObject({
          ui: { resourceUri, prefersBorder: true },
          'openai/outputTemplate': resourceUri,
          'openai/toolInvocation/invoking': invoking,
          'openai/toolInvocation/invoked': invoked,
        })
      }
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'task.group.create').description).toMatch(/批量生成入口/u)
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'deliverable.list').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'content.export').annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false })
      const rechargeGet = listed.result.tools.find((tool: { name: string }) => tool.name === 'billing.recharge.get')
      expect(rechargeGet.inputSchema.properties).toEqual({ order_id: { type: 'string' }, scope: { type: 'string', enum: ['mine', 'workspace'] } })
      expect(rechargeGet.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'content.generate')._meta?.ui).toBeUndefined()
      const workspaceMetrics = listed.result.tools.find((tool: { name: string }) => tool.name === 'workspace.metrics')
      expect(workspaceMetrics.inputSchema).toEqual({
        type: 'object',
        properties: { platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] }, account_id: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' }, risk_limit: { type: 'string' } },
        additionalProperties: false,
      })
      expect(workspaceMetrics.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'brand.extract').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'brand-unit.list').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'campaign.batch.get').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'campaign.batch.create').inputSchema.required).toEqual(['brand_id'])
      for (const name of ['campaign.batch.pause', 'campaign.batch.resume', 'campaign.batch.retry_failed']) {
        const tool = listed.result.tools.find((item: { name: string }) => item.name === name)
        expect(tool.inputSchema.required).toEqual(['campaign_id', 'expected_revision', 'idempotency_key', 'reason'])
        expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false })
      }
      expect(listed.result.tools.find((item: { name: string }) => item.name === 'campaign.batch.retry_failed').inputSchema.properties.item_ids_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'array' })
      const bindStore = listed.result.tools.find((tool: { name: string }) => tool.name === 'brand-unit.bind-store')
      expect(bindStore.inputSchema.required).toEqual(['brand_id', 'platform', 'account_id'])
      expect(bindStore.inputSchema.properties.expected_revision).toEqual({ type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'knowledge.competitor.reference').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'knowledge.rule.create').inputSchema.properties.source_kind.enum).toEqual(['official', 'internal', 'merchant', 'observed', 'legal_review'])
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'multimodal.video.request').inputSchema.properties.idempotency_key).toMatchObject({ type: 'string' })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'workspace.activate').inputSchema.required).toEqual(['reason'])
      for (const name of ['platform.media.spec.list', 'platform.media.spec.get', 'platform.mapping.preflight', 'delivery.bundle.verify']) {
        expect(listed.result.tools.find((tool: { name: string }) => tool.name === name).annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      }
      const mediaCreate = listed.result.tools.find((tool: { name: string }) => tool.name === 'platform.media.spec.create')
      expect(mediaCreate.inputSchema.required).toEqual(expect.arrayContaining(['expected_revision', 'idempotency_key', 'reason', 'spec_json']))
      expect(mediaCreate.inputSchema.properties.spec_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'object' })
      expect(mediaCreate.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'delivery.bundle.verify').inputSchema.properties.files_json).toMatchObject({ contentMediaType: 'application/json', jsonShape: 'array' })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'publish.confirm').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'billing.recharge.get', arguments: { order_id: 'order_test', confirm_test_payment: 'true' } } })}\n`)
      expect((await nextLine(child.stdout)).error).toMatchObject({ code: -32602, message: 'Unsupported tool argument: confirm_test_payment' })
      expect(requests).toHaveLength(0)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace.metrics', arguments: { date_from: '2026-08-18T00:00:00+08:00', date_to: '2026-08-25T23:59:59+08:00', risk_limit: '25' } } })}\n`)
      const called = await nextLine(child.stdout)
      expect(called.result.isError).toBe(false)
      expect(requests[0]!.headers['x-workspace-id']).toBe('ws_test')
      expect(requests[0]!.body.method).toBe('workspace.metrics')
      expect(requests[0]!.body.params).toEqual({
        date_from: '2026-08-18T00:00:00+08:00',
        date_to: '2026-08-25T23:59:59+08:00',
        risk_limit: '25',
        workspace_id: 'ws_test',
      })
    } finally {
      child.kill()
      server.close()
      await once(server, 'close').catch(() => undefined)
    }
  })

  it('forwards the five corrected tool schemas as requests accepted by the authoritative contract', async () => {
    const requests: any[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { accepted: true } }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const calls = [
      ['catalog.sync', { platform: 'taobao', account_id: 'acct_1', cursor: 'cursor_2' }],
      ['task.history', { publish_status: 'reconciling' }],
      ['task.group.create', { entries_json: '[]', request_text: '批量生成' }],
      ['task.plan.confirm', { task_id: 'task_1', expected_version: '2', price_impact_confirmed: 'true' }],
      ['multimodal.video.request', { prompt: '生成分镜', output: 'storyboard', context_json: '{}' }],
    ] as const
    try {
      for (const [index, [name, args]] of calls.entries()) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: args } })}\n`)
        expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { accepted: true } })
      }
      expect(requests).toHaveLength(calls.length)
      for (const [index, request] of requests.entries()) {
        expect(request).toMatchObject({ jsonrpc: '2.0', method: calls[index]![0], params: { ...calls[index]![1], workspace_id: 'ws_test' } })
        expect(validateMcpRequest(request), `${request.method} bridge request must satisfy the authoritative contract`).toEqual({ valid: true, errors: [] })
      }
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('executes catalog.image.review through the bridge as a safe read path', async () => {
    const requests: any[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { productId: 'prod_1', findings: [], externallyUnverified: ['平台最终审核'] } }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'catalog.image.review', arguments: { product_id: 'prod_1', visual_refs_json: '["visual_1"]' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({ isError: false, structuredContent: { productId: 'prod_1', findings: [] } })
      expect(requests[0]).toMatchObject({ method: 'catalog.image.review', params: { product_id: 'prod_1', visual_refs_json: '["visual_1"]', workspace_id: 'ws_test' } })
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('binds the minimal image chooser to every archived clean catalog candidate result', async () => {
    const firstImage = 'data:image/png;base64,aW1hZ2Ux'
    const secondImage = 'data:image/png;base64,aW1hZ2Uy'
    const firstImageUrl = 'https://assets.example.test/candidate-1.png?expires=9999999999&sig=one'
    const secondImageUrl = 'https://assets.example.test/candidate-2.png?expires=9999999999&sig=two'
    const firstTicket = { visual_ref: 'visual_secret_1', nonce_hash: 'a'.repeat(64), intent_hash: 'b'.repeat(64), expires_at: '2099-01-01T00:00:00.000Z' }
    const secondTicket = { visual_ref: 'visual_secret_2', nonce_hash: 'c'.repeat(64), intent_hash: 'd'.repeat(64), expires_at: '2099-01-01T00:00:00.000Z' }
    const hiddenTicket = { visual_ref: 'visual_hidden', nonce_hash: 'e'.repeat(64), intent_hash: 'f'.repeat(64), expires_at: '2099-01-01T00:00:00.000Z' }
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const candidates = [
        { visualRef: 'visual_secret_1', assetId: 'asset_secret_1', ordinal: 1, scanStatus: 'clean' },
        { visualRef: 'visual_secret_2', assetId: 'asset_secret_2', ordinal: 2, scanStatus: request.params.job_id === 'job_dirty' ? 'quarantined' : 'clean' },
      ]
      const state = request.params.job_id === 'job_queued' ? 'queued' : request.params.job_id === 'job_failed' ? 'failed' : request.params.job_id === 'job_unknown' ? 'running' : undefined
      const result = request.params.visual_ref
        ? { job_id: 'job_secret', execution: { providerRequestId: 'provider_secret' }, images: [firstImage], image_urls: [firstImageUrl], selection_tickets: [firstTicket, secondTicket, hiddenTicket], job: { revision: 7, archiveState: 'archived', candidates } }
        : state
          ? { job_id: request.params.job_id, job: { state, errorCode: state === 'failed' ? 'IMAGE_GENERATION_FAILED' : state === 'running' && request.params.job_id === 'job_unknown' ? 'IMAGE_ARTIFACT_RECONCILIATION_REQUIRED' : undefined, reconciliationRequired: request.params.job_id === 'job_unknown', archiveState: 'pending', candidates } }
          : { job_id: request.params.job_id, execution: { providerRequestId: 'provider_secret' }, images: [firstImage, secondImage], image_urls: request.params.job_id === 'job_native' ? [] : [firstImageUrl, secondImageUrl], selection_tickets: [firstTicket, secondTicket, hiddenTicket], job: { revision: 7, archiveState: request.params.job_id === 'job_unarchived' ? 'processing' : 'archived', candidates } }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'catalog.image.get', arguments: { job_id: 'job_secret' } } })}\n`)
      const multiple = await nextLine(child.stdout)
      expect(multiple.result).toMatchObject({ isError: false })
      expect(multiple.result._meta).toMatchObject({ ui: { resourceUri: 'ui://merchant-marketing/image-candidate-choice-v15.html', prefersBorder: true }, 'openai/outputTemplate': 'ui://merchant-marketing/image-candidate-choice-v15.html', 'merchant/candidateImages': [firstImageUrl, secondImageUrl], 'merchant/candidateImageFallbacks': [firstImage, secondImage], 'merchant/candidateSelectionTickets': [firstTicket, secondTicket] })
      expect(multiple.result.structuredContent).toEqual({
        candidate_state: { state: 'ready', archive_state: 'archived', scan_status: 'clean', candidate_count: 2, presentation: 'component', next_action: { type: 'select', label: '选择主图', allowed: true }, recovery: { retryable: false, reconciliation_required: false } },
        completed_summary: '已准备 2 张通过自动检查的主图候选。',
        question: '请选择一张作为主图。',
        expected_input: { kind: 'main_image_selection', accepts: ['component_selection', 'natural_language'], selection_count: 1 },
        selection_request: { job_id: 'job_secret', expected_revision: '7', candidates: [{ ordinal: 1, visual_ref: 'visual_secret_1', selectable: true, subject_label: '商品主体', availability_label: '可用' }, { ordinal: 2, visual_ref: 'visual_secret_2', selectable: true, subject_label: '商品主体', availability_label: '可用' }] },
        display_request: { job_id: 'job_secret' },
      })
      expect(multiple.result.content[0]).toEqual({ type: 'text', text: '主图候选已准备好。' })
      expect(multiple.result.content.filter((item: { type: string }) => item.type === 'image')).toHaveLength(2)
      expect(JSON.stringify({ content: multiple.result.content, structuredContent: multiple.result.structuredContent })).not.toMatch(/data:image|asset_secret|provider_secret|visualRef|assetId|管理员|运营后台|context_bar|action_cards/iu)
      expect(JSON.stringify({ content: multiple.result.content, structuredContent: multiple.result.structuredContent })).not.toMatch(/selection_tickets|nonce_hash|intent_hash|a{64}|b{64}|c{64}|d{64}/u)

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'catalog.image.get', arguments: { visual_ref: 'visual_secret_1' } } })}\n`)
      const single = await nextLine(child.stdout)
      expect(single.result._meta).toMatchObject({ ui: { resourceUri: 'ui://merchant-marketing/image-candidate-choice-v15.html' }, 'merchant/candidateImages': [firstImageUrl], 'merchant/candidateImageFallbacks': [firstImage], 'merchant/candidateSelectionTickets': [firstTicket] })
      expect(single.result.structuredContent).toEqual({
        candidate_state: { state: 'ready', archive_state: 'archived', scan_status: 'clean', candidate_count: 1, presentation: 'component', next_action: { type: 'select', label: '选择主图', allowed: true }, recovery: { retryable: false, reconciliation_required: false } },
        completed_summary: '主图候选已准备好。',
        question: '要使用这张作为主图吗？',
        expected_input: { kind: 'main_image_selection', accepts: ['component_selection', 'natural_language'], selection_count: 1 },
        selection_request: { job_id: 'job_secret', expected_revision: '7', candidates: [{ ordinal: 1, visual_ref: 'visual_secret_1', selectable: true, subject_label: '商品主体', availability_label: '可用' }] },
        display_request: { visual_ref: 'visual_secret_1' },
      })
      expect(single.result.content[0]).toEqual({ type: 'text', text: '主图候选已准备好。' })
      expect(single.result.content.filter((item: { type: string }) => item.type === 'image')).toHaveLength(1)
      expect(JSON.stringify({ content: single.result.content, structuredContent: single.result.structuredContent })).not.toMatch(/data:image|asset_secret|provider_secret|visualRef|assetId|管理员|运营后台|context_bar|action_cards/iu)
      expect(JSON.stringify({ content: single.result.content, structuredContent: single.result.structuredContent })).not.toMatch(/selection_tickets|nonce_hash|intent_hash|a{64}|b{64}/u)

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2.5, method: 'tools/call', params: { name: 'catalog.image.get', arguments: { job_id: 'job_native' } } })}\n`)
      const native = await nextLine(child.stdout)
      expect(native.result.structuredContent.candidate_state.presentation).toBe('native_image')
      expect(native.result.structuredContent).not.toHaveProperty('images')
      expect(native.result.structuredContent).not.toHaveProperty('image_urls')
      expect(native.result._meta).toMatchObject({
        ui: { resourceUri: 'ui://merchant-marketing/image-candidate-choice-v15.html' },
        'merchant/candidateImageFallbacks': [firstImage, secondImage],
        'merchant/candidateSelectionTickets': [firstTicket, secondTicket],
      })
      expect(native.result.content.filter((item: { type: string }) => item.type === 'image')).toHaveLength(2)
      expect(JSON.stringify({ content: native.result.content.map((item: { type: string; text?: string }) => item.type === 'text' ? item : { type: item.type }), structuredContent: native.result.structuredContent })).not.toMatch(/selection_tickets|nonce_hash|intent_hash|a{64}|b{64}|c{64}|d{64}/u)

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'catalog.image.get', arguments: { job_id: 'job_dirty' } } })}\n`)
      const dirty = await nextLine(child.stdout)
      expect(dirty.result).not.toHaveProperty('_meta')
      expect(dirty.result.structuredContent).toEqual({
        candidate_state: { state: 'processing', archive_state: 'archived', scan_status: 'processing', candidate_count: 0, presentation: 'component_progress', next_action: { type: 'wait', label: '系统自动继续', allowed: false }, recovery: { retryable: false, reconciliation_required: false } },
        completed_summary: '主图候选仍在自动检查，通过后会继续，无需操作。',
        expected_input: { kind: 'none', user_action_required: false },
        poll_request: { job_id: 'job_dirty', max_attempts: 4, initial_delay_ms: 750, max_delay_ms: 4000 },
      })
      expect(dirty.result.content).toEqual([{ type: 'text', text: '主图候选仍在自动检查，通过后会继续，无需操作。' }])
      expect(JSON.stringify(dirty.result)).not.toMatch(/data:image|管理员|运营后台|context_bar|action_cards/iu)

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'catalog.image.get', arguments: { job_id: 'job_unarchived' } } })}\n`)
      const unarchived = await nextLine(child.stdout)
      expect(unarchived.result).not.toHaveProperty('_meta')
      expect(unarchived.result.structuredContent).toMatchObject({
        candidate_state: { state: 'processing', archive_state: 'processing', scan_status: 'processing', candidate_count: 0, presentation: 'component_progress', next_action: { type: 'wait', label: '系统自动继续', allowed: false }, recovery: { retryable: false, reconciliation_required: false } },
        expected_input: { kind: 'none', user_action_required: false },
        poll_request: { job_id: 'job_unarchived', max_attempts: 4, initial_delay_ms: 750, max_delay_ms: 4000 },
      })
      expect(JSON.stringify(unarchived.result)).not.toMatch(/data:image|管理员|运营后台|context_bar|action_cards/iu)

      for (const [id, state, summary] of [['job_queued', 'queued', '图片任务已排队'], ['job_failed', 'failed', '本次主图生成未完成'], ['job_unknown', 'unknown', '图片结果尚未确认']] as const) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: id, method: 'tools/call', params: { name: 'catalog.image.get', arguments: { job_id: id } } })}\n`)
        const response = await nextLine(child.stdout)
        expect(response.result.structuredContent.candidate_state.state).toBe(state)
        expect(response.result.structuredContent.completed_summary).toContain(summary)
        if (state === 'queued') {
          expect(response.result.content[0].text).toContain(summary)
          expect(response.result).not.toHaveProperty('_meta')
          expect(response.result.structuredContent.candidate_state).toMatchObject({ presentation: 'component_progress', next_action: { type: 'wait', allowed: false } })
          expect(response.result.structuredContent.expected_input).toEqual({ kind: 'none', user_action_required: false })
          expect(response.result.structuredContent.poll_request).toEqual({ job_id: id, max_attempts: 4, initial_delay_ms: 750, max_delay_ms: 4000 })
        } else {
          const action = state === 'failed' ? 'regenerate_in_conversation' : 'refresh'
          expect(response.result).not.toHaveProperty('_meta')
          expect(response.result.structuredContent.candidate_state.presentation).toBe('component_recovery')
          expect(response.result.structuredContent.expected_input).toEqual({ kind: 'component_action', action, user_action_required: true })
          expect(response.result.structuredContent.recovery_request).toEqual({ job_id: id, action })
          expect(response.result.structuredContent.question).toMatch(state === 'failed' ? /回到对话重新生成/u : /查询图片结果/u)
          expect(response.result.content[0].text).toBe(response.result.structuredContent.question)
        }
      }
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('restores the preferred image after refresh and accepts a new choice only with the new revision', async () => {
    const images = ['data:image/png;base64,aW1hZ2Ux', 'data:image/png;base64,aW1hZ2Uy']
    const imageUrls = ['https://assets.example.test/candidate-1.png', 'https://assets.example.test/candidate-2.png']
    const candidates = [
      { visualRef: 'visual_1', ordinal: 1, scanStatus: 'clean', subjectLabel: '白色运动鞋' },
      { visualRef: 'visual_2', ordinal: 2, scanStatus: 'clean', subjectLabel: '白色运动鞋' },
    ]
    const tickets = {
      visual_1: { visual_ref: 'visual_1', nonce_hash: '1'.repeat(64), intent_hash: '2'.repeat(64), expires_at: '2099-01-01T00:00:00.000Z' },
      visual_2: { visual_ref: 'visual_2', nonce_hash: '3'.repeat(64), intent_hash: '4'.repeat(64), expires_at: '2099-01-01T00:00:00.000Z' },
    }
    let revision = 7
    let preferred = ''
    const committed = new Map<string, { visualRef: string, revision: number }>()
    const selectRequests: any[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      let result: any
      if (request.method === 'catalog.image.get') {
        result = {
          job_id: 'job_revision', images, image_urls: imageUrls, selection_tickets: Object.values(tickets),
          job: { revision, state: 'succeeded', archiveState: 'archived', candidates, ...(preferred ? { preferredCandidate: { visualRef: preferred } } : {}) },
        }
      } else if (request.method === 'catalog.image.select') {
        selectRequests.push(request.params)
        const key = request.params.idempotency_key
        const replay = committed.get(key)
        if (replay) {
          result = { job_id: 'job_revision', visual_ref: replay.visualRef, preference_status: 'selected', revision: replay.revision, idempotent_replay: true }
        } else {
          expect(request.params.expected_revision).toBe(String(revision))
          preferred = request.params.visual_ref
          revision += 1
          committed.set(key, { visualRef: preferred, revision })
          result = { job_id: 'job_revision', visual_ref: preferred, preference_status: 'selected', revision, idempotent_replay: false }
        }
      } else {
        result = { enabled: true }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const call = async (id: number, name: string, args: Record<string, string>) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
      return nextLine(child.stdout)
    }
    try {
      const initial = await call(1, 'catalog.image.get', { job_id: 'job_revision' })
      expect(initial.result.structuredContent.selection_request).toMatchObject({ expected_revision: '7' })
      expect(initial.result.structuredContent.selection_request.selected_visual_ref).toBeUndefined()
      expect(initial.result.structuredContent.selection_request.candidates[0]).toMatchObject({ subject_label: '白色运动鞋', availability_label: '可用' })
      expect(initial.result._meta['merchant/candidateSelectionTickets']).toEqual(Object.values(tickets))
      expect(JSON.stringify({ structuredContent: initial.result.structuredContent, content: initial.result.content })).not.toMatch(/selection_tickets|nonce_hash|intent_hash|1{64}|2{64}|3{64}|4{64}/u)

      const firstSaveArgs = { job_id: 'job_revision', visual_ref: 'visual_1', expected_revision: '7', idempotency_key: 'choice:first', reason: '用户选择方案一', confirmation_ticket_nonce_hash: tickets.visual_1.nonce_hash, confirmation_ticket_intent_hash: tickets.visual_1.intent_hash }
      expect((await call(2, 'catalog.image.select', firstSaveArgs)).result.structuredContent).toMatchObject({ visual_ref: 'visual_1', revision: 8, idempotent_replay: false })
      expect((await call(3, 'catalog.image.select', firstSaveArgs)).result.structuredContent).toMatchObject({ visual_ref: 'visual_1', revision: 8, idempotent_replay: true })
      expect(revision).toBe(8)

      const restored = await call(4, 'catalog.image.get', { job_id: 'job_revision' })
      expect(restored.result.structuredContent.selection_request).toMatchObject({ selected_visual_ref: 'visual_1', expected_revision: '8' })

      expect((await call(5, 'catalog.image.select', { job_id: 'job_revision', visual_ref: 'visual_2', expected_revision: '8', idempotency_key: 'choice:second', reason: '用户改选方案二', confirmation_ticket_nonce_hash: tickets.visual_2.nonce_hash, confirmation_ticket_intent_hash: tickets.visual_2.intent_hash })).result.structuredContent).toMatchObject({ visual_ref: 'visual_2', revision: 9 })
      expect(selectRequests.map(request => [request.visual_ref, request.expected_revision, request.confirmation_ticket_nonce_hash, request.confirmation_ticket_intent_hash])).toEqual([
        ['visual_1', '7', tickets.visual_1.nonce_hash, tickets.visual_1.intent_hash],
        ['visual_1', '7', tickets.visual_1.nonce_hash, tickets.visual_1.intent_hash],
        ['visual_2', '8', tickets.visual_2.nonce_hash, tickets.visual_2.intent_hash],
      ])
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('exposes merchant.first_value as a read-only safe preview and forwards optional scope', async () => {
    const requests: any[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { preview: true } }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
      const listed = await nextLine(child.stdout)
      const firstValue = listed.result.tools.find((tool: { name: string }) => tool.name === 'merchant.first_value')
      expect(firstValue.inputSchema).toEqual({
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] },
          account_id: { type: 'string' },
          product_id: { type: 'string' },
          example: { type: 'string', enum: ['true'] },
        },
        additionalProperties: false,
      })
      expect(firstValue.description).toMatch(/安全预览包.*不发布.*服务端.*不调用模型/u)
      expect(firstValue.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'merchant.first_value', arguments: { platform: 'taobao', account_id: 'acct_1', product_id: 'prod_1' } } })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { preview: true } })
      expect(requests).toEqual([{ jsonrpc: '2.0', id: expect.any(String), method: 'merchant.first_value', params: { platform: 'taobao', account_id: 'acct_1', product_id: 'prod_1', workspace_id: 'ws_test' } }])
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('publishes task-specific decision components and batch-list metadata without inventing a business unit', async () => {
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      const request = JSON.parse(body)
      const result = request.method === 'catalog.search'
        ? { products: [{ id: 'prod_1', platform: 'taobao', account_id: 'acct_1', source: 'fixture' }], scope: 'store' }
        : { workspace: { id: 'ws_test' }, stores: [{ platform: 'taobao', account_id: 'acct_1' }] }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const componentCases = [
        ['ui://merchant-marketing/creative-choice-v1.html', '选择一个创意方向', '确认选择', "callTool('task.select_direction'", 'data-component="creative"'],
        ['ui://merchant-marketing/content-diff-v1.html', '比较内容版本', '保留所选版本', "callTool('content.restore'", 'data-component="diff"'],
        ['ui://merchant-marketing/publish-confirm-v1.html', '最终发布确认', '确认发布', "callTool('publish.confirm'", 'data-component="publish"'],
      ]
      for (const [uri, title, cta, toolCall, marker] of componentCases) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } })}\n`)
        const html = (await nextLine(child.stdout)).result.contents[0].text
        expect(html).toContain('window.openai&&window.openai.toolOutput')
        expect(html).toContain(title)
        expect(html).toContain(`>${cta}</button>`)
        expect(html).toContain(toolCall)
        expect(html).toContain(marker)
        expect(html).toContain("radio.type='radio'")
        expect(html).toContain('disabled')
        expect((html.match(/<button\b/g) ?? []).length).toBe(1)
        expect(html).not.toMatch(/<input[^>]+checked/iu)
        expect(html).toContain(':focus-visible')
        expect(html).toContain('@media(prefers-color-scheme:dark)')
        expect(html).toContain('@media(prefers-reduced-motion:reduce)')
        expect(html).not.toContain('context-v2')
        expect(html).not.toContain('大麦商家工作台')
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'catalog.search', arguments: { scope: 'store', platform: 'taobao', account_id: 'acct_1' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.structuredContent.ui).toMatchObject({
        surface: 'merchant_codex_app',
        data_status: 'real_or_server_reported',
        context_bar: { order: ['workspace', 'business_unit', 'platform', 'store'], reset_on_change: { business_unit: ['platform', 'account_id', 'product_id', 'selected_product_ids'] } },
        list: { kind: 'products', selection: 'multi', selection_key: 'product_id' },
      })
      expect(response.result.structuredContent.ui.list).not.toHaveProperty('batch_actions')
      expect(response.result.structuredContent.ui.context_bar.selection.business_unit).toMatchObject({ state: 'not_provided', value: null, options: [] })
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('adds a deterministic idempotency key for content generation', async () => {
    const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: any }> = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { status: 'unknown' } }, error: null }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content.generate', arguments: { task_id: 'task_1' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.content[0].text).toContain('状态尚未确认')
      expect(response.result.content[0].text).not.toContain('操作已完成')
      expect(requests[0]!.headers['idempotency-key']).toMatch(/^mcp-[a-f0-9]{64}$/)
      expect(requests[0]!.headers['idempotency-key']).toBeDefined()
    } finally {
      child.kill()
      server.close()
      await once(server, 'close').catch(() => undefined)
    }
  })

  it('projects async workflow status into a merchant-safe status card', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: {
        workflow: {
          kind: 'publish',
          resource_id: 'publish_internal',
          status: { internal_state: 'unknown', user_state: '发布结果待确认', terminal: false, updated_at: '2026-08-31T00:00:00Z' },
          progress: { known: false, completed: 0, total: null, label: '结果未知' },
          next_action: { method: 'publish.get', label: '查询发布状态', allowed: true },
          recovery: { retryable: false, reconciliation_required: true, retry_scope: '人工对账' },
          evidence: { source: 'official_api', simulated: false },
        },
      } }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], { cwd: process.cwd(), env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' }, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'publish.get', arguments: { publish_job_id: 'publish_internal' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.structuredContent.merchant_status).toMatchObject({ state: 'unknown', label: '发布结果待确认', next_action: { label: '查询发布状态', allowed: true }, recovery: { retryable: false, reconciliation_required: true } })
      expect(response.result.content[0].text).toContain('不要重复提交')
      expect(response.result.content[0].text).toContain('查询发布状态')
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('uploads an attached local file without putting base64 in the model tool arguments', async () => {
    const requests: any[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.setHeader('content-type', 'application/json')
      const body = requests.at(-1)
      const result = body.method === 'asset.list'
        ? { assets: [{ id: 'asset_local_1', workspaceId: 'ws_secret', storageKey: 'clean/private.png', sha256: 'secret-digest', scanReceiptId: 'receipt-secret', revision: 9, scanStatus: 'clean' }], asset_actions: [{ asset_id: 'asset_local_1', next_step: '确认素材商用权益' }] }
        : { id: 'asset_local_1', workspaceId: 'ws_secret', storageKey: 'quarantine/private.png', sha256: 'secret-digest', scanReceiptDigest: 'receipt-secret', revision: 8, scanStatus: 'quarantined', generationContinuation: { jobId: 'job_private_1', state: 'waiting_scan' } }
      res.end(JSON.stringify({ data: { result }, error: null }))
    })
    const address = await listen(server)
    const directory = await mkdtemp(join(tmpdir(), 'merchant-local-upload-'))
    const filePath = join(directory, 'product.png')
    const bytes = Buffer.from('local-product-image-bytes')
    await writeFile(filePath, bytes)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_ASSET_SCAN_POLL_TIMEOUT_MS: '500', MERCHANT_ASSET_SCAN_POLL_INTERVAL_MS: '25' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
      const listed = await nextLine(child.stdout)
      const upload = listed.result.tools.find((tool: { name: string }) => tool.name === 'asset.upload')
      expect(upload.inputSchema.properties.file_path).toBeDefined()
      expect(upload.inputSchema.properties).toMatchObject({
        continuation_kind: { type: 'string', enum: ['image_generation'] },
        continuation_product_id: { type: 'string' },
        continuation_task_id: { type: 'string' },
        continuation_content_version_id: { type: 'string' },
        continuation_sku_ids_json: { type: 'string' },
        continuation_direction: { type: 'string' },
        continuation_count: { type: 'string' },
        continuation_idempotency_key: { type: 'string' },
      })
      expect(upload.inputSchema.required).toEqual(['name', 'mime_type'])
      expect(upload.description).toMatch(/自动完成安全检查/u)
      expect(upload.description).toMatch(/不要调用 automation\.scan/u)
      expect(upload.description).toMatch(/不要要求.*人工证据/u)
      for (const toolName of ['asset.upload', 'task.create']) {
        const tool = listed.result.tools.find((item: { name: string }) => item.name === toolName)
        expect(tool).toBeDefined()
        for (const forbidden of ['ai_base_url', 'ai_api_key', 'ai_model', 'image_base_url', 'image_api_key', 'image_model', 'endpoint', 'api_key', 'model']) {
          expect(tool.inputSchema.properties).not.toHaveProperty(forbidden)
        }
      }
      const continuation = { continuation_kind: 'image_generation', continuation_product_id: 'prod_1', continuation_task_id: 'task_1', continuation_content_version_id: 'cv_1', continuation_sku_ids_json: '["sku_1"]', continuation_direction: '京东白底主图', continuation_count: '1', continuation_idempotency_key: 'upload-generation-1' }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'asset.upload', arguments: { name: 'product.png', mime_type: 'image/png', file_path: filePath, ...continuation } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(false)
      expect(response.result._meta).toBeUndefined()
      expect(response.result.structuredContent).toMatchObject({ scanStatus: 'clean', scanAutomation: { state: 'completed', userActionRequired: false }, scan_wait: { state: 'completed', user_action_required: false }, next_step: '确认素材商用权益' })
      expect(response.result.structuredContent.generation_continuation).toBeUndefined()
      for (const forbidden of ['workspaceId', 'workspace_id', 'storageKey', 'storage_key', 'sha256', 'scanReceiptId', 'scanReceiptDigest', 'revision', 'jobId']) {
        expect(JSON.stringify(response.result.structuredContent)).not.toContain(forbidden)
      }
      expect(response.result.content[0].text).toContain('检查已通过')
      expect(requests[0].params).toMatchObject({ name: 'product.png', mime_type: 'image/png', content_base64: bytes.toString('base64'), ...continuation })
      expect(requests[0].params.file_path).toBeUndefined()
      expect(requests[0].params.sha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(requests.map(request => request.method)).toEqual(['asset.upload', 'asset.list'])
    } finally {
      child.kill()
      await close(server)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns only merchant-safe asset list fields and reduces blocked guidance to re-upload', async () => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume request */ }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: {
        assets: [{ id: 'asset_blocked_1', name: 'bad.png', mimeType: 'image/png', scanStatus: 'blocked', workspaceId: 'ws_secret', storageKey: 'quarantine/secret', sha256: 'digest', scanReceiptId: 'receipt_1', scanReceiptDigest: 'digest_1', revision: 7, scanFindings: ['private-engine-code'] }],
        readiness: { draft: 0, ready: 0, blocked: 1, total: 1, internalCounter: 99 },
        storage_quota: { usedBytes: 800, reservedBytes: 100, limitBytes: 1000, availableBytes: 100, status: 'near_limit', storageKey: 'secret' },
        asset_actions: [{ asset_id: 'asset_blocked_1', asset_name: 'bad.png', status: 'blocked', reasons: ['private-engine-code'], next_step: '联系安全审核并提交扫描证据', revision: 7 }],
        action_cards: [{ method: 'ops.secret', label: '内部操作' }],
      } }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'asset.list', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(false)
      expect(response.result.structuredContent).toEqual({
        assets: [{ asset_id: 'asset_blocked_1', name: 'bad.png', mime_type: 'image/png', scan_status: 'blocked', next_step: '重新提交这张图片即可触发平台自动复检，无需人工处理' }],
        readiness: { draft: 0, ready: 0, blocked: 1, total: 1 },
        storage_quota: { used_bytes: 800, reserved_bytes: 100, limit_bytes: 1000, available_bytes: 100, status: 'near_limit' },
        asset_actions: [{ asset_id: 'asset_blocked_1', name: 'bad.png', scan_status: 'quarantined', readiness_status: 'blocked', next_step: '重新提交这张图片即可触发平台自动复检，无需人工处理', user_action_required: true }],
        empty_state: null,
      })
      const serialized = JSON.stringify(response.result.structuredContent)
      for (const forbidden of ['workspaceId', 'storageKey', 'sha256', 'scanReceipt', 'revision', 'private-engine-code', 'ops.secret']) expect(serialized).not.toContain(forbidden)
      expect(serialized).not.toMatch(/运营后台|扫描证据|安全审核/u)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it.each([
    ['blocked', 'blocked', '平台会在你重新提交图片时自动复检', true],
    ['pending', 'quarantined', '检查通过后会等待你的确认', false],
  ])('keeps automatic asset scanning conversational when the result is %s', async (_case, scanStatus, expectedText, userActionRequired) => {
    const methods: string[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      const request = JSON.parse(body)
      methods.push(request.method)
      const result = request.method === 'asset.list'
        ? { assets: [{ id: 'asset_scan_1', scanStatus }], asset_actions: [{ asset_id: 'asset_scan_1' }] }
        : { id: 'asset_scan_1', scanStatus: 'quarantined' }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_ASSET_SCAN_POLL_TIMEOUT_MS: '100', MERCHANT_ASSET_SCAN_POLL_INTERVAL_MS: '25' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'asset.upload', arguments: { name: 'product.png', mime_type: 'image/png', content_base64: Buffer.from('image').toString('base64') } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(false)
      expect(response.result._meta).toBeUndefined()
      expect(response.result.structuredContent.scan_wait).toMatchObject({ user_action_required: userActionRequired })
      expect(response.result.structuredContent.scanAutomation).toMatchObject({ state: scanStatus === 'blocked' ? 'blocked' : 'pending', userActionRequired })
      expect(response.result.content[0].text).toContain(expectedText)
      expect(JSON.stringify(response.result)).not.toMatch(/联系管理员|运营后台|扫描证据|回复.{0,4}扫描完成/u)
      expect(methods[0]).toBe('asset.upload')
      expect(methods).toContain('asset.list')
      expect(methods).not.toContain('automation.scan')
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('keeps an unavailable official OAuth connection merchant-safe and resumable', async () => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume request */ }
      res.statusCode = 503
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: { code: 'NOT_CONFIGURED', message: 'jd official OAuth client secret missing' } }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_MCP_RETRY_ATTEMPTS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'platform.connect', arguments: { platform: 'jd' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'NOT_CONFIGURED',
          recovery: { state: 'service_unavailable', user_action_required: false, resume_message: '继续' },
        },
      })
      expect(response.result.content[0].text).toContain('当前京东官方连接尚未启用')
      expect(response.result.content[0].text).toContain('商品图片和确认信息已保留')
      expect(JSON.stringify(response.result)).not.toMatch(/管理员|运营后台|client secret|OAuth 密钥/u)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('keeps the uploaded asset pending when status polling is temporarily unavailable', async () => {
    const methods: string[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      const request = JSON.parse(body)
      methods.push(request.method)
      res.setHeader('content-type', 'application/json')
      if (request.method === 'asset.list') {
        res.statusCode = 503
        res.end(JSON.stringify({ error: { code: 'API_UNAVAILABLE', message: 'temporary outage' } }))
        return
      }
      res.end(JSON.stringify({ data: { result: { id: 'asset_pending_1', scanStatus: 'quarantined' } }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_MCP_RETRY_ATTEMPTS: '1', MERCHANT_ASSET_SCAN_POLL_TIMEOUT_MS: '100', MERCHANT_ASSET_SCAN_POLL_INTERVAL_MS: '25' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'asset.upload', arguments: { name: 'product.png', mime_type: 'image/png', content_base64: Buffer.from('image').toString('base64') } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({ isError: false, structuredContent: { scanStatus: 'quarantined', scan_wait: { state: 'processing', user_action_required: false, timed_out: true } } })
      expect(response.result.content[0].text).toContain('检查通过后会等待你的确认')
      expect(JSON.stringify(response.result)).not.toMatch(/管理员|运营后台|扫描证据/u)
      expect(methods).toEqual(['asset.upload', 'asset.list'])
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('returns a merchant-safe recovery path when asset parsing fails', async () => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume request */ }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: {
        code: 'ASSET_PARSE_FAILED',
        message: 'parser failed: internal parser detail',
        details: { asset_id: 'asset_parse_1', asset_persisted: true, retryable: true, attempts: 2, next_actions: ['asset.parse', 'asset.facts.confirm'], request_id: 'req_asset_parse_1' },
      } }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'asset.parse', arguments: { asset_id: 'asset_parse_1' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'ASSET_PARSE_FAILED',
          asset_id: 'asset_parse_1',
          asset_persisted: true,
          conversation_state: { stage: 'confirm_asset_facts', current_asset_id: 'asset_parse_1', workspace_binding_valid: true, rediscovery_required: false },
          next_action: { method: 'asset.facts.confirm', arguments: { asset_id: 'asset_parse_1' }, required_inputs: ['facts_json', 'reason'] },
          details: { asset_id: 'asset_parse_1', asset_persisted: true, retryable: true, attempts: 2, next_actions: ['asset.parse', 'asset.facts.confirm'], request_id: 'req_asset_parse_1' },
        },
      })
      expect(response.result.structuredContent.message).toContain('图片已保存')
      expect(response.result.content[0]).toMatchObject({ type: 'text' })
      expect(response.result.content[0].text).toContain('继续使用当前图片记录你的确认')
      expect(response.result.content[0].text).toContain('无需重新连接工作区或重复上传')
      expect(JSON.stringify(response.result)).not.toContain('internal parser detail')
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('does not claim parse persistence when the API did not bind the same asset', async () => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume request */ }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: {
        code: 'ASSET_PARSE_FAILED',
        message: 'parser failed',
        details: { asset_id: 'asset_other', asset_persisted: true, retryable: true },
      } }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'asset.parse', arguments: { asset_id: 'asset_requested' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(true)
      expect(response.result.structuredContent.asset_persisted).toBeUndefined()
      expect(response.result.structuredContent.conversation_state).toBeUndefined()
      expect(response.result.structuredContent.next_action).toBeUndefined()
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('preserves an explicit content generation idempotency key', async () => {
    const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: any }> = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { job_id: 'job_1' } }, error: null }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content.generate', arguments: { task_id: 'task_1', idempotency_key: 'generation-retry-1' } } })}\n`)
      await nextLine(child.stdout)
      expect(requests[0]!.headers['idempotency-key']).toBe('generation-retry-1')
    } finally {
      child.kill()
      server.close()
      await once(server, 'close').catch(() => undefined)
    }
  })

  it('renders merchant-visible detail decision summaries without changing structured content', async () => {
    const internalHash = `sha256:${'a'.repeat(64)}`
    const module = (title: string, buyerQuestion: string, body: string, status: 'verified' | 'missing' | 'conflict' | 'expired', optional: boolean) => ({
      key: title,
      title,
      purpose: `解决${buyerQuestion}`,
      body,
      factSourceIds: [internalHash],
      decisionContract: {
        buyerQuestion,
        pageTask: `回答${buyerQuestion}`,
        claim: { text: body, factSourceIds: [internalHash], platforms: ['taobao'], limitations: [] },
        evidence: { type: 'parameter', sourceIds: status === 'missing' ? [] : [internalHash], status },
        visualContract: { requiredElements: [], protectedElements: [], prohibitedImplications: [], accessibilityText: body },
        priority: 1,
        optional,
      },
    })
    const generated = {
      id: 'content_internal_123456',
      revision: 19,
      body: {
        title: '轻量无氟钛炒锅',
        detail: '按买家问题组织的详情正文。',
        sellingPoints: ['更轻便', '多炉具适配'],
        modules: [
          module('购买理由', '为什么值得继续看？', '一个主购买理由。', 'verified', false),
          module('材料安全', '材料是否安心？', '这段可选缺失正文不应出现。', 'missing', true),
          module('功能结果', '少油不粘是否有证据？', '未证明的功能正文不应出现。', 'missing', false),
          module('规格选择', '哪个规格适合我？', '冲突的规格正文不应出现。', 'conflict', true),
          module('适配说明', '我家炉具能用吗？', '过期的适配正文不应出现。', 'expired', false),
        ],
      },
    }
    const older = {
      ...generated,
      id: 'content_internal_older',
      revision: 18,
      body: { ...generated.body, title: '轻量无氟钛炒锅旧版' },
    }
    const results = [generated, [older, generated]]
    let calls = 0
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume request */ }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: results[calls++] } }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content.generate', arguments: { task_id: 'task_1' } } })}\n`)
      const generatedResponse = await nextLine(child.stdout)
      const generatedText = generatedResponse.result.content[0].text
      expect(generatedResponse.result.structuredContent).toEqual(generated)
      expect(generatedText).toContain('标题：轻量无氟钛炒锅')
      expect(generatedText).toContain('核心卖点：\n- 更轻便\n- 多炉具适配')
      expect(generatedText).toContain('买家问题：为什么值得继续看？\n正文：一个主购买理由。')
      expect(generatedText).not.toContain('材料安全')
      expect(generatedText).not.toContain('这段可选缺失正文不应出现')
      expect(generatedText).toContain('功能结果（已阻断）')
      expect(generatedText).toContain('阻断原因：缺少可验证证据')
      expect(generatedText).toContain('规格选择（已阻断）')
      expect(generatedText).toContain('宣称与当前证据存在冲突')
      expect(generatedText).toContain('适配说明（已阻断）')
      expect(generatedText).toContain('宣称证据已过期')
      expect(generatedText).not.toMatch(/content_internal|decisionContract|sha256:|a{64}|revision/iu)
      expect(generatedText.indexOf('购买理由')).toBeLessThan(generatedText.indexOf('功能结果'))
      expect(generatedText.indexOf('功能结果')).toBeLessThan(generatedText.indexOf('规格选择'))

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'content.versions', arguments: { task_id: 'task_1' } } })}\n`)
      const versionsResponse = await nextLine(child.stdout)
      const versionsText = versionsResponse.result.content[0].text
      expect(versionsResponse.result.structuredContent).toEqual([older, generated])
      expect(versionsText).toContain('第 1 版\n标题：轻量无氟钛炒锅旧版')
      expect(versionsText).toContain('第 2 版\n标题：轻量无氟钛炒锅')
      expect(versionsText).not.toMatch(/content_internal|decisionContract|sha256:|a{64}|revision/iu)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('returns generated data URI images as MCP image content', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { images: ['data:image/svg+xml;base64,PHN2Zy8+'] } }, error: null }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'catalog.image.generate', arguments: { product_id: 'product_1' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.content).toEqual(expect.arrayContaining([{ type: 'image', data: 'PHN2Zy8+', mimeType: 'image/svg+xml' }]))
      expect(response.result.content.find((item: { type: string }) => item.type === 'text').text).toBe('操作已完成。\n已生成 1 个图片附件。')
      expect(response.result.content.find((item: { type: string }) => item.type === 'text').text).not.toContain('PHN2Zy8+')
      expect(response.result.structuredContent.images).toEqual(['data:image/svg+xml;base64,PHN2Zy8+'])
    } finally {
      child.kill()
      server.close()
      await once(server, 'close').catch(() => undefined)
    }
  })

  it('materializes content exports as private MCP file resources without returning body or base64 to the model', async () => {
    const zipBytes = await new JSZip().file('manifest.json', '{"version":2}').generateAsync({ type: 'nodebuffer' })
    let calls = 0
    const server = createServer(async (_req, res) => {
      calls += 1
      res.setHeader('content-type', 'application/json')
      const result = calls === 1
        ? { fileName: '../../unsafe.zip', contentType: 'application/zip', body: '', binary_base64: zipBytes.toString('base64') }
        : { fileName: 'content.md', contentType: 'text/markdown; charset=utf-8', body: '# 安全导出\n正文' }
      res.end(JSON.stringify({ data: { result }, error: null }))
    })
    const address = await listen(server)
    const directory = await mkdtemp(join(tmpdir(), 'merchant-export-'))
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_ARTIFACT_DIR: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content.export', arguments: { deliverable_ref: 'dlv_safe', format: 'bundle' } } })}\n`)
      const zipResponse = await nextLine(child.stdout)
      const zipLink = zipResponse.result.content.find((item: { type: string }) => item.type === 'resource_link')
      expect(zipResponse.result.isError).toBe(false)
      expect(zipLink).toMatchObject({ type: 'resource_link', mimeType: 'application/zip', size: zipBytes.length })
      expect(zipLink.name).toMatch(/^merchant-content-export-[a-f0-9-]{36}\.zip$/u)
      expect(await readFile(fileURLToPath(zipLink.uri))).toEqual(zipBytes)
      expect(await JSZip.loadAsync(await readFile(fileURLToPath(zipLink.uri)))).toBeDefined()
      expect((await stat(fileURLToPath(zipLink.uri))).mode & 0o777).toBe(0o600)
      expect((await stat(join(fileURLToPath(zipLink.uri), '..'))).mode & 0o777).toBe(0o700)
      expect(JSON.stringify(zipResponse.result)).not.toContain(zipBytes.toString('base64'))
      expect(JSON.stringify(zipResponse.result)).not.toContain('../../unsafe.zip')
      expect(zipResponse.result.structuredContent).not.toHaveProperty('body')
      expect(zipResponse.result.structuredContent).not.toHaveProperty('binary_base64')
      expect(zipResponse.result.structuredContent).not.toHaveProperty('artifactUri')
      expect(zipLink.annotations).toEqual({ audience: ['user'] })

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'content.export', arguments: { deliverable_ref: 'dlv_safe', format: 'markdown' } } })}\n`)
      const markdownResponse = await nextLine(child.stdout)
      const markdownLink = markdownResponse.result.content.find((item: { type: string }) => item.type === 'resource_link')
      expect(markdownLink).toMatchObject({ mimeType: 'text/markdown' })
      expect(await readFile(fileURLToPath(markdownLink.uri), 'utf8')).toBe('# 安全导出\n正文')
      expect(JSON.stringify(markdownResponse.result)).not.toContain('安全导出')
    } finally {
      child.kill()
      await close(server)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed for invalid export bytes without returning a resource link', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { fileName: 'bad.zip', contentType: 'application/zip', body: '', binary_base64: Buffer.from('not-a-zip').toString('base64') } }, error: null }))
    })
    const address = await listen(server)
    const directory = await mkdtemp(join(tmpdir(), 'merchant-invalid-export-'))
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_ARTIFACT_DIR: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content.export', arguments: { deliverable_ref: 'dlv_safe', format: 'bundle' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(true)
      expect(response.result.structuredContent).toMatchObject({ code: 'MCP_GATEWAY_ERROR', message: '导出文件校验失败（ZIP 文件签名无效），未返回文件。请重新生成导出。' })
      expect(response.result.content.some((item: { type: string }) => item.type === 'resource_link')).toBe(false)
      expect(JSON.stringify(response.result)).not.toContain(directory)
    } finally {
      child.kill()
      await close(server)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries transient local API readiness failures during Codex startup', async () => {
    let attempts = 0
    const server = createServer(async (_req, res) => {
      attempts += 1
      res.setHeader('content-type', 'application/json')
      if (attempts === 1) {
        res.statusCode = 503
        res.end(JSON.stringify({ error: { code: 'API_STARTING', message: 'starting' } }))
        return
      }
      res.end(JSON.stringify({ data: { result: { status: 'ok' } }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_MCP_RETRY_DELAY_MS: '50' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(false)
      expect(response.result._meta).toBeUndefined()
      expect(response.result.structuredContent).toEqual({
        conversation_state: { stage: 'connect_store', status: 'needs_input', connected_store_count: 0 },
        completed_summary: '当前还没有可用店铺。',
        question: '你想先连接哪个平台？',
        expected_input: { kind: 'platform_selection', accepts: ['natural_language'] },
      })
      expect(attempts).toBe(2)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('honors Retry-After when the local API returns a workspace rate limit', async () => {
    let attempts = 0
    const server = createServer(async (_req, res) => {
      attempts += 1
      res.setHeader('content-type', 'application/json')
      if (attempts === 1) {
        res.writeHead(429, { 'retry-after': '0.05' })
        res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down', details: { retry_after_seconds: 0.05 } } }))
        return
      }
      res.end(JSON.stringify({ data: { result: { status: 'ok' } }, error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_MCP_RETRY_DELAY_MS: '50' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(false)
      expect(response.result.structuredContent).toMatchObject({
        conversation_state: { stage: 'connect_store', status: 'needs_input', connected_store_count: 0 },
        question: '你想先连接哪个平台？',
      })
      expect(attempts).toBe(2)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('does not retry a non-idempotent write after an ambiguous gateway failure', async () => {
    let attempts = 0
    const server = createServer(async (_req, res) => {
      attempts += 1
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'API_UNAVAILABLE', message: 'write outcome is unknown' } }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_MCP_RETRY_ATTEMPTS: '5', MERCHANT_MCP_RETRY_DELAY_MS: '50' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content.approve', arguments: { content_version_id: 'version_1', expected_version: '1' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({ isError: true, structuredContent: { code: 'API_UNAVAILABLE' } })
      expect(response.result.content[0].text).toContain('请稍后重试')
      expect(response.result.content[0].text).not.toContain('write outcome is unknown')
      expect(attempts).toBe(1)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('preserves actionable gateway error codes and field-level details for Codex', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'BRAND_VISUAL_RULES_BLOCKED', message: '品牌视觉强规则未满足', details: { issues: [{ code: 'FONT_LICENSE_NOT_APPROVED', field: 'visualRules.fonts[0]', message: '字体授权未批准' }] } } }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], { cwd: process.cwd(), env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' }, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'creative.brief', arguments: { product_id: 'product_1', asset_type: 'banner' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({ isError: true, structuredContent: { code: 'BRAND_VISUAL_RULES_BLOCKED', details: { issues: [{ code: 'FONT_LICENSE_NOT_APPROVED', field: 'visualRules.fonts[0]' }] } } })
      expect(response.result.content[0].text).toBe('内容被品牌规则拦截（1 项）。请先修正标记的问题，再重试。')
      expect(response.result.content[0].text).not.toContain('FONT_LICENSE_NOT_APPROVED')
      expect(response.result.content[0].text).not.toContain('visualRules.fonts[0]')
    } finally {
      child.kill(); await close(server)
    }
  })

  it('serializes requests received on one Codex stdio session', async () => {
    const requests: string[] = []
    let active = 0
    let maxActive = 0
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number }
      requests.push(req.url ?? '')
      active += 1
      maxActive = Math.max(maxActive, active)
      const delay = body.id === 1 ? 25 : 0
      setTimeout(() => {
        active -= 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: { jsonrpc: '2.0', id: body.id, result: {} } }))
      }, delay)
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: { query: 'first' } } })}\n`)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace.health', arguments: { query: 'second' } } })}\n`)
      await nextLine(child.stdout)
      await nextLine(child.stdout)
      expect(requests).toEqual(['/mcp', '/mcp'])
      expect(maxActive).toBe(1)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('fails closed when Codex leaves endpoint or workspace placeholders unresolved', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'merchant-codex-home-'))
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        MERCHANT_MCP_BASE_URL: '${MERCHANT_MCP_BASE_URL}',
        MERCHANT_WORKSPACE_ID: '${MERCHANT_WORKSPACE_ID}',
        MERCHANT_ALLOW_FIXTURE_FALLBACK: '${MERCHANT_ALLOW_FIXTURE_FALLBACK}',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({ isError: true, structuredContent: { code: 'MCP_GATEWAY_ERROR' } })
      expect(response.result.structuredContent.message).toMatch(/MERCHANT_(?:MCP_BASE_URL|WORKSPACE_ID) is required/u)
      expect(response.result.structuredContent.message).toContain('refusing to use the local fixture fallback')
    } finally {
      child.kill()
    }
  })

  it.each([
    'https://merchant.example.test/mcp',
    'https://user:secret@merchant.example.test',
    'https://merchant.example.test?tenant=ops',
    'https://merchant.example.test#fragment',
  ])('rejects a non-origin MERCHANT_MCP_BASE_URL before sending traffic: %s', async endpoint => {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: endpoint, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({ isError: true, structuredContent: { code: 'MCP_GATEWAY_ERROR' } })
      expect(response.result.structuredContent.message).toContain('服务暂时不可用')
      expect(response.result.structuredContent.message).not.toContain(endpoint)
    } finally {
      child.kill()
    }
  })

  it('keeps the bootstrapped workspace for the next first-run call in the same process', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'merchant-codex-home-'))
    const requests: Array<{ method?: string; workspace?: string; header?: string }> = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push({ method: body.method, workspace: body.params?.workspace_id, header: req.headers['x-workspace-id'] as string | undefined })
      res.setHeader('content-type', 'application/json')
      const result = body.method === 'workspace.bootstrap' ? { workspaceId: 'ws_bootstrapped_1', status: 'active' } : { workspace: { id: 'ws_bootstrapped_1', status: 'ready' } }
      res.end(JSON.stringify({ data: { jsonrpc: '2.0', id: body.id, result }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: codexHome, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: '${MERCHANT_WORKSPACE_ID}', MERCHANT_ALLOW_FIXTURE_FALLBACK: '${MERCHANT_ALLOW_FIXTURE_FALLBACK}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.bootstrap', arguments: { display_name: '首次工作区' } } })}\n`)
      expect((await nextLine(child.stdout)).result.structuredContent).toMatchObject({ workspaceId: 'ws_bootstrapped_1' })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      expect((await nextLine(child.stdout)).result.structuredContent).toEqual({
        conversation_state: { stage: 'connect_store', status: 'needs_input', connected_store_count: 0 },
        completed_summary: '当前还没有可用店铺。',
        question: '你想先连接哪个平台？',
        expected_input: { kind: 'platform_selection', accepts: ['natural_language'] },
      })
      expect(requests).toEqual([
        { method: 'workspace.bootstrap', workspace: undefined, header: undefined },
        { method: 'workspace.health', workspace: 'ws_bootstrapped_1', header: 'ws_bootstrapped_1' },
      ])
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('automatically bootstraps before the merchant-facing start entry when no workspace is bound', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'merchant-codex-home-'))
    const requests: string[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push(body.method)
      res.setHeader('content-type', 'application/json')
      const result = body.method === 'workspace.bootstrap'
        ? { workspaceId: 'ws_auto_start_1', status: 'active' }
        : { greeting: '欢迎使用大麦。', workspace: { id: 'ws_auto_start_1', status: 'ready' } }
      res.end(JSON.stringify({ data: { jsonrpc: '2.0', id: body.id, result }, warnings: [], next_actions: [], error: null }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: codexHome, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: '${MERCHANT_WORKSPACE_ID}', MERCHANT_ALLOW_FIXTURE_FALLBACK: '${MERCHANT_ALLOW_FIXTURE_FALLBACK}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merchant.start', arguments: {} } })}\n`)
      expect((await nextLine(child.stdout)).result.structuredContent).toEqual({
        conversation_state: { stage: 'start', status: 'needs_input' },
        completed_summary: '欢迎使用大麦。',
        question: '你想先完成什么营销任务？',
        expected_input: { kind: 'task_goal', accepts: ['natural_language'] },
      })
      expect(requests).toEqual(['workspace.bootstrap', 'merchant.start'])
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('allows ws_demo fallback only after explicit local fixture opt-in', async () => {
    const requests: Array<{ url?: string; workspace?: string }> = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push({ url: req.url, workspace: body.params?.workspace_id })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { jsonrpc: '2.0', id: body.id, result: { ok: true } } }))
    })
    const address = await listen(server)
    const codexHome = await mkdtemp(join(tmpdir(), 'merchant-codex-home-'))
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
        MERCHANT_WORKSPACE_ID: '${MERCHANT_WORKSPACE_ID}',
        MERCHANT_ALLOW_FIXTURE_FALLBACK: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      expect((await nextLine(child.stdout)).result.isError).toBe(false)
      expect(requests).toEqual([{ url: '/mcp', workspace: 'ws_demo' }])
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('fails closed before contacting a remote staging endpoint without HTTPS, token, or strict auth', async () => {
    let requests = 0
    const server = createServer((_req, res) => { requests += 1; res.writeHead(200).end('{}') })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'staging', MERCHANT_MCP_BASE_URL: `http://example.test:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_TOKEN: '${MERCHANT_MCP_TOKEN}', MERCHANT_STRICT_AUTH: '${MERCHANT_STRICT_AUTH}', MERCHANT_ALLOW_FIXTURE_FALLBACK: '${MERCHANT_ALLOW_FIXTURE_FALLBACK}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({ isError: true, structuredContent: { code: 'MCP_HTTPS_REQUIRED' } })
      expect(requests).toBe(0)
    } finally {
      child.kill()
      await close(server)
    }
  })

  it('blocks production generation results that omit relay evidence', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { jsonrpc: '2.0', id: 1, result: { execution: { simulated: false, providerExecuted: false }, content: { title: '不应交付' } } } }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'staging', MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_ALLOW_FIXTURE_FALLBACK: '${MERCHANT_ALLOW_FIXTURE_FALLBACK}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' } } })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { enabled: true } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'content.generate', arguments: { task_id: 'task_1', confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({ isError: true, structuredContent: { code: 'MODEL_RELAY_EVIDENCE_REQUIRED' } })
      expect(response.result.content[0].text).toContain('平台正在核对本次生成记录')
      expect(response.result.content[0].text).toContain('没有生成新内容、扣费或发布')
    } finally {
      child.kill()
      await close(server)
    }
  })
})
