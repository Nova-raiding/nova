import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url))
const children: ReturnType<typeof spawn>[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function startBridge(bridge = bridgePath) {
  const forwarded: unknown[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    forwarded.push(JSON.parse(body))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: { result: { job_id: 'job_test', job: { state: 'failed' } } }, error: null }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test API server did not bind')
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEPLOY_ENV: '${DEPLOY_ENV}',
      MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
      MERCHANT_WORKSPACE_ID: 'ws_image_contract_test',
      MERCHANT_MCP_TOKEN_SOURCE: 'environment',
      MERCHANT_MCP_TOKEN: 'test-only-token',
      MERCHANT_MCP_REFRESH_TOKEN: '',
      MERCHANT_ALLOW_FIXTURE_FALLBACK: 'true',
      MERCHANT_MCP_WRITE_ENABLED: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const lines = createInterface({ input: child.stdout })
  const iterator = lines[Symbol.asyncIterator]()
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' } } })}\n`)
  const confirmation = await iterator.next()
  if (confirmation.done || JSON.parse(confirmation.value).result?.isError) throw new Error('interactive write fixture confirmation failed')
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`)
  const listedLine = await iterator.next()
  if (listedLine.done) throw new Error('bridge exited before listing tools')
  const listed = JSON.parse(listedLine.value)
  const imageSchema = listed.result?.tools?.find((tool: { name: string }) => tool.name === 'catalog.image.generate')?.inputSchema
  const call = async (id: number, args: Record<string, string>) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'catalog.image.generate', arguments: args } })}\n`)
    const line = await iterator.next()
    if (line.done) throw new Error('bridge exited before replying')
    return JSON.parse(line.value).result
  }
  return { call, forwarded, imageSchema, close: () => lines.close() }
}

describe('image-generation MCP input contract', () => {
  it.each([
    ['marketplace', bridgePath],
    ['ChatGPT local install', resolve(process.cwd(), 'apps/plugin/mcp/bridge.mjs')],
  ])('%s rejects incomplete unbound inputs before forwarding while accepting bound and uploaded-image paths', async (_name, path) => {
    const bridge = await startBridge(path)
    try {
      expect(bridge.imageSchema.oneOf).toEqual([
        { required: ['product_id'] },
        { required: ['title', 'asset_ids_json'] },
      ])
      for (const args of [
        {},
        { title: '候选商品' },
        { asset_ids_json: '["asset_1"]' },
        { title: '候选商品', asset_ids_json: '' },
        { title: '候选商品', asset_ids_json: '[]' },
        { title: '候选商品', asset_ids_json: '{"asset_id":"asset_1"}' },
        { title: '候选商品', asset_ids_json: '[" "]' },
      ]) {
        const result = await bridge.call(2, args)
        expect(result).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_ARGUMENTS_INVALID' } })
      }
      expect(bridge.forwarded.filter(request => (request as { method: string }).method === 'catalog.image.generate')).toHaveLength(0)

      for (const args of [
        { product_id: 'product_1' },
        { title: '候选商品', asset_ids_json: '["asset_1"]' },
      ]) {
        const result = await bridge.call(3, args)
        expect(result.isError).toBe(false)
      }
      expect(bridge.forwarded.filter(request => (request as { method: string }).method === 'catalog.image.generate')).toHaveLength(2)
    } finally {
      bridge.close()
    }
  }, 15000)
})
