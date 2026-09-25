import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'

type Json = Record<string, unknown>

const json = (value: Json) => JSON.stringify(value)
// Keep the transport harness independent from release-suite environment.
// Restricted-environment behavior is covered by bridge.test.ts explicitly.
const TEST_PROCESS_ENV = { ...process.env, NODE_ENV: 'test', DEPLOY_ENV: '${DEPLOY_ENV}' }

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
    // Keep host launchd credentials out of this local transport harness. An
    // unset token is otherwise recovered from macOS launchd by the bridge,
    // turning local confirmation into an extra remote MCP request.
    env: {
      ...TEST_PROCESS_ENV,
      MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
      MERCHANT_WORKSPACE_ID: 'ws_test',
      MERCHANT_MCP_TOKEN: '${MERCHANT_MCP_TOKEN}',
      MERCHANT_ALLOW_FIXTURE_FALLBACK: 'true',
      MERCHANT_STRICT_AUTH: '${MERCHANT_STRICT_AUTH}',
      MERCHANT_MCP_WRITE_ENABLED: '${MERCHANT_MCP_WRITE_ENABLED}',
    },
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

function expectContentProductionIntroduction(content: string) {
  expect(content).toContain('内容生产 → 审核 → 导出')
  expect(content).toContain('不必先连接店铺')
  expect(content).toContain('公开链接只是来源线索')
  expect(content).toContain('草稿不能冒充正式内容版本')
  expect(content).toContain('你想制作什么内容？可以提供公开商品链接、商品资料或图片。')
  expect(content).not.toMatch(/当前进度：\d\/4|连接平台及店铺|扫描商品至知识库|检查系统配置|建立工作区/u)
  expect(content).not.toContain('平台｜店铺名称｜店铺首页链接')
  expect(content).not.toContain('生产环境已准备完毕')
  expect(content).not.toContain('店铺连接成功')
}

