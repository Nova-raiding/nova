import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url))
const temporaryRoots: string[] = []
const children: ReturnType<typeof spawn>[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.kill()
  })))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    server.closeAllConnections()
  })))
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

function nextLine(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      stream.off('data', onData)
      stream.off('error', onError)
      resolve(JSON.parse(buffer.slice(0, newline)))
    }
    const onError = (error: Error) => { stream.off('data', onData); reject(error) }
    stream.on('data', onData)
    stream.on('error', onError)
  })
}

describe('persistent workspace binding scope', () => {
  it.each([
    ['api_origin', 'https://other.example.test'],
    ['actor_id', 'actor_other'],
    ['token_sha256', '0'.repeat(64)],
    ['environment', 'production'],
  ] as const)('rejects a persisted binding when %s no longer matches', async (changedKey, changedValue) => {
    let forwarded = 0
    const server = createServer((_request, response) => { forwarded += 1; response.writeHead(200).end('{}') })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('mock listener did not bind a TCP port')

    const root = await mkdtemp(join(tmpdir(), 'merchant-workspace-binding-scope-'))
    temporaryRoots.push(root)
    const bindingDir = join(root, 'merchant-marketing')
    await mkdir(bindingDir, { recursive: true })
    const fakeToken = 'unit-test-only-token'
    const scope = {
      api_origin: `http://127.0.0.1:${address.port}`,
      actor_id: 'actor_fixture',
      token_sha256: createHash('sha256').update(fakeToken).digest('hex'),
      environment: 'test',
    }
    await writeFile(join(bindingDir, 'workspace-binding.json'), JSON.stringify({
      schema_version: '2', workspace_id: 'ws_fixture', scope: { ...scope, [changedKey]: changedValue },
    }))

    const child = spawn(process.execPath, [bridgePath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'test',
        CODEX_HOME: root,
        MERCHANT_MCP_BASE_URL: scope.api_origin,
        MERCHANT_MCP_TOKEN: fakeToken,
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_ACTOR_ID: scope.actor_id,
        MERCHANT_WORKSPACE_ID: '',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false',
        MERCHANT_MCP_WRITE_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
    const response = await nextLine(child.stdout)
    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: { code: 'MCP_CONFIGURATION_REQUIRED', recovery: { state: 'workspace_binding_required' } },
    })
    expect(forwarded).toBe(0)
  })
})
