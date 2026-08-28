import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { MCP_METHODS } from '../../../packages/contracts/src/mcp.js'

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
])

function nextLine(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      stream.off('data', onData)
      resolve(JSON.parse(buffer.slice(0, newline)))
    }
    stream.on('data', onData)
    stream.once('error', reject)
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'asset.facts.confirm', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' } })
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      for (const [index, name] of ['platform.connect', 'billing.recharge.create', 'catalog.sync', 'catalog.sync.start'].entries()) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: {} } })}\n`)
        expect((await nextLine(child.stdout)).result).toMatchObject({ isError: false, structuredContent: { accepted: true } })
      }
      expect(requests).toBe(4)
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
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

  it('returns standardized action cards in structuredContent while preserving legacy fields', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        data: { jsonrpc: '2.0', id: 1, result: {
          status: 'needs_input',
          next_actions: ['请先选择套餐'],
          action_cards: [{
            method: 'subscription.change',
            label: '升级套餐',
            description: '当前店铺额度不足',
            confirmation: 'interactive_confirmation',
          }],
        } },
        warnings: [],
        next_actions: ['请先选择套餐'],
        error: null,
      }))
    })
    const address = await listen(server)
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'billing.status', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      const card = response.result.structuredContent.action_cards[0]
      expect(response.result.structuredContent).toMatchObject({ status: 'needs_input', next_actions: ['请先选择套餐'] })
      expect(card).toMatchObject({
        id: 'billing-status-1',
        type: 'upgrade',
        tool: 'subscription.change',
        arguments: {},
        required_inputs: [],
        enabled: true,
        reason: '当前店铺额度不足',
        requires_confirmation: true,
      })
      expect(JSON.parse(response.result.content[0].text).action_cards[0]).toEqual(card)
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
      expect((await nextLine(child.stdout)).result.capabilities.tools).toEqual({})
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'resources/list' })}\n`)
      const resources = await nextLine(child.stdout)
      expect(resources.result.resources).toContainEqual(expect.objectContaining({ uri: 'ui://merchant-marketing/recharge-v1.html', mimeType: 'text/html;profile=mcp-app' }))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'ui://merchant-marketing/recharge-v1.html' } })}\n`)
      const rechargeUi = await nextLine(child.stdout)
      expect(rechargeUi.result.contents[0]).toMatchObject({ uri: 'ui://merchant-marketing/recharge-v1.html', mimeType: 'text/html;profile=mcp-app' })
      expect(rechargeUi.result.contents[0].text).toContain('额度不足，需要充值')
      expect(rechargeUi.result.contents[0].text).toContain('确认支付')
      expect(rechargeUi.result.contents[0].text).toContain('立即充值')
      expect(rechargeUi.result.contents[0].text).toContain("callTool('billing.status',{})")
      expect(rechargeUi.result.contents[0].text).not.toMatch(/mock/iu)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
      const listed = await nextLine(child.stdout)
      expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(MCP_METHODS.filter(method => !method.startsWith('ops.') && !MERCHANT_HIDDEN_METHODS.has(method)).sort())
      expect(listed.result.tools.some((tool: { name: string }) => tool.name.startsWith('ops.'))).toBe(false)
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
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'merchant.start')._meta).toMatchObject({ ui: { resourceUri: 'ui://merchant-marketing/context-v1.html' }, 'openai/outputTemplate': 'ui://merchant-marketing/context-v1.html' })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'catalog.search')._meta).toMatchObject({ ui: { resourceUri: 'ui://merchant-marketing/context-v1.html' } })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'task.group.create').description).toMatch(/批量生成入口/u)
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'deliverable.list').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'content.export').annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'billing.status')._meta.ui.resourceUri).toBe('ui://merchant-marketing/recharge-v1.html')
      const rechargeGet = listed.result.tools.find((tool: { name: string }) => tool.name === 'billing.recharge.get')
      expect(rechargeGet.inputSchema.properties).toEqual({ order_id: { type: 'string' } })
      expect(rechargeGet.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'content.generate')._meta.ui.resourceUri).toBe('ui://merchant-marketing/recharge-v1.html')
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
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'brand-unit.bind-store').inputSchema.required).toEqual(['brand_id', 'platform', 'account_id'])
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'knowledge.competitor.reference').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'knowledge.rule.create').inputSchema.properties.source_kind.enum).toEqual(['official', 'internal', 'merchant', 'observed', 'legal_review'])
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'multimodal.video.request').inputSchema.properties.idempotency_key).toBeDefined()
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === 'publish.confirm').annotations).toBeUndefined()
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
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

  it('publishes merchant context and batch-list metadata without inventing a business unit', async () => {
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://merchant-marketing/context-v1.html' } })}\n`)
      expect((await nextLine(child.stdout)).result.contents[0].text).toContain('工作区')
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'catalog.search', arguments: { scope: 'store', platform: 'taobao', account_id: 'acct_1' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.structuredContent.ui).toMatchObject({
        surface: 'merchant_codex_app',
        data_status: 'real_or_server_reported',
        context_bar: { order: ['workspace', 'business_unit', 'platform', 'store'], reset_on_change: { business_unit: ['platform', 'account_id', 'product_id', 'selected_product_ids'] } },
        list: { kind: 'products', selection: 'multi', selection_key: 'product_id', batch_actions: [{ tool: 'task.group.create', enabled: false }, { tool: 'publish.batch.prepare', enabled: false }] },
      })
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content.generate', arguments: { task_id: 'task_1' } } })}\n`)
      await nextLine(child.stdout)
      expect(requests[0]!.headers['idempotency-key']).toMatch(/^mcp-[a-f0-9]{64}$/)
      expect(requests[0]!.headers['idempotency-key']).toBeDefined()
    } finally {
      child.kill()
      server.close()
      await once(server, 'close').catch(() => undefined)
    }
  })

  it('uploads an attached local file without putting base64 in the model tool arguments', async () => {
    const requests: any[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { id: 'asset_local_1', scanStatus: 'quarantined' } }, error: null }))
    })
    const address = await listen(server)
    const directory = await mkdtemp(join(tmpdir(), 'merchant-local-upload-'))
    const filePath = join(directory, 'product.png')
    const bytes = Buffer.from('local-product-image-bytes')
    await writeFile(filePath, bytes)
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
      const listed = await nextLine(child.stdout)
      const upload = listed.result.tools.find((tool: { name: string }) => tool.name === 'asset.upload')
      expect(upload.inputSchema.properties.file_path).toBeDefined()
      expect(upload.inputSchema.required).toEqual(['name', 'mime_type'])
      for (const toolName of ['asset.upload', 'task.create']) {
        const tool = listed.result.tools.find((item: { name: string }) => item.name === toolName)
        expect(tool).toBeDefined()
        for (const forbidden of ['ai_base_url', 'ai_api_key', 'ai_model', 'image_base_url', 'image_api_key', 'image_model', 'endpoint', 'api_key', 'model']) {
          expect(tool.inputSchema.properties).not.toHaveProperty(forbidden)
        }
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'asset.upload', arguments: { name: 'product.png', mime_type: 'image/png', file_path: filePath } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(false)
      expect(requests[0].params).toMatchObject({ name: 'product.png', mime_type: 'image/png', content_base64: bytes.toString('base64') })
      expect(requests[0].params.file_path).toBeUndefined()
      expect(requests[0].params.sha256).toMatch(/^[a-f0-9]{64}$/u)
    } finally {
      child.kill()
      await close(server)
      await rm(directory, { recursive: true, force: true })
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
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

  it('returns generated data URI images as MCP image content', async () => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { result: { images: ['data:image/svg+xml;base64,PHN2Zy8+'] } }, error: null }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'catalog.image.generate', arguments: { product_id: 'product_1' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.content).toEqual(expect.arrayContaining([{ type: 'image', data: 'PHN2Zy8+', mimeType: 'image/svg+xml' }]))
      expect(response.result.content.find((item: { type: string }) => item.type === 'text').text).toContain('[image attachment 1]')
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_ARTIFACT_DIR: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content.export', arguments: { deliverable_ref: 'dlv_safe', format: 'bundle' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(true)
      expect(response.result.structuredContent).toMatchObject({ code: 'MCP_GATEWAY_ERROR', message: 'content.export ZIP 文件签名无效' })
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_MCP_RETRY_DELAY_MS: '50' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(false)
      expect(response.result.structuredContent).toMatchObject({ status: 'ok', ui: { surface: 'merchant_codex_app' } })
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_MCP_RETRY_DELAY_MS: '50' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result.isError).toBe(false)
      expect(response.result.structuredContent).toMatchObject({ status: 'ok', ui: { surface: 'merchant_codex_app' } })
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_WRITE_ENABLED: 'true', MERCHANT_MCP_RETRY_ATTEMPTS: '5', MERCHANT_MCP_RETRY_DELAY_MS: '50' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content.approve', arguments: { content_version_id: 'version_1', expected_version: '1' } } })}\n`)
      const response = await nextLine(child.stdout)
      expect(response.result).toMatchObject({ isError: true, structuredContent: { code: 'API_UNAVAILABLE' } })
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
      expect(JSON.parse(response.result.content[0].text)).toMatchObject({ code: 'BRAND_VISUAL_RULES_BLOCKED' })
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
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
      expect(response.result.structuredContent.message).toContain('refusing to use ws_demo')
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: codexHome, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: '${MERCHANT_WORKSPACE_ID}', MERCHANT_ALLOW_FIXTURE_FALLBACK: '${MERCHANT_ALLOW_FIXTURE_FALLBACK}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.bootstrap', arguments: { display_name: '首次工作区' } } })}\n`)
      expect((await nextLine(child.stdout)).result.structuredContent).toMatchObject({ workspaceId: 'ws_bootstrapped_1' })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      expect((await nextLine(child.stdout)).result.structuredContent).toMatchObject({ workspace: { id: 'ws_bootstrapped_1' } })
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: codexHome, MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: '${MERCHANT_WORKSPACE_ID}', MERCHANT_ALLOW_FIXTURE_FALLBACK: '${MERCHANT_ALLOW_FIXTURE_FALLBACK}' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merchant.start', arguments: {} } })}\n`)
      expect((await nextLine(child.stdout)).result.structuredContent).toMatchObject({ greeting: '欢迎使用大麦。', workspace: { id: 'ws_auto_start_1' } })
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
    const child = spawn(process.execPath, ['apps/plugin/mcp/bridge.mjs'], {
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
})
