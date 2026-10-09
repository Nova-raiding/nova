import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'

let child: ChildProcessWithoutNullStreams | undefined

function nextLine(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      resolve(JSON.parse(buffer.slice(0, newline)))
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onEnd = () => { cleanup(); reject(new Error('bridge ended before response')) }
    const cleanup = () => {
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('end', onEnd)
    }
    stream.on('data', onData)
    stream.once('error', onError)
    stream.once('end', onEnd)
  })
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill()
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))])
  }
  child = undefined
})

it('negotiates MCP versions and exposes all authoritative billing list paging inputs over local stdio', async () => {
  const bridgePath = new URL('./bridge.mjs', import.meta.url)
  child = spawn(process.execPath, [bridgePath.pathname], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', DEPLOY_ENV: 'local_desktop', MERCHANT_ALLOW_FIXTURE_FALLBACK: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'a-client-supported-older-version' } })}\n`)
  const initialized = await nextLine(child.stdout)
  expect(initialized).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } })
  expect(initialized.error).toBeUndefined()

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  const listed = await nextLine(child.stdout)
  const rechargeList = listed.result.tools.find((tool: { name: string }) => tool.name === 'billing.recharge.list')
  expect(rechargeList.inputSchema.properties).toMatchObject({
    states: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    scope: { type: 'string', enum: ['mine', 'workspace'] },
  })
  expect(listed.error).toBeUndefined()

  const source = await readFile(bridgePath, 'utf8')
  const mirror = await readFile(new URL('../../../.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs', import.meta.url), 'utf8')
  expect(mirror).toBe(source)
})
