#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fail = code => new Error(`LOCAL_PLUGIN_CONNECT_${code}`)
const allowedKeys = new Set(['api_origin', 'workspace', 'request_id'])

/** Parse only non-secret routing metadata from the custom protocol URL. */
export function parseConnectUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n\\]/u.test(value)) throw fail('URL_INVALID')
  let url
  try { url = new URL(value) } catch { throw fail('URL_INVALID') }
  if (url.protocol !== 'storenova:' || url.hostname !== 'connect' || (url.pathname !== '' && url.pathname !== '/')
    || url.username || url.password || url.hash) throw fail('URL_INVALID')
  const keys = [...url.searchParams.keys()]
  if (keys.some(key => !allowedKeys.has(key)) || keys.some(key => url.searchParams.getAll(key).length !== 1)) {
    throw fail('PARAMETERS_INVALID')
  }
  const baseUrl = url.searchParams.get('api_origin') ?? ''
  const workspaceId = url.searchParams.get('workspace') ?? ''
  const requestId = url.searchParams.get('request_id') ?? undefined
  if (!baseUrl || !workspaceId || !requestId || !/^[A-Za-z0-9_-]{16,128}$/u.test(requestId)) throw fail('PARAMETERS_INVALID')
  // Reuse the login command's canonical origin/workspace checks without ever accepting credentials in this URL.
  let targetUrl
  try { targetUrl = new URL(baseUrl) } catch { throw fail('PARAMETERS_INVALID') }
  if (targetUrl.username || targetUrl.password || targetUrl.search || targetUrl.hash || targetUrl.pathname !== '/'
    || !(targetUrl.protocol === 'https:' || (targetUrl.protocol === 'http:' && targetUrl.hostname === '127.0.0.1'))
    || !/^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(workspaceId)) throw fail('PARAMETERS_INVALID')
  return { baseUrl: targetUrl.origin, workspaceId, requestId }
}

export function runConnectUrl(value, { node = process.execPath, loginScript = resolve(dirname(fileURLToPath(import.meta.url)), 'login-local-macos.mjs') } = {}) {
  const request = parseConnectUrl(value)
  const result = execFileSync(node, [loginScript, '--base-url', request.baseUrl, '--workspace', request.workspaceId,
    '--request-id', request.requestId], { stdio: 'inherit', timeout: 600_000 })
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw fail('ARGUMENTS_INVALID')
    runConnectUrl(process.argv[2])
  } catch (error) {
    const message = /^LOCAL_PLUGIN_CONNECT_[A-Z_]+$/u.test(error?.message) ? error.message : 'LOCAL_PLUGIN_CONNECT_FAILED'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
