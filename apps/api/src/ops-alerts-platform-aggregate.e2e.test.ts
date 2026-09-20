import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationalAlertsForTests, server, service, workspaceMembers } from './server.js'

type Envelope<T> = {
  workspace_id: string
  data: { jsonrpc: string; id: string; result: T } | null
  error: { code: string; message?: string; details?: Record<string, unknown> } | null
}

/** Exactly the platform aggregate envelope `ops.alerts.list` returns. */
type PlatformAlertAggregate = {
  items: Array<{ platform?: string }>
  aggregate: boolean
  truncated: boolean
  workspaceCount: number
  failedWorkspaceCount: number
  partial: boolean
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function configurePlatformOpsMember(input: { token: string; workspaceId: string; actorId: string }) {
  await workspaceMembers.upsert({ workspaceId: input.workspaceId, externalSubject: input.actorId, displayName: input.actorId, role: 'platform_ops', status: 'active', invitedBy: 'ops-alert-aggregate-test' })
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
    [input.token]: { workspaces: [input.workspaceId], actor_id: input.actorId, roles: ['platform_ops'], workbenches: ['platform'] },
  }))
}

beforeEach(() => vi.stubEnv('SESSION_ID_HASH_SECRET', 'test-session-hash-secret'))

afterEach(async () => {
  vi.restoreAllMocks()
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('platform alert aggregate degradation marker', () => {
  it('names the tenant whose alert evaluation was swallowed instead of collapsing into "no alerts"', async () => {
    const workspaceId = `ws_alert_aggregate_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configurePlatformOpsMember({ token: 'platform-alert-token', workspaceId, actorId: 'platform-alert-actor' })
    // A revoked OAuth token is one of the derivations `syncOperationalAlerts`
    // performs over the tenant projection, so it is guaranteed to produce an
    // alert on a healthy sync.
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `alert-taobao-${Date.now()}`, credentialRef: 'vault://alert-aggregate/taobao' }).tokenState = 'revoked'
    const base = await start()
    const call = () => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-alert-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ops.alerts.list', method: 'ops.alerts.list', params: { workspace_id: workspaceId, platform_scope: 'platform' } }),
    }).then(response => response.json() as Promise<Envelope<PlatformAlertAggregate>>)

    // Control: a healthy tenant's alert is present and the aggregate says so.
    const healthy = await call()
    expect(healthy.error).toBeNull()
    expect(healthy.data?.result?.partial).toBe(false)
    expect(healthy.data?.result?.failedWorkspaceCount).toBe(0)
    expect(healthy.data?.result?.items.map(item => item.platform)).toContain('taobao')

    // A second tenant-local alert that has never been persisted: the jd account
    // is registered after the taobao alert was already written to the stream.
    service.registerPlatformAccount({ workspaceId, platform: 'jd', remoteAccountId: `alert-jd-${Date.now()}`, credentialRef: 'vault://alert-aggregate/jd' }).tokenState = 'revoked'

    // Probe: the tenant's alert upsert fails the way a transient DB error does.
    // `syncOperationalAlerts` throws, the aggregate falls back to the persisted
    // stream, and the round's new alert is dropped.
    const upsert = vi.spyOn(operationalAlertsForTests, 'upsert').mockImplementation(async () => { throw new Error('SIMULATED_ALERT_UPSERT_FAILURE') })
    const degraded = await call()
    upsert.mockRestore()

    expect(degraded.error, 'the platform aggregate must still answer when one tenant fails').toBeNull()
    const result = degraded.data?.result
    expect(result).toBeDefined()
    // The fallback stream is still readable…
    expect(result!.items.map(item => item.platform)).toContain('taobao')
    // …but the failed tenant's new alert is gone, so the read is incomplete.
    expect(result!.items.map(item => item.platform)).not.toContain('jd')
    // The marker is what makes that incompleteness visible. Without it this
    // payload is identical to a healthy read of a tenant that has no jd alert.
    expect(result).toMatchObject({ aggregate: true, workspaceCount: 1, failedWorkspaceCount: 1, partial: true })

    // Recovery: the same alert reappears once the tenant's sync succeeds, and
    // the marker clears instead of sticking like a permanent warning.
    const recovered = await call()
    expect(recovered.error).toBeNull()
    expect(recovered.data?.result?.items.map(item => item.platform)).toContain('jd')
    expect(recovered.data?.result).toMatchObject({ failedWorkspaceCount: 0, partial: false })
  })
})
