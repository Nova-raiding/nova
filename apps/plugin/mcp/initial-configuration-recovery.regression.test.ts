import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Only the isolated subprocess sees darwin and intercepted OS/network calls.
const preload = `
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
Object.defineProperty(process, 'platform', { value: 'darwin' })
const state = () => JSON.parse(readFileSync(process.env.RECOVERY_FIXTURE_STATE, 'utf8'))
const audit = event => appendFileSync(process.env.RECOVERY_FIXTURE_AUDIT, JSON.stringify(event) + '\\n')
childProcess.execFileSync = (command, args) => {
  if (command !== '/bin/launchctl' || args[0] !== 'getenv') throw new Error('unexpected subprocess')
  audit({ kind: 'launchctl', name: args[1] })
  return state().launchd[args[1]] ?? ''
}
childProcess.spawnSync = (command, args, options) => {
  if (!command.endsWith('/keychain-credential-helper') || args.length) throw new Error('unexpected native executable')
  const request = JSON.parse(options.input)
  audit({ kind: 'native', operation: request.operation, service: request.service, account: request.account })
  if (request.operation !== 'read') throw new Error('native writes forbidden')
  return { status: 0, stdout: JSON.stringify(state().credential), stderr: '' }
}
syncBuiltinESMExports()
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body)
  audit({ kind: 'fetch', url: String(url), method: body.method, params: body.params,
    credential: options.headers.authorization === 'Bearer fixture-native-token' ? 'native'
      : options.headers.authorization === 'Bearer fixture-explicit-token' ? 'explicit' : 'unexpected' })
  if (body.method !== 'feedback.list') throw new Error('unexpected API operation')
  return new Response(JSON.stringify({ data: { result: { task_id: body.params.task_id, workspace_id: body.params.workspace_id } }, error: null }),
    { status: 200, headers: { 'content-type': 'application/json' } })
}
`

function stagedBridge() {
  const root = mkdtempSync(join(tmpdir(), 'merchant-initial-recovery-'))
  const mcp = join(root, 'mcp')
  cpSync(fileURLToPath(new URL('./', import.meta.url)), mcp, {
    recursive: true,
    filter: path => !path.endsWith('.test.ts') && !path.endsWith('/keychain-credential-helper')
      && !path.endsWith('/keychain-credential-helper.build.json'),
  })
  // No QA broker profile is staged: the actual native readiness and binding
  // checks run, but spawnSync intercepts the placeholder before execution.
  const binary = Buffer.from('fixture placeholder; must never execute\n')
  writeFileSync(join(mcp, 'keychain-credential-helper'), binary, { mode: 0o700 })
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(mcp, 'keychain-credential-helper.build.json'), JSON.stringify({
    schema_version: '1', platform: 'darwin', arch: process.arch,
    source_sha256: hash(readFileSync(join(mcp, 'keychain-credential-helper.swift'))), binary_sha256: hash(binary),
  }))
  const statePath = join(root, 'state.json')
  const auditPath = join(root, 'audit.jsonl')
  const preloadPath = join(root, 'preload.mjs')
  writeFileSync(preloadPath, preload)
  writeFileSync(auditPath, '')
  const credential = { schema_version: '1', api_origin: 'https://bound.example.test', workspace_id: 'ws_recovery_bound',
    access_token: 'fixture-native-token', refresh_token: 'fixture-native-refresh', expires_at: '2099-01-01T00:00:00Z' }
  const configure = (launchd: Record<string, string>) => writeFileSync(statePath, JSON.stringify({ launchd, credential }))
  const audit = (): Array<Record<string, any>> => readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { root, mcp, statePath, auditPath, preloadPath, configure, audit }
}

function connection(child: ChildProcessWithoutNullStreams) {
  const lines = createInterface({ input: child.stdout })
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let sequence = 0
  lines.on('line', line => {
    const response = JSON.parse(line)
    const pending = waiting.get(response.id)
    if (pending) { waiting.delete(response.id); pending.resolve(response) }
  })
  child.on('exit', () => { for (const pending of waiting.values()) pending.reject(new Error('bridge exited before response')) })
  return (method: string, params?: object) => new Promise<any>((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('bridge response timeout')) }, 5000)
    waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n')
  })
}

