#!/usr/bin/env node
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CALLBACK_PATH = '/merchant-mcp-callback'
const fail = code => new Error(`LOCAL_PLUGIN_LOGIN_${code}`)

function callbackPage(nonce) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>绑定 Store Nova</title>
<style nonce="${nonce}">
:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f6fb;color:#17233b}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 10%,#e4edff 0,#f3f6fb 44%,#f8faff 100%)}main{width:min(100%,440px);padding:40px 36px;border:1px solid #e0e8f5;border-radius:20px;background:#fff;box-shadow:0 22px 65px rgba(37,64,112,.12);text-align:center}.brand{display:inline-flex;align-items:center;gap:9px;margin-bottom:34px;color:#1f3763;font-size:16px;font-weight:700;letter-spacing:.01em}.mark{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:#3458d4;color:#fff;font-size:17px}.icon{display:grid;place-items:center;width:66px;height:66px;margin:0 auto 22px;border-radius:50%;background:#eaf0ff;color:#3658cf;font-size:31px;font-weight:700}.icon.pending::after{content:"";width:28px;height:28px;border:3px solid #b9c9ff;border-top-color:#3658cf;border-radius:50%;animation:spin .85s linear infinite}.icon.success{background:#e8f8ef;color:#15834a}.icon.error{background:#fff0ed;color:#c44b36}h1{margin:0 0 10px;font-size:23px;line-height:1.35;letter-spacing:-.02em}p{margin:0;color:#5a6880;font-size:15px;line-height:1.7}.hint{margin-top:24px;padding:14px 16px;border-radius:10px;background:#f5f7fb;color:#60708a;font-size:13px;line-height:1.6;text-align:left}.hint strong{color:#2b3c59}button{min-height:44px;width:100%;margin-top:28px;border:0;border-radius:10px;background:#3458d4;color:#fff;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer}button:hover{background:#2949bd}button:focus-visible{outline:3px solid #9db4ff;outline-offset:3px}button[hidden]{display:none}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.icon.pending::after{animation:none;border-color:#3658cf}}
</style></head><body><main role="dialog" aria-modal="true" aria-labelledby="title" aria-describedby="description"><div class="brand"><span class="mark" aria-hidden="true">S</span>Store Nova</div><div class="icon pending" id="icon" aria-hidden="true"></div><h1 id="title">正在完成绑定</h1><p id="description" role="status" aria-live="polite">已收到授权，正在验证并保存本地凭据…</p><div class="hint" id="hint">请保持此页面打开。完成后即可返回 <strong>ChatGPT</strong> 使用插件。</div><button type="button" id="close" hidden>完成，关闭此页面</button></main>
<script nonce="${nonce}">history.replaceState(null,'','${CALLBACK_PATH}');document.getElementById('close').addEventListener('click',()=>{window.close();document.getElementById('hint').textContent='如页面没有自动关闭，请手动关闭此标签页。'});</script>
`
}

function callbackResultScript(nonce, ok) {
  const title = ok ? '绑定已完成' : '绑定未完成'
  const description = ok ? '本地凭据已保存，插件已配置完成。' : '安装器未能完成绑定，请返回安装器查看错误并重试。'
  const hint = ok ? '关闭此页面，返回 ChatGPT 并在新对话中验证插件连接。' : '绑定步骤未全部完成。请查看安装器错误，然后重新发起绑定。'
  return `<script nonce="${nonce}">document.getElementById('icon').className='icon ${ok ? 'success' : 'error'}';document.getElementById('icon').textContent='${ok ? '✓' : '!'}';document.getElementById('title').textContent='${title}';document.getElementById('description').textContent='${description}';document.getElementById('hint').textContent='${hint}';document.getElementById('close').hidden=false;document.title='${title} · Store Nova';</script></body></html>`
}

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
export async function loginLocalPlugin({ baseUrl, workspaceId, requestId, createInstallationProof, openBrowser, storeCredential, configureSession, launchChatGPT,
  fetchImpl = fetch, timeoutMs = 300000, signal, credentialSource = 'keychain' }) {
  const target = validateLoginTarget(baseUrl, workspaceId)
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(requestId))) {
    throw fail('REQUEST_ID_INVALID')
  }
  if (!['keychain', 'windows_credential_manager'].includes(credentialSource)
    || ![openBrowser, storeCredential, configureSession].every(fn => typeof fn === 'function')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 600000) throw fail('CONFIG_INVALID')
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  let complete, reject, timer, consumed = false, callbackResponse, callbackNonce
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
    callbackNonce = randomBytes(16).toString('base64')
    callbackResponse = res
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${callbackNonce}'; style-src 'nonce-${callbackNonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
    res.writeHead(200)
    res.write(callbackPage(callbackNonce))
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
    let installationId
    if (createInstallationProof) {
      if (!requestId || typeof createInstallationProof !== 'function') throw fail('INSTALLATION_PROOF_INVALID')
      const proof = await createInstallationProof({ apiOrigin: target.apiOrigin, workspaceId: target.workspaceId,
        requestId, codeChallenge: challenge, redirectUri })
      const fields = { installation_id: proof?.installationId, challenge_id: proof?.challengeId,
        instance_signature: proof?.signature, client_nonce: proof?.clientNonce,
        server_nonce: proof?.serverNonce, challenge_issued_at: proof?.issuedAt,
        challenge_expires_at: proof?.expiresAt }
      if (Object.values(fields).some(value => typeof value !== 'string' || !value || /[\r\n]/u.test(value))) throw fail('INSTALLATION_PROOF_INVALID')
      installationId = proof.installationId
      for (const [name, value] of Object.entries(fields)) authorize.searchParams.set(name, value)
    }
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
        ...(requestId ? { connection_request_id: requestId } : {}), ...(installationId ? { installation_id: installationId } : {}) }),
    })
    const bundle = credentialFromResponse(await boundedJson(response), target)
    if (signal?.aborted) {
      await revokeCredential(target, bundle.refresh_token, fetchImpl)
      throw fail('CANCELLED')
    }
    await storeCredential(target, bundle)
    await configureSession(target)
    const chatGPT = typeof launchChatGPT === 'function' ? await launchChatGPT() : { launched: false, reason: 'ChatGPT 启动由安装器负责' }
    callbackResponse?.end(callbackResultScript(callbackNonce, true))
    return { ok: true, mode: 'local_stdio', workspace_id: target.workspaceId, api_origin: target.apiOrigin,
      credential_source: credentialSource, restart_required: !chatGPT.launched, chatgpt_launched: chatGPT.launched, host_verified: false }
  } catch (error) {
    if (callbackResponse && !callbackResponse.writableEnded) callbackResponse.end(callbackResultScript(callbackNonce, false))
    if (error instanceof Error && error.message === 'LOCAL_PLUGIN_LOGIN_CANCEL_REVOKE_FAILED') throw error
    if (signal?.aborted) throw fail('CANCELLED')
    if (error instanceof Error && /^LOCAL_PLUGIN_LOGIN_[A-Z_]+$/u.test(error.message)) throw error
    // Child-process and HTTP errors can carry raw credentials. Never rethrow them.
    throw fail('FAILED')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    if (callbackResponse && !callbackResponse.writableEnded) callbackResponse.end(callbackResultScript(callbackNonce, false))
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
  const installFlags = ['--installation-id', '--account-id', '--challenge-id', '--server-nonce', '--challenge-issued-at', '--challenge-expires-at']
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (!['--base-url', '--workspace', '--request-id', '--no-open', ...installFlags].includes(key) || options.has(key)) throw fail('ARGUMENTS_INVALID')
    const value = key === '--no-open' ? true : args[++index]
    if (!value || typeof value === 'string' && value.startsWith('--')) throw fail('ARGUMENTS_INVALID')
    options.set(key, value)
  }
  validateLoginTarget(options.get('--base-url'), options.get('--workspace'))
  const proofValues = installFlags.map(flag => options.get(flag))
  if (proofValues.some(Boolean) && (!proofValues.every(Boolean) || !options.get('--request-id'))) throw fail('INSTALLATION_PROOF_INVALID')
  if (process.platform !== 'darwin') throw fail('MACOS_REQUIRED')
  const manifest = JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (!manifest.version || manifest.version !== pkg.version) throw fail('PACKAGE_MISMATCH')
  const { writeKeychainCredential, assertKeychainHelperReady, installationIdentityStore } = await import('../mcp/keychain-credential.mjs')
  assertKeychainHelperReady()
  let createInstallationProof
  if (proofValues.every(Boolean)) {
    const { signInstallationTranscript } = await import('../mcp/installation-identity.mjs')
    const identity = installationIdentityStore(options.get('--base-url'), {
      accountId: options.get('--account-id'), workspaceId: options.get('--workspace'),
    }).load()
    if (!identity || identity.installation_id !== options.get('--installation-id') || identity.platform !== 'macos') throw fail('INSTALLATION_PROOF_INVALID')
    createInstallationProof = ({ apiOrigin, workspaceId, requestId, codeChallenge, redirectUri }) => {
      const clientNonce = randomBytes(32).toString('base64url')
      const transcript = { method: 'POST', path: '/v1/auth/local-plugin/authorize', apiOrigin,
        requestId, challengeId: options.get('--challenge-id'), accountId: options.get('--account-id'),
        workspaceId, installationId: identity.installation_id, keyId: identity.key_id, platform: 'macos',
        pkceChallenge: codeChallenge, redirectUri, clientNonce, serverNonce: options.get('--server-nonce'),
        issuedAt: options.get('--challenge-issued-at'), expiresAt: options.get('--challenge-expires-at') }
      return { installationId: identity.installation_id, challengeId: transcript.challengeId,
        signature: signInstallationTranscript(identity, transcript), clientNonce,
        serverNonce: transcript.serverNonce, issuedAt: transcript.issuedAt, expiresAt: transcript.expiresAt }
    }
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    const { launchVerifiedChatGPT } = await import('./launch-verified-chatgpt-macos.mjs')
    const { verifyChatGPTMacApp } = await import('./verify-chatgpt-macos.mjs')
    const appPaths = [resolve(homedir(), 'Applications/ChatGPT.app'), '/Applications/ChatGPT.app', resolve(homedir(), 'Applications/Store Nova/ChatGPT.app')]
    const launchChatGPT = async () => {
      const appPath = appPaths.find(path => existsSync(path) && verifyChatGPTMacApp(path).ok)
      return appPath ? launchVerifiedChatGPT(appPath) : { launched: false, reason: '未找到已验证的 ChatGPT.app' }
    }
    const result = await loginLocalPlugin({ baseUrl: options.get('--base-url'), workspaceId: options.get('--workspace'), requestId: options.get('--request-id'), createInstallationProof,
      openBrowser: url => options.get('--no-open') ? process.stdout.write(`请在商家浏览器打开此授权地址（不含 token）：\n${url}\n`)
        : execFileSync('/usr/bin/open', [url], { stdio: 'ignore', timeout: 5000 }),
      storeCredential: writeKeychainCredential, configureSession: configureLaunchd, launchChatGPT, signal: controller.signal })
    process.stdout.write(`${JSON.stringify(result)}\n${result.chatgpt_launched ? 'ChatGPT 已打开；请在新会话调用 onboarding.status 验证。' : '凭据已保存；请打开或重启 ChatGPT，并在新会话调用 onboarding.status 验证。'}\n`)
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${/^LOCAL_PLUGIN_LOGIN_[A-Z_]+$/u.test(error?.message) ? error.message : 'LOCAL_PLUGIN_LOGIN_FAILED'}\n`); process.exitCode = 1 })
}