describe('Codex App merchant conversation flow', () => {
  it('returns shop-link candidates for confirmation without claiming a store connection', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, {
        store_link_inspection: {
          candidates: [{ platformLabel: '淘宝', storeName: '云朵女装店', shopUrl: 'https://shop.taobao.com/1', authorizationState: 'not_checked' }],
          issues: [], requiresUserConfirmation: true,
        },
        initialization: { completed: 0, total: 4, status: 'in_progress', steps: [] },
      })))
    }, async (child, calls) => {
      const response = await request(child, 1, 'onboarding.status', { store_links_text: '淘宝｜云朵女装店｜https://shop.taobao.com/1' })
      const content = (response.result as { content: Array<{ text: string }> }).content[0]?.text ?? ''
      expect(content).toContain('云朵女装店')
      expect(content).toContain('身份和授权仍待核验')
      expect(content).not.toContain('店铺连接成功')
      expect(calls).toMatchObject([{ method: 'onboarding.status', params: { store_links_text: '淘宝｜云朵女装店｜https://shop.taobao.com/1' } }])
    })
  })

  it('welcomes first-time users with content production while preserving server initialization evidence', async () => {
    const initialization = {
      completed: 0, total: 4, status: 'in_progress',
      current_step: { id: 'connect_stores', title: '连接平台及店铺', summary: '尚无官方授权店铺', next_action: { label: '开始配置店铺' } },
      steps: [
        { id: 'connect_stores', title: '连接平台及店铺', state: 'required', summary: '尚无官方授权店铺' },
        { id: 'scan_catalog', title: '扫描商品至知识库', state: 'pending', summary: '等待官方授权' },
        { id: 'check_configuration', title: '检查系统配置', state: 'pending', summary: '等待扫描' },
        { id: 'build_workspace', title: '建立工作区', state: 'pending', summary: '等待配置' },
      ],
      security_notice: '不要发送密码或验证码',
    }
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, { initialization })))
    }, async (child, calls) => {
      const response = await request(child, 1, 'onboarding.status')
      const result = response.result as { content: Array<{ text: string }>; structuredContent: Json }
      const content = result.content[0]?.text ?? ''
      expect(content).toContain('您好，感谢您使用 Store Nova')
      expectContentProductionIntroduction(content)
      expect(content).toContain('有效登录、当前工作区权限、服务端准入')
      expect(content).toContain('真实模型配置、创意点和成本证据')
      expect(result.structuredContent.initialization).toEqual(initialization)
      expect(result.structuredContent).not.toHaveProperty('onboarding_card')
      expect(calls.map(call => call.method)).toEqual(['onboarding.status'])
    })
  })

  it('preserves compatibility evidence without presenting legacy store progress as the content workflow', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, {
        status: 'in_progress',
        current_step: { id: 'choose_product', title: '选择商品' },
        steps: [{ title: '工作区', state: 'complete', summary: '已建立' }, { title: '连接店铺', state: 'complete', summary: '已绑定' }],
        onboarding: { currentStep: 'choose_product' },
        evidence: { official_stores: 1 },
      })))
    }, async child => {
      const response = await request(child, 1, 'onboarding.status')
      const result = response.result as Json
      const content = (result.content as Array<{ text: string }>)[0]?.text ?? ''
      expectContentProductionIntroduction(content)
      expect(content).not.toContain('正在升级')
      expect(result.structuredContent).toMatchObject({
        status: 'in_progress',
        initialization: { completed: 1, total: 4, evidence: { compatibility_projection: true } },
      })
      expect(result.structuredContent).not.toHaveProperty('onboarding_card')
    })
  })

  it('does not invent official store evidence while allowing the content-first introduction', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, {
        status: 'in_progress',
        steps: [{ title: '工作区', state: 'complete' }, { title: '连接店铺', state: 'complete' }],
        onboarding: { currentStep: 'choose_product' },
      })))
    }, async child => {
      const response = await request(child, 1, 'onboarding.status')
      const result = response.result as Json
      const content = (result.content as Array<{ text: string }>)[0]?.text ?? ''
      expectContentProductionIntroduction(content)
      expect(content).not.toContain('进行第二步')
      expect(result.structuredContent).toMatchObject({ initialization: { completed: 0, current_step: { id: 'connect_stores', state: 'required' } } })
    })
  })

  it('introduces content production when a legacy server only returns a greeting', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, { status: 'in_progress', greeting: '欢迎回来' })))
    }, async child => {
      const response = await request(child, 1, 'onboarding.status')
      const result = response.result as Json
      const content = (result.content as Array<{ text: string }>)[0]?.text ?? ''
      expectContentProductionIntroduction(content)
      expect(content).not.toContain('升级')
      expect(result.structuredContent).toMatchObject({ status: 'in_progress', initialization: { completed: 0, total: 4 } })
    })
  })

  it('preserves completed historical setup without claiming content is generated, reviewed or exported', async () => {
    const initialization = {
      completed: 4, total: 4, status: 'ready',
      current_step: { id: 'build_workspace', title: '建立工作区', state: 'complete' },
      steps: ['连接平台及店铺', '扫描商品至知识库', '检查系统配置', '建立工作区'].map((title, index) => ({ id: `step-${index}`, title, state: 'complete' })),
      security_notice: '不要发送密码或验证码',
    }
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, { initialization })))
    }, async child => {
      const response = await request(child, 1, 'onboarding.status')
      const result = response.result as { content: Array<{ text: string }>; structuredContent: Json }
      const content = result.content[0]?.text ?? ''
      expectContentProductionIntroduction(content)
      expect(content).toContain('不代表本次内容已生成、审核或导出')
      expect(content).not.toContain('服务端已确认四步接入配置完成')
      expect(result.structuredContent.initialization).toEqual(initialization)
    })
  })

  it('keeps legacy brand clues as evidence without diverting the content question into brand confirmation', async () => {
    const initialization = {
      completed: 2, total: 4, status: 'in_progress',
      current_step: { id: 'check_configuration', title: '检查系统配置', state: 'required' },
      steps: [{ id: 'check_configuration', title: '检查系统配置', state: 'required' }],
      evidence: { brand_profile_present: false },
      brand_clues: { totalCandidates: 1, candidates: [{ brandName: '历史品牌线索' }] },
    }
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, { initialization })))
    }, async child => {
      const response = await request(child, 1, 'onboarding.status')
      const result = response.result as { content: Array<{ text: string }>; structuredContent: Json }
      const content = result.content[0]?.text ?? ''
      expectContentProductionIntroduction(content)
      expect(content).not.toContain('历史品牌线索')
      expect(content).not.toContain('请确认这是否是你要使用的品牌名称')
      expect(result.structuredContent.initialization).toEqual(initialization)
    })
  })

  it('starts onboarding with one conversational question and removes dashboard-shaped fields', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, {
        greeting: '欢迎使用Store Nova',
        onboarding: { currentStep: 'connect_store', steps: ['connect_store', 'choose_product', 'add_assets', 'start_task'] },
        next_actions: [{ label: '选择平台和店铺', tool: 'platform.connect', required_inputs: ['platform'] }],
        action_cards: [{ method: 'platform.connect', label: '连接淘宝', description: '先绑定一家店铺' }],
      })))
    }, async (child, calls) => {
      const response = await request(child, 1, 'merchant.start')
      const result = response.result as Json
      expect(result.isError).toBe(false)
      expect(result.structuredContent).toEqual({
        conversation_state: { stage: 'provide_materials', status: 'needs_input' },
        completed_summary: '欢迎使用Store Nova',
        question: '你想制作什么内容？可以提供公开商品链接、商品资料或图片。',
        expected_input: { kind: 'product_materials', accepts: ['natural_language', 'public_url', 'attachment'] },
      })
      expect(JSON.stringify(result.structuredContent)).not.toMatch(/dashboard|capabilityCards|context_bar|action_cards|platform\.connect/u)
      expect(calls.map(call => call.method)).toEqual(['merchant.start'])
    })
  })

  it('adapts a legacy server connection prerequisite to material input without exposing the hidden action', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, {
        currentStep: { id: 'choose-product', state: 'required' },
        onboarding_v2: { current_step: { id: 'connect_store', title: '连接店铺', state: 'required', primary_action: { method: 'platform.connect', label: '连接平台店铺', required_inputs: ['platform'] } } },
        action_cards: [{ method: 'catalog.search', label: '选择商品', enabled: true }],
      })))
    }, async (child) => {
      const response = await request(child, 1, 'merchant.start')
      const result = response.result as { structuredContent: Json }
      expect(result).toMatchObject({
        structuredContent: {
          conversation_state: { stage: 'provide_materials', status: 'needs_input' },
          question: '你想制作什么内容？可以提供公开商品链接、商品资料或图片。',
          expected_input: { kind: 'product_materials', accepts: ['natural_language', 'public_url', 'attachment'] },
        },
      })
      expect(result.structuredContent.conversation_state).not.toHaveProperty('primary_action')
      expect(JSON.stringify(result.structuredContent)).not.toContain('platform.connect')
    })
  })

  it('keeps repeated merchant.start calls available in the same ChatGPT conversation', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, {
        currentStep: { id: 'connect-store', state: 'required' },
        action_cards: [{ method: 'platform.connect', label: '连接店铺' }],
      })))
    }, async (child, calls) => {
      const first = await request(child, 1, 'merchant.start', { requested_goal: '查看店铺' })
      const second = await request(child, 2, 'merchant.start', { requested_goal: '查看店铺' })
      expect(first.result).toMatchObject({ isError: false, structuredContent: { conversation_state: { stage: expect.any(String) } } })
      expect(second.result).toMatchObject({ isError: false, structuredContent: { conversation_state: { stage: expect.any(String) } } })
      expect(calls.map(call => call.method)).toEqual(['merchant.start', 'merchant.start'])
    })
  })

  it('rejects disabled Codex-host content preparation before older downstream blockers can be reached', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, { enabled: true })))
    }, async (child, calls) => {
      expect((await request(child, 1, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })).result).toMatchObject({ isError: false })
      const response = await request(child, 2, 'content.codex.prepare', { task_id: 'task_1' })
      expect(response.error).toMatchObject({ code: -32602 })
      expect(JSON.stringify(response)).not.toContain('success')
      expect(calls).toEqual([])
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

  // issue 1: the schema declares a wire-level integer string. A caller that
  // follows the schema ("1") used to lose the value; a JSON number 1 is kept as
  // the documented alias. Both must reach the same attachment projection.
  it.each([['the declared wire string', '1'], ['the documented number alias', 1]] as const)(
    'preserves a new conversation goal and completes automatic scanning in the same turn (%s)',
    async (_label, attachmentCount) => {
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
      const started = await request(child, 1, 'merchant.start', { requested_platform: 'jd', requested_goal: 'generate_white_background_image', attachment_count: attachmentCount })
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
    },
  )

  it('returns an existing successful deliverable as an actionable artifact card', async () => {
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, request.method === 'generation.get'
        ? { status: 'completed', deliverable: { title: '轻云防晒外套详情页', version: 'v3' }, action_cards: [{ method: 'content.export', label: '导出交付包', description: '可下载的内容交付物' }] }
        : { enabled: true })))
    }, async (child) => {
      await request(child, 1, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })
      const response = await request(child, 2, 'generation.get', { job_id: 'job_1' })
      const result = response.result as Json
      expect(result).toMatchObject({ isError: false, structuredContent: { status: 'completed', deliverable: { version: 'v3' } } })
      expect((result.structuredContent as Json).action_cards).toEqual([expect.objectContaining({ tool: 'content.export', label: '导出交付包', requires_confirmation: false })])
    })
  })

  it('hides out-of-scope store, synchronization and publishing tools even after interactive confirmation', async () => {
    const hiddenMethods = [
      'catalog.sync', 'catalog.sync.start', 'catalog.sync.get', 'sync.retry_failed',
      'automation.policy.get', 'automation.policy.list', 'automation.policy.update',
      'automation.scan', 'automation.tick', 'automation.pause',
      'publish.prepare', 'publish.confirm', 'publish.get', 'publish.manual.get', 'publish.manual.list',
      'publish.batch.prepare', 'publish.batch.confirm', 'publish.batch.get',
      'publish.batch.pause', 'publish.batch.resume', 'publish.batch.retry_failed',
      'platform.connect', 'platform.store.list', 'workspace.content_setup.confirm',
    ]
    await withBridge((request, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(json(ok(request, { accepted: true })))
    }, async (child, calls) => {
      child.stdin.write(`${json({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`)
      const listed = await nextLine(child.stdout)
      const names = ((listed.result as Json).tools as Array<{ name: string }>).map(tool => tool.name)
      expect(names).toEqual(expect.arrayContaining(['catalog.import', 'content.draft.generate', 'content.export']))
      expect(names.some(name => /^(?:catalog\.sync(?:\.|$)|automation\.|publish\.)/u.test(name))).toBe(false)
      for (const method of hiddenMethods) expect(names).not.toContain(method)

      const publishArgs = { idempotency_key: 'publish:task_1:v3', confirmation_hash: 'hash_1', remote_snapshot_hash: 'snapshot_1' }
      const blocked = await request(child, 2, 'publish.confirm', publishArgs)
      expect(blocked.error).toMatchObject({ code: -32602, message: 'Unknown tool: publish.confirm' })
      expect(calls).toEqual([])

      const confirmed = await request(child, 3, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })
      expect(confirmed.result).toMatchObject({ isError: false })
      for (const [index, method] of hiddenMethods.entries()) {
        const response = await request(child, index + 4, method, method === 'publish.confirm' ? publishArgs : {})
        expect(response.error).toMatchObject({ code: -32602, message: `Unknown tool: ${method}` })
        expect(response).not.toHaveProperty('result')
      }
      expect(calls).toEqual([])
    })
  })
})
