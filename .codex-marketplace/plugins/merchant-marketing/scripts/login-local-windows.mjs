#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { localPluginLoginFailureMessage, loginLocalPlugin, validateLoginTarget } from './login-local-macos.mjs'

const fail = code => new Error(`LOCAL_PLUGIN_LOGIN_${code}`)

function configureWindowsSession(target, run = execFileSync) {
  const values = { MERCHANT_MCP_BASE_URL: target.apiOrigin, MERCHANT_WORKSPACE_ID: target.workspaceId,
    MERCHANT_MCP_TOKEN_SOURCE: 'windows_credential_manager', MERCHANT_STRICT_AUTH: 'true',
    MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false', MERCHANT_MCP_WRITE_ENABLED: 'false', DEPLOY_ENV: 'local_desktop' }
  for (const [key, value] of Object.entries(values)) run('setx.exe', [key, value], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
  // No access or refresh token is ever passed to setx, argv, logs, or a plaintext config file.
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  if (args.includes('--help')) {
    process.stdout.write('用法: node scripts/login-local-windows.mjs --base-url https://yxsona.com --workspace ws_xxx [--request-id <一次性请求标识>] [--no-open]\n在商家浏览器登录并确认后，凭据写入 Windows Credential Manager；不需要 ChatGPT OAuth 或插件市场上架。\n')
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
  const target = validateLoginTarget(options.get('--base-url'), options.get('--workspace'))
  if ((dependencies.platform ?? process.platform) !== 'win32') throw fail('WINDOWS_REQUIRED')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (!pkg.version) throw fail('PACKAGE_MISMATCH')
  const { writeWindowsCredential, assertWindowsCredentialHelperReady } = await import('../mcp/windows-credential.mjs')
  ;(dependencies.assertCredentialReady ?? assertWindowsCredentialHelperReady)()
  return loginLocalPlugin({ baseUrl: target.apiOrigin, workspaceId: target.workspaceId, requestId: options.get('--request-id'),
    credentialSource: 'windows_credential_manager',
    openBrowser: dependencies.openBrowser ?? (url => options.get('--no-open')
      ? process.stdout.write(`请在商家浏览器打开此授权地址（不含 token）：\n${url}\n`)
      : execFileSync('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true, timeout: 5000 })),
    storeCredential: dependencies.storeCredential ?? writeWindowsCredential,
    configureSession: dependencies.configureSession ?? (value => configureWindowsSession(value)),
    fetchImpl: dependencies.fetchImpl ?? fetch, timeoutMs: dependencies.timeoutMs ?? 300000 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => { if (result) process.stdout.write(`${JSON.stringify(result)}\n`) }).catch(error => {
    const code = /^LOCAL_PLUGIN_LOGIN_([A-Z_]+)$/u.exec(error?.message ?? '')?.[1] ?? 'FAILED'
    process.stderr.write(`LOCAL_PLUGIN_LOGIN_${code}: ${localPluginLoginFailureMessage(code)}\n`); process.exitCode = 1
  })
}
