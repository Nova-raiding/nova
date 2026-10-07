import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, cpSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type JsonRpcMessage = Record<string, any>

describe('installed local stdio manifest tool discovery', () => {
  it('launches the installed package from its declared command, args, and cwd, then discovers merchant tools', async () => {
    const source = resolve(process.cwd(), 'apps/plugin')
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'merchant-installed-manifest-discovery-'))
    const installedRoot = resolve(temporaryRoot, 'installed-plugin')
    cpSync(source, installedRoot, { recursive: true })

    let child: ReturnType<typeof spawn> | undefined
    try {
      const manifest = JSON.parse(readFileSync(resolve(installedRoot, '.mcp.json'), 'utf8')) as {
        mcpServers: Record<string, { command: string; args: string[]; cwd?: string; env_vars?: string[] }>
      }
      const server = manifest.mcpServers['merchant-marketing']
      if (!server) throw new Error('merchant-marketing is missing from the installed MCP manifest')
      expect(server.args).toEqual(['./mcp/bridge.mjs'])
      expect(server.cwd).toBe('.')

      const cwd = resolve(installedRoot, server.cwd ?? '.')
      const allowedEnvironment = Object.fromEntries(
        (server.env_vars ?? []).filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]!]),
      )
      child = spawn(server.command, server.args, {
        cwd,
        env: { ...allowedEnvironment, NODE_ENV: 'test', MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:1', MERCHANT_WORKSPACE_ID: 'ws_manifest_discovery' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const bridge = child
      const stdoutStream = bridge.stdout
      const stderrStream = bridge.stderr
      const stdin = bridge.stdin
      if (!stdoutStream || !stderrStream || !stdin) throw new Error('Manifest-launched bridge did not expose stdio pipes')

      let stdout = ''
      const responses = new Promise<JsonRpcMessage[]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for manifest-launched bridge responses')), 10_000)
        stdoutStream.setEncoding('utf8').on('data', chunk => {
          stdout += chunk
          const chunks = stdout.split(/\r?\n/u)
          stdout = chunks.pop() ?? ''
          const lines = chunks.filter(Boolean).map(line => JSON.parse(line) as JsonRpcMessage)
          received.push(...lines)
          if (received.length >= 2) { clearTimeout(timeout); resolve(received) }
        })
        bridge.once('error', error => { clearTimeout(timeout); reject(error) })
        bridge.once('close', code => {
          if (received.length < 2) {
            clearTimeout(timeout)
            reject(new Error(`Manifest-launched bridge closed before replying (code ${code})`))
          }
        })
      })
      const received: JsonRpcMessage[] = []
      let stderr = ''
      stderrStream.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      const closed = once(bridge, 'close')
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'manifest-regression', version: '1' } } })}\n`)
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
      stdin.end()

      const lines = await responses
      bridge.kill('SIGTERM')
      const [exitCode, signal] = await closed
      expect(signal, stderr).toBe('SIGTERM')
      expect(exitCode).toBeNull()
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'merchant-marketing' } } })
      expect(lines[1]).toMatchObject({ jsonrpc: '2.0', id: 2, result: { tools: expect.any(Array) } })
      const names = (lines[1]!.result.tools as Array<{ name: string }>).map(tool => tool.name)
      expect(names).toContain('onboarding.status')
      expect(names).toContain('content.draft.generate')
      expect(names).not.toContain('platform.connect')
      expect(names.some(name => name.startsWith('ops.'))).toBe(false)
    } finally {
      child?.kill()
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }, 15_000)
})
