#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadOrCreateInstallationIdentity } from '../mcp/installation-identity.mjs'
import { assertKeychainHelperReady, installationIdentityStore } from '../mcp/keychain-credential.mjs'
import { validateLoginTarget } from './login-local-macos.mjs'

const fail = () => { throw new Error('LOCAL_PLUGIN_ENROLL_FAILED') }

export async function enrollLocalMac({ baseUrl, workspaceId, accountId, store, fetchImpl = fetch, openBrowser, now = Date.now }) {
  const target = validateLoginTarget(baseUrl, workspaceId)
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(accountId ?? '')) fail()
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function'
    || typeof openBrowser !== 'function') fail()
  let identity = store.load()
  if (identity !== undefined) {
    if (identity?.platform !== 'macos' || !identity.installation_id || !identity.key_id) fail()
    if (!identity.pending_pairing || Date.parse(identity.pending_pairing.expires_at) <= now()
      || identity.pending_pairing.workspace_id !== workspaceId) fail()
  } else {
    let generated
    loadOrCreateInstallationIdentity({ platform: 'macos', load: () => undefined, save: value => { generated = value } })
    const response = await fetchImpl(`${target.apiOrigin}/v1/auth/local-plugin/install-instances/register`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ platform: 'macos', installation_public_key_spki: generated.installation_public_key_spki }),
    })
    if (!response.ok) { await response.body?.cancel(); fail() }
    let payload
    try {
      const reader = response.body?.getReader()
      if (!reader) fail()
      const parts = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 16 * 1024) fail()
        parts.push(Buffer.from(value))
      }
      payload = JSON.parse(Buffer.concat(parts).toString('utf8')).data
    } catch { fail() }
    if (!/^[0-9a-f-]{36}$/iu.test(payload?.installation_id ?? '')
      || payload?.key_id !== generated.key_id
      || payload?.platform !== 'macos'
      || !/^[A-Za-z0-9_-]{43}$/u.test(payload?.pairing_token ?? '')
      || !Number.isFinite(Date.parse(payload?.pairing_expires_at))
      || Date.parse(payload.pairing_expires_at) <= now()) fail()
    identity = { ...generated, installation_id: payload.installation_id,
      pending_pairing: { token: payload.pairing_token, expires_at: payload.pairing_expires_at, workspace_id: workspaceId } }
    store.save(identity)
  }
  const pair = { installation_id: identity.installation_id, pairing_token: identity.pending_pairing.token,
    workspace_id: workspaceId, expires_at: identity.pending_pairing.expires_at }
  const fragment = Buffer.from(JSON.stringify(pair)).toString('base64url')
  await openBrowser(`${target.apiOrigin}/#plugin_pair=${fragment}`)
  return { ok: true, installation_id: identity.installation_id, workspace_id: workspaceId, pairing_started: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (process.platform !== 'darwin' || args.length !== 6 || args[0] !== '--base-url' || args[2] !== '--workspace' || args[4] !== '--account-id') fail()
    assertKeychainHelperReady()
    const result = await enrollLocalMac({ baseUrl: args[1], workspaceId: args[3], accountId: args[5],
      store: installationIdentityStore(args[1], { accountId: args[5], workspaceId: args[3] }),
      openBrowser: url => execFileSync('/usr/bin/open', [url], { stdio: 'ignore', timeout: 5000 }),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch { process.stderr.write('LOCAL_PLUGIN_ENROLL_FAILED\n'); process.exitCode = 1 }
}
