import { afterEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { server } from '../../api/src/server.js'

const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url))
let child: ChildProcessWithoutNullStreams | undefined

async function startApi() {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('API did not bind')
  return `http://127.0.0.1:${address.port}`
}

function nextLine(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      stream.off('data', onData)
      stream.off('error', reject)
      resolve(JSON.parse(buffer.slice(0, newline)))
    }
    stream.on('data', onData)
    stream.once('error', reject)
  })
}

afterEach(async () => {
  child?.kill()
  child = undefined
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('first-use plugin → API/MCP chain', () => {
  it('reads the actual four-step status through the current bridge without manufacturing an authorized store', async () => {
    const apiBase = await startApi()
    child = spawn(process.execPath, [bridgePath], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', DEPLOY_ENV: '${DEPLOY_ENV}', MERCHANT_MCP_BASE_URL: apiBase, MERCHANT_WORKSPACE_ID: `ws_first_use_chain_${Date.now()}`, MERCHANT_MCP_TOKEN: '', MERCHANT_STRICT_AUTH: 'false', MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })}\n`)
    const initialized = await nextLine(child.stdout)
    expect(initialized.result.instructions).toContain('draft_only="true"')
    expect(initialized.result.instructions).toContain('content.draft.generate')
    expect(initialized.result.instructions).toContain('内容生产 → 审核 → 导出')
    expect(initialized.result.instructions).toContain('不以店铺 OAuth 或历史四步接入进度作为默认前置')
    expect(initialized.result.instructions).toContain('不绕过权限、创意点或模型配置门禁')

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`)
    const listed = await nextLine(child.stdout)
    const tools = listed.result.tools.map((tool: { name: string }) => tool.name)
    expect(tools).toContain('onboarding.status')
    expect(tools).toContain('content.draft.generate')
    expect(tools).toContain('content.export')
    expect(tools).not.toContain('workspace.content_setup.confirm')
    expect(tools).not.toContain('platform.connect')
    expect(tools).not.toContain('platform.store.list')
    expect(tools.some((name: string) => name.startsWith('ops.'))).toBe(false)

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'onboarding.status', arguments: {} } })}\n`)
    const onboarding = await nextLine(child.stdout)
    expect(onboarding.result.isError, JSON.stringify(onboarding.result)).toBe(false)
    expect(onboarding.result.structuredContent.initialization).toMatchObject({ completed: 0, total: 4, current_step: { id: 'connect_stores', state: 'required' }, evidence: { official_stores: 0 } })
    expect(onboarding.result.content[0].text).toContain('您好，感谢您使用 Store Nova')
    expect(onboarding.result.content[0].text).not.toContain('本地系统已经部署完成')
    expect(onboarding.result.content[0].text).not.toContain('生产环境已准备完毕')
    expect(onboarding.result.content[0].text).toContain('内容生产 → 审核 → 导出')
    expect(onboarding.result.content[0].text).toContain('候选保持未批准、未发布')
    expect(onboarding.result.content[0].text).toContain('不必先连接店铺')
    expect(onboarding.result.content[0].text).toContain('不要发送 Cookie、平台密码或验证码')
    expect(onboarding.result.content[0].text).not.toContain('当前进度：0/4')
    expect(onboarding.result.content[0].text).toContain('公开链接只是来源线索')
    expect(onboarding.result).not.toHaveProperty('structuredContent.onboarding_card')

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'onboarding.status', arguments: { store_links_text: '淘宝｜云朵女装店｜https://shop.m.taobao.com/shop/shop_index.htm?shop_id=123&token=secret' } } })}\n`)
    const candidate = await nextLine(child.stdout)
    expect(candidate.result.isError).toBe(false)
    expect(candidate.result.structuredContent.store_link_inspection).toMatchObject({ candidates: [{ platform: 'taobao', storeName: '云朵女装店', authorizationState: 'not_checked' }] })
    expect(candidate.result.structuredContent.initialization.completed).toBe(0)
    expect(JSON.stringify(candidate)).not.toContain('token=secret')
  })
})
