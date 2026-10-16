import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('rejects inherited and unknown tool names locally while forwarding registered public tools', async () => {
  const requests: unknown[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: { result: { accepted: true } }, error: null }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock backend did not bind')
  const child = spawn(process.execPath, [fileURLToPath(new URL('./bridge.mjs', import.meta.url))], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
      MERCHANT_WORKSPACE_ID: 'ws_registration_test',
      MERCHANT_MCP_TOKEN: 'registration-test-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let requestId = 0
  const call = async (name: string) => {
    requestId += 1
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: {} } })}\n`)
    const line = await lines.next()
    expect(line.done).toBe(false)
    return JSON.parse(line.value!)
  }
  try {
    const rejected = []
    for (const name of ['constructor', 'toString', '__proto__', 'unknown.registration.test']) {
      const response = await call(name)
      rejected.push({ name, error: response.error, backendRequests: requests.length })
    }
    expect(rejected).toEqual(['constructor', 'toString', '__proto__', 'unknown.registration.test'].map(name => ({
      name,
      error: { code: -32602, message: `当前插件没有此工具：${name}` },
      backendRequests: 0,
    })))
    const accepted = await call('onboarding.status')
    expect(accepted.error).toBeUndefined()
    expect(accepted.result.isError).toBe(false)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'onboarding.status', params: { workspace_id: 'ws_registration_test' } })
  } finally {
    const exited = once(child, 'exit')
    child.kill()
    await exited
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
