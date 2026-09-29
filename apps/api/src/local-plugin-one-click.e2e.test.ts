import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryLocalPluginConnectionRepository } from '../../../packages/persistence/src/local-plugin-connection-repository.js'
import { MemoryLocalPluginInstallInstanceRepository } from '../../../packages/persistence/src/local-plugin-install-instance-repository.js'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
// @ts-expect-error Native Node installer module intentionally has no build step.
import { enrollLocalMac } from '../../plugin/scripts/enroll-local-macos.mjs'
// @ts-expect-error Native Node installer module intentionally has no build step.
import { loginLocalPlugin } from '../../plugin/scripts/login-local-macos.mjs'
// @ts-expect-error Native Node installer module intentionally has no build step.
import { signInstallationTranscript } from '../../plugin/mcp/installation-identity.mjs'
import { server, workspaceMembers, setPasswordAuthRepositoryForTests,
  setLocalPluginConnectionRepositoryForTests, setLocalPluginInstallInstanceRepositoryForTests } from './server.js'

afterEach(async () => {
  if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  setPasswordAuthRepositoryForTests()
  setLocalPluginConnectionRepositoryForTests()
  setLocalPluginInstallInstanceRepositoryForTests()
  vi.unstubAllEnvs()
})

it('pairs a local installation, signs its browser authorization and exchanges a real one-time code', async () => {
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
  vi.stubEnv('LOCAL_PLUGIN_ONE_CLICK_ENABLED', 'true')
  const auth = new MemoryPasswordAuthRepository()
  const connections = new MemoryLocalPluginConnectionRepository()
  const installations = new MemoryLocalPluginInstallInstanceRepository()
  setPasswordAuthRepositoryForTests(auth)
  setLocalPluginConnectionRepositoryForTests(connections)
  setLocalPluginInstallInstanceRepositoryForTests(installations)
  const workspaceId = `ws_one_click_${Date.now()}`
  const login = `one-click-${Date.now()}@example.test`
  const password = 'OneClickBrowser1234!'
  const account = await auth.createMerchantAccount({ login, password, enterpriseName: 'One Click',
    contactName: 'Owner', workspaceIds: [workspaceId], actorId: 'platform-operator', reason: 'one-click browser test' })
  await workspaceMembers.upsert({ workspaceId, externalSubject: login, displayName: login,
    role: 'workspace_owner', status: 'active', invitedBy: 'one-click-browser-test' })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('API did not bind')
  const base = `http://127.0.0.1:${address.port}`
  let identity: Record<string, any> | undefined
  let pairingUrl = ''
  await enrollLocalMac({ baseUrl: base, workspaceId, accountId: account.id,
    store: { load: () => identity, save: (value: Record<string, any>) => { identity = value } },
    openBrowser: (url: string) => { pairingUrl = url },
  })
  expect(identity?.installation_id).toBeTruthy()
  expect(pairingUrl).toContain('#plugin_pair=')
  const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password, account_type: 'merchant' }) })
  expect(logged.status).toBe(200)
  const cookie = logged.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Merchant session missing')
  const executablePath = [process.env.CHROME_BIN, chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find(path => path && existsSync(path))
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  try {
    const context = await browser.newContext()
    await context.addCookies([{ name: cookie.split('=')[0]!, value: cookie.split('=').slice(1).join('='),
      domain: '127.0.0.1', path: '/' }])
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    await page.goto(`${base}/v1/auth/session`)
    const pairing = JSON.parse(Buffer.from(pairingUrl.split('#plugin_pair=')[1]!, 'base64url').toString())
    const paired = await page.evaluate(async input => {
      const response = await fetch('/v1/auth/local-plugin/install-instances/pair', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      return { status: response.status, body: await response.json() }
    }, pairing)
    expect(paired).toMatchObject({ status: 200, body: { data: { installation_id: identity!.installation_id, paired: true } } })
    const created = await page.evaluate(async input => {
      const response = await fetch('/v1/auth/local-plugin/connect-requests', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      })
      return { status: response.status, body: await response.json() }
    }, { workspace_id: workspaceId, installation_id: identity!.installation_id })
    expect(created.status).toBe(201)
    const request = created.body.data as Record<string, string>
    if (!request.request_id) throw new Error('Connect request id missing')
    expect(request.account_id).toBe(account.id)
    const statusPath = `/v1/auth/local-plugin/connect-requests/${encodeURIComponent(request.request_id)}/status?workspace_id=${encodeURIComponent(workspaceId)}`
    const beforeBinding = await page.evaluate(async path => (await (await fetch(path)).json()).data, statusPath)
    expect(beforeBinding).toMatchObject({ status: 'pending' })
    expect(beforeBinding.local_binding_complete).not.toBe(true)
    let stored = false
    const result = await loginLocalPlugin({ baseUrl: base, workspaceId, requestId: request.request_id,
      createInstallationProof: ({ codeChallenge, redirectUri }: { codeChallenge: string; redirectUri: string }) => {
        const clientNonce = randomBytes(32).toString('base64url')
        const transcript = { method: 'POST', path: '/v1/auth/local-plugin/authorize', apiOrigin: base,
          requestId: request.request_id, challengeId: request.challenge_id, accountId: request.account_id,
          workspaceId, installationId: identity!.installation_id, keyId: identity!.key_id, platform: 'macos',
          pkceChallenge: codeChallenge, redirectUri, clientNonce, serverNonce: request.server_nonce,
          issuedAt: request.challenge_issued_at, expiresAt: request.challenge_expires_at }
        return { installationId: identity!.installation_id, challengeId: request.challenge_id,
          signature: signInstallationTranscript(identity, transcript), clientNonce,
          serverNonce: request.server_nonce, issuedAt: request.challenge_issued_at,
          expiresAt: request.challenge_expires_at }
      },
      openBrowser: async (url: string) => {
        await page.goto(url)
        expect(await page.getByText(login).count()).toBeGreaterThan(0)
        await page.getByRole('button', { name: '确认授权本地插件' }).click()
      },
      storeCredential: (_target: unknown, bundle: { workspace_id: string }) => {
        expect(bundle.workspace_id).toBe(workspaceId)
        stored = true
      }, configureSession: () => {}, timeoutMs: 10_000,
    })
    expect(result).toMatchObject({ ok: true, workspace_id: workspaceId })
    expect(stored).toBe(true)
    expect(await connections.getForAccount({ id: request.request_id, accountId: account.id, workspaceId })).toMatchObject({ status: 'exchanged' })
    expect(installations.auditEvents.map(event => event.eventType)).toContain('auth.local_plugin_challenge_verified')
    expect(installations.auditEvents.map(event => event.eventType)).toContain('auth.local_plugin_local_binding_completed')
    await page.goto(`${base}/v1/auth/session`)
    const afterBinding = await page.evaluate(async path => (await (await fetch(path)).json()).data, statusPath)
    expect(afterBinding).toMatchObject({ status: 'exchanged', local_binding_complete: true })
  } finally { await browser.close() }
}, 30_000)