describe('same-process initial Bridge configuration recovery', () => {
  it.each(['native', 'explicit', 'explicit-placeholder'])('recovers once and pins endpoint/workspace with authentication %s', async mode => {
    const explicitToken = mode !== 'native'
    const fixture = stagedBridge()
    fixture.configure({ MERCHANT_MCP_TOKEN_SOURCE: 'keychain' })
    const child = spawn(process.execPath, ['--import', fixture.preloadPath, join(fixture.mcp, 'bridge.mjs')], {
      cwd: fixture.root,
      // Deliberately do not inherit ambient merchant credentials or host config.
      env: { PATH: process.env.PATH, NODE_ENV: 'production', DEPLOY_ENV: 'production', CODEX_HOME: join(fixture.root, 'codex'),
        MERCHANT_STRICT_AUTH: 'true', MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false', MERCHANT_MCP_RETRY_ATTEMPTS: '1',
        RECOVERY_FIXTURE_STATE: fixture.statePath, RECOVERY_FIXTURE_AUDIT: fixture.auditPath,
        ...(explicitToken ? { MERCHANT_MCP_TOKEN: 'fixture-explicit-token' } : {}),
        ...(mode === 'explicit-placeholder' ? { MERCHANT_MCP_TOKEN_SOURCE: '${MERCHANT_MCP_TOKEN_SOURCE}' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Drain stderr without surfacing credentials or fixture records.
    child.stderr.resume()
    const request = connection(child)
    const call = () => request('tools/call', { name: 'feedback.list', arguments: { task_id: 'task_recovery_fixture' } })
    try {
      expect((await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).result).toBeDefined()
      expect((await request('tools/list')).result.tools.some((tool: { name: string }) => tool.name === 'feedback.list')).toBe(true)
      expect(fixture.audit().filter(event => event.kind !== 'launchctl')).toEqual([])

      const blocked = await call()
      expect(blocked.result).toMatchObject({ isError: true, structuredContent: { code: 'MCP_CONFIGURATION_REQUIRED',
        details: { missing: ['MERCHANT_MCP_BASE_URL'], operation_status: 'blocked' } } })
      expect(fixture.audit().filter(event => event.kind !== 'launchctl')).toEqual([])

      fixture.configure({ MERCHANT_MCP_BASE_URL: 'https://bound.example.test', MERCHANT_WORKSPACE_ID: 'ws_recovery_bound', MERCHANT_MCP_TOKEN_SOURCE: 'keychain' })
      expect((await call()).result).toMatchObject({ isError: false, structuredContent: { task_id: 'task_recovery_fixture', workspace_id: 'ws_recovery_bound' } })
      const recoveredAudit = fixture.audit()
      const reads = recoveredAudit.filter(event => event.kind === 'native')
      expect(reads).toHaveLength(explicitToken ? 0 : 1)
      if (!explicitToken) expect(reads[0]).toMatchObject({ operation: 'read', service: 'com.storenova.merchant-mcp',
        account: createHash('sha256').update('https://bound.example.test\nws_recovery_bound').digest('hex') })
      expect(recoveredAudit.filter(event => event.kind === 'fetch')).toEqual([expect.objectContaining({
        url: 'https://bound.example.test/mcp', method: 'feedback.list', credential: explicitToken ? 'explicit' : 'native',
        params: { task_id: 'task_recovery_fixture', workspace_id: 'ws_recovery_bound' },
      })])

      fixture.configure({ MERCHANT_MCP_BASE_URL: 'https://redirect.example.test', MERCHANT_WORKSPACE_ID: 'ws_redirect', MERCHANT_MCP_TOKEN_SOURCE: 'launchd' })
      expect((await request('tools/list')).result.tools).toBeDefined()
      expect((await call()).result).toMatchObject({ isError: false, structuredContent: { workspace_id: 'ws_recovery_bound' } })
      const finalAudit = fixture.audit()
      expect(finalAudit.filter(event => event.kind === 'launchctl')).toEqual(recoveredAudit.filter(event => event.kind === 'launchctl'))
      expect(finalAudit.filter(event => event.kind === 'native')).toEqual(reads)
      expect(finalAudit.filter(event => event.kind === 'fetch')).toHaveLength(2)
      expect(finalAudit.filter(event => event.kind === 'fetch').every(event => event.url === 'https://bound.example.test/mcp'
        && event.params.workspace_id === 'ws_recovery_bound' && event.credential === (explicitToken ? 'explicit' : 'native'))).toBe(true)
    } finally {
      const exited = once(child, 'exit')
      child.kill()
      if (child.exitCode === null && child.signalCode === null) await exited
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }, 15_000)
})
