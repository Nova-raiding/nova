#!/usr/bin/env node
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const CALLBACK_PATH = '/merchant-mcp-callback'
const fail = code => new Error(`LOCAL_PLUGIN_LOGIN_${code}`)

export function validateLoginTarget(baseUrl, workspaceId) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() !== baseUrl || /[\s\\]/u.test(baseUrl)) throw fail('TARGET_INVALID')
  let url
  try { url = new URL(baseUrl) } catch { throw fail('TARGET_INVALID') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    || !/^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(workspaceId ?? '')) throw fail('TARGET_INVALID')
  return { apiOrigin: url.origin, workspaceId }
}

async function boundedJson(response) {
  if (!response.ok) { await response.body?.cancel(); throw fail('EXCHANGE_REJECTED') }
  const reader = response.body?.getReader()
  if (!reader) throw fail('RESPONSE_INVALID')
  const parts = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 65536) throw fail('RESPONSE_INVALID')
      parts.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch { await reader.cancel().catch(() => {}); throw fail('RESPONSE_INVALID') }
}

async function revokeCredential(target, refreshToken, fetchImpl) {
  const response = await fetchImpl(`${target.apiOrigin}/v1/auth/mcp-token/revoke`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  if (!response.ok) { await response.body?.cancel(); throw fail('CANCEL_REVOKE_FAILED') }
  await response.body?.cancel()
}

export function credentialFromResponse(payload, target) {
  const data = payload?.data ?? payload
  const validToken = value => typeof value === 'string' && /^[\x21-\x7e]{1,16384}$/u.test(value)
  if (payload?.error || !validToken(data?.access_token) || !validToken(data?.refresh_token)
    || data.token_type !== 'Bearer' || data.scope !== 'merchant'
    || data.workspace_id !== target.workspaceId || typeof data.account_login !== 'string' || !data.account_login.trim()
    || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400) throw fail('RESPONSE_INVALID')
  return {
    schema_version: '1', api_origin: target.apiOrigin, workspace_id: target.workspaceId,
    access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  }
}

/** The verifier and tokens never leave memory except through the credential store. */
export async function loginLocalPlugin({ baseUrl, workspaceId, requestId, openBrowser, storeCredential, configureSession,
  fetchImpl = fetch, timeoutMs = 300000, signal }) {
  const target = validateLoginTarget(baseUrl, workspaceId)
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(requestId))) {
    throw fail('REQUEST_ID_INVALID')
  }
  if (![openBrowser, storeCredential, configureSession].every(fn => typeof fn === 'function')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 600000) throw fail('CONFIG_INVALID')
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  let complete, reject, timer, consumed = false
  const callback = new Promise((resolve, rejectPromise) => { complete = resolve; reject = rejectPromise })
  // Keep early timeout/abort rejections handled while browser launch is pending.
  void callback.catch(() => {})
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    res.setHeader('referrer-policy', 'no-referrer')
    const address = server.address()
    const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : ''
    let url
    try { url = new URL(req.url ?? '', `http://${expectedHost}`) } catch { res.writeHead(400).end('Invalid callback'); return }
    const suppliedState = url.searchParams.get('state') ?? ''
    const stateBytes = Buffer.from(suppliedState)
    const expectedStateBytes = Buffer.from(state)
    const validState = stateBytes.length === expectedStateBytes.length && timingSafeEqual(stateBytes, expectedStateBytes)
    const code = url.searchParams.get('code') ?? ''
    if (consumed || req.method !== 'GET' || req.socket.remoteAddress !== '127.0.0.1'
      || req.headers.host !== expectedHost || url.origin !== `http://${expectedHost}`
      || url.pathname !== CALLBACK_PATH || !validState || url.searchParams.getAll('state').length !== 1
      || url.searchParams.getAll('code').length !== 1 || !/^[A-Za-z0-9._~-]{16,2048}$/u.test(code)
      || [...url.searchParams.keys()].some(key => key !== 'state' && key !== 'code')) {
      res.writeHead(400).end('Invalid callback'); return
    }
    consumed = true
    res.end('Store Nova 已收到授权回调。请返回本地安装器查看最终结果；此页面不代表安装成功。')
    complete(code)
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  const cancel = () => reject(fail('CANCELLED'))
  try {
    if (signal?.aborted) throw fail('CANCELLED')
    await new Promise((resolve, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`
    const authorize = new URL('/v1/auth/local-plugin/authorize', target.apiOrigin)
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: 'local-desktop', redirect_uri: redirectUri,
      state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant',
      resource: `${target.apiOrigin}/mcp`, workspace_id: target.workspaceId, ...(requestId ? { connection_request_id: requestId } : {}) })) authorize.searchParams.set(name, value)
    timer = setTimeout(() => reject(fail('TIMEOUT')), timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    await openBrowser(authorize.toString())
    const code = await callback
    clearTimeout(timer)
    if (signal?.aborted) throw fail('CANCELLED')
    const exchangeSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    const response = await fetchImpl(`${target.apiOrigin}/v1/auth/local-plugin/token`, {
      method: 'POST', redirect: 'error', signal: exchangeSignal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'local-desktop', redirect_uri: redirectUri,
        code, code_verifier: verifier, resource: `${target.apiOrigin}/mcp`, workspace_id: target.workspaceId,
        ...(requestId ? { connection_request_id: requestId } : {}) }),
    })
    const bundle = credentialFromResponse(await boundedJson(response), target)
    if (signal?.aborted) {
      await revokeCredential(target, bundle.refresh_token, fetchImpl)
      throw fail('CANCELLED')
    }
    await storeCredential(target, bundle)
    await configureSession(target)
    return { ok: true, mode: 'local_stdio', workspace_id: target.workspaceId, api_origin: target.apiOrigin,
      credential_source: 'keychain', restart_required: true, host_verified: false }
  } catch (error) {
    if (error instanceof Error && error.message === 'LOCAL_PLUGIN_LOGIN_CANCEL_REVOKE_FAILED') throw error
    if (signal?.aborted) throw fail('CANCELLED')
    if (error instanceof Error && /^LOCAL_PLUGIN_LOGIN_[A-Z_]+$/u.test(error.message)) throw error
    // Child-process and HTTP errors can carry raw credentials. Never rethrow them.
    throw fail('FAILED')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    server.closeAllConnections()
    await new Promise(resolve => server.close(() => resolve()))
  }
}

function configureLaunchd(target) {
  const values = { MERCHANT_MCP_BASE_URL: target.apiOrigin, MERCHANT_WORKSPACE_ID: target.workspaceId,
    MERCHANT_MCP_TOKEN_SOURCE: 'keychain', MERCHANT_STRICT_AUTH: 'true', MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false',
    MERCHANT_MCP_WRITE_ENABLED: 'false', DEPLOY_ENV: 'local_desktop' }
  for (const [key, value] of Object.entries(values)) execFileSync('/bin/launchctl', ['setenv', key, value], { stdio: 'ignore', timeout: 5000 })
  // Remove only obsolete credential mirrors, never an existing Keychain item.
  for (const key of ['MERCHANT_MCP_TOKEN', 'MERCHANT_MCP_REFRESH_TOKEN']) execFileSync('/bin/launchctl', ['unsetenv', key], { stdio: 'ignore', timeout: 5000 })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('用法: node scripts/login-local-macos.mjs --base-url https://yxsona.com --workspace ws_xxx [--request-id <一次性请求标识>] [--no-open]\n在商家浏览器登录并确认后，凭据写入系统钥匙串；不需要 ChatGPT OAuth 或插件市场上架。\n')
    return
  }
  const options = new Map()
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (!['--base-url', '--workspace', '--request-id', '--no-open'].includes(key) || options.has(key)) throw fail('ARGUMENTS_INVALID')
    const value = key === '--no-open' ? true : args[++index]
    if (!value || typeof value === 'string' && value.startsWith('--')) throw fail('ARGUMENTS_INVALID')
    options.set(key, value)
  }
  validateLoginTarget(options.get('--base-url'), options.get('--workspace'))
  if (process.platform !== 'darwin') throw fail('MACOS_REQUIRED')
  const manifest = JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (!manifest.version || manifest.version !== pkg.version) throw fail('PACKAGE_MISMATCH')
  const { writeKeychainCredential, assertKeychainHelperReady } = await import('../mcp/keychain-credential.mjs')
  assertKeychainHelperReady()
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    const result = await loginLocalPlugin({ baseUrl: options.get('--base-url'), workspaceId: options.get('--workspace'), requestId: options.get('--request-id'),
      openBrowser: url => options.get('--no-open') ? process.stdout.write(`请在商家浏览器打开此授权地址（不含 token）：\n${url}\n`)
        : execFileSync('/usr/bin/open', [url], { stdio: 'ignore', timeout: 5000 }),
      storeCredential: writeKeychainCredential, configureSession: configureLaunchd, signal: controller.signal })
    process.stdout.write(`${JSON.stringify(result)}\n请重启 ChatGPT 并在新会话调用 onboarding.status 验证，当前不宣称宿主连接已通过。\n`)
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${/^LOCAL_PLUGIN_LOGIN_[A-Z_]+$/u.test(error?.message) ? error.message : 'LOCAL_PLUGIN_LOGIN_FAILED'}\n`); process.exitCode = 1 })
}
