#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fail = code => new Error(`LOCAL_PLUGIN_CONNECT_${code}`)
const allowedKeys = new Set(['api_origin', 'workspace', 'request_id', 'account_id', 'installation_id',
  'challenge_id', 'server_nonce', 'challenge_issued_at', 'challenge_expires_at'])

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
  const proof = Object.fromEntries(['account_id', 'installation_id', 'challenge_id', 'server_nonce',
    'challenge_issued_at', 'challenge_expires_at'].map(key => [key, url.searchParams.get(key)]))
  const proofValues = Object.values(proof)
  if (proofValues.some(Boolean) && !proofValues.every(Boolean)) throw fail('PARAMETERS_INVALID')
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  if (proofValues.every(Boolean) && (!/^[A-Za-z0-9_-]{1,128}$/u.test(proof.account_id)
    || !uuid.test(proof.installation_id)
    || !uuid.test(proof.challenge_id)
    || !/^[A-Za-z0-9_-]{43}$/u.test(proof.server_nonce)
    || !Number.isFinite(Date.parse(proof.challenge_issued_at))
    || !Number.isFinite(Date.parse(proof.challenge_expires_at))
    || Date.parse(proof.challenge_expires_at) <= Date.parse(proof.challenge_issued_at))) throw fail('PARAMETERS_INVALID')
  return { baseUrl: targetUrl.origin, workspaceId, requestId, ...(proofValues.every(Boolean) ? { proof } : {}) }
}

export function runConnectUrl(value, { node = process.execPath, loginScript = resolve(dirname(fileURLToPath(import.meta.url)), 'login-local-macos.mjs') } = {}) {
  const request = parseConnectUrl(value)
  const args = [loginScript, '--base-url', request.baseUrl, '--workspace', request.workspaceId,
    '--request-id', request.requestId]
  if (request.proof) for (const [name, value] of Object.entries({
    '--account-id': request.proof.account_id, '--installation-id': request.proof.installation_id,
    '--challenge-id': request.proof.challenge_id, '--server-nonce': request.proof.server_nonce,
    '--challenge-issued-at': request.proof.challenge_issued_at,
    '--challenge-expires-at': request.proof.challenge_expires_at,
  })) args.push(name, value)
  const result = execFileSync(node, args, { stdio: 'inherit', timeout: 600_000 })
  return result
}

export function parseEnrollUrl(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\r\n\\]/u.test(value)) throw fail('URL_INVALID')
  let url
  try { url = new URL(value) } catch { throw fail('URL_INVALID') }
  if (url.protocol !== 'storenova:' || url.hostname !== 'enroll' || (url.pathname !== '' && url.pathname !== '/')
    || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => !['api_origin', 'workspace', 'account_id'].includes(key))
    || url.searchParams.getAll('api_origin').length !== 1 || url.searchParams.getAll('workspace').length !== 1
    || url.searchParams.getAll('account_id').length !== 1) throw fail('URL_INVALID')
  const baseUrl = url.searchParams.get('api_origin')
  const workspaceId = url.searchParams.get('workspace')
  const accountId = url.searchParams.get('account_id')
  if (!baseUrl || !workspaceId || !/^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(workspaceId)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(accountId ?? '')) throw fail('PARAMETERS_INVALID')
  let target
  try { target = new URL(baseUrl) } catch { throw fail('PARAMETERS_INVALID') }
  if (target.username || target.password || target.search || target.hash || target.pathname !== '/'
    || !(target.protocol === 'https:' || target.protocol === 'http:' && target.hostname === '127.0.0.1')) throw fail('PARAMETERS_INVALID')
  return { baseUrl: target.origin, workspaceId, accountId }
}

export function runEnrollUrl(value, { node = process.execPath, enrollScript = resolve(dirname(fileURLToPath(import.meta.url)), 'enroll-local-macos.mjs') } = {}) {
  const request = parseEnrollUrl(value)
  return execFileSync(node, [enrollScript, '--base-url', request.baseUrl, '--workspace', request.workspaceId, '--account-id', request.accountId],
    { stdio: 'inherit', timeout: 60_000 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw fail('ARGUMENTS_INVALID')
    if (new URL(process.argv[2]).hostname === 'enroll') runEnrollUrl(process.argv[2])
    else runConnectUrl(process.argv[2])
  } catch (error) {
    const message = /^LOCAL_PLUGIN_CONNECT_[A-Z_]+$/u.test(error?.message) ? error.message : 'LOCAL_PLUGIN_CONNECT_FAILED'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
