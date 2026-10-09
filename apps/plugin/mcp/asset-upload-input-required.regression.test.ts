import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bridgePaths = [
  fileURLToPath(new URL('./bridge.mjs', import.meta.url)),
  fileURLToPath(new URL('../../../.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs', import.meta.url)),
]

async function callUpload(entrypoint: string) {
  const forwarded: unknown[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    forwarded.push(JSON.parse(body))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: { result: {} }, error: null }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEPLOY_ENV: 'local_desktop',
      MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
      MERCHANT_WORKSPACE_ID: 'ws_asset_input_required',
      MERCHANT_MCP_TOKEN_SOURCE: 'environment',
      MERCHANT_MCP_TOKEN: 'isolated-test-token',
      MERCHANT_MCP_WRITE_ENABLED: 'true',
      MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = once(child, 'close')
  try {
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'asset.upload', arguments: { name: 'product.png', mime_type: 'image/png' } } })}\n`)
    let output = ''
    for await (const chunk of child.stdout) output += String(chunk)
    await closed
    return { response: JSON.parse(output.trim()), forwarded }
  } finally {
    child.kill()
    server.close()
  }
}

describe('asset.upload input presence regression', () => {
  it.each(bridgePaths.map((path, index) => [index === 0 ? 'source bridge' : 'marketplace mirror', path] as const))(
    'rejects absent local and inline input before API forwarding (%s)', async (_name, entrypoint) => {
      const { response, forwarded } = await callUpload(entrypoint)
      expect(response.result).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_ARGUMENTS_INVALID' } })
      expect(forwarded).toEqual([])
    },
  )
})
