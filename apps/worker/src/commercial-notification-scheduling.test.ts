import { describe, expect, it, vi } from 'vitest'
import { postCommercialNotificationTick, requireCommercialNotificationPollSuccess, runCommercialScheduledGrantDispatch, workerRoleForRequest, verifyCommercialWorkerMaintenanceSchema } from './main.js'
import { loadMigrations, migrationChecksum } from '../../../packages/persistence/src/migration.js'
import { createWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'
const input = { apiBaseUrl: 'https://worker-fixture.test/', apiToken: 'fixture-token', workspaceId: 'ws-fixture', signingSecret: 'fixture-signing-secret' }
describe('commercial notification signed worker callback', () => {
  it('binds reconcile proof to the actual method, target, workspace and body without sending signing secret', async () => {
    const fetcher: typeof fetch = async (url, init) => {
      expect(String(url)).toBe('https://worker-fixture.test/v1/internal/commercial/notifications/tick')
      expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error')
      const h = new Headers(init?.headers)
      expect(h.get('authorization')).toBe('Bearer fixture-token')
      expect(h.get('x-internal-worker-signing-secret')).toBeNull()
      const expected = createWorkerRequestProof({ secret: input.signingSecret, workerId: h.get('x-worker-id')!, role: 'reconcile', method: 'POST', requestTarget: '/v1/internal/commercial/notifications/tick', workspaceId: input.workspaceId, body: String(init?.body), timestampSeconds: Number(h.get('x-worker-timestamp')), nonce: h.get('x-worker-nonce')! })
      for (const [key, value] of Object.entries(expected.headers)) expect(h.get(key)).toBe(value)
      expect(JSON.parse(String(init?.body))).toEqual({ workspace_id: 'ws-fixture' })
      return Response.json({ data: { eventId: 'publication', scanned: 200, delivered: 199, complete: false } })
    }
    expect(await postCommercialNotificationTick({ ...input, fetcher })).toEqual({ eventId: 'publication', scanned: 200, delivered: 199, complete: false })
    expect(workerRoleForRequest('POST', '/v1/internal/commercial/notifications/tick')).toBe('reconcile')
  })
  it('binds purchase result mode to the signed request body and returns actual batch evidence', async () => {
    const fetcher: typeof fetch = async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ workspace_id: 'ws-fixture', notification_kind: 'purchase_result' })
      const headers = new Headers(init?.headers)
      const expected = createWorkerRequestProof({ secret: input.signingSecret, workerId: headers.get('x-worker-id')!, role: 'reconcile', method: 'POST', requestTarget: '/v1/internal/commercial/notifications/tick', workspaceId: input.workspaceId, body: String(init?.body), timestampSeconds: Number(headers.get('x-worker-timestamp')), nonce: headers.get('x-worker-nonce')! })
      for (const [key, value] of Object.entries(expected.headers)) expect(headers.get(key)).toBe(value)
      return Response.json({ data: { eventId: 'evt_result', scanned: 1, delivered: 1, complete: true } })
    }
    expect(await postCommercialNotificationTick({ ...input, notificationKind: 'purchase_result', fetcher })).toEqual({ eventId: 'evt_result', scanned: 1, delivered: 1, complete: true })
  })
  it('rejects missing signing configuration before any request', async () => {
    const fetcher = vi.fn()
    await expect(postCommercialNotificationTick({ ...input, signingSecret: undefined, fetcher })).rejects.toMatchObject({ code: 'COMMERCIAL_NOTIFICATION_WORKER_CONFIG_MISSING' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('reports authorization and service failures without inventing a successful tick', async () => {
    for (const status of [401, 403, 503]) await expect(postCommercialNotificationTick({ ...input, fetcher: async () => Response.json({ error: 'unavailable' }, { status }) })).rejects.toMatchObject({ code: 'COMMERCIAL_NOTIFICATION_WORKER_API_FAILED', status })
  })
  it('rejects missing or impossible result evidence including oversize fanout', async () => {
    for (const data of [{}, { scanned: 201, delivered: 1, complete: true }, { scanned: 0, delivered: 1, complete: true }, { scanned: 1, delivered: 1, complete: true }]) await expect(postCommercialNotificationTick({ ...input, fetcher: async () => Response.json({ data }) })).rejects.toMatchObject({ code: 'COMMERCIAL_NOTIFICATION_WORKER_RESULT_INVALID' })
  })
})
describe('onboarding and scheduled subscription dispatch in the same poll', () => {
  it('executes both durable executors, bounds each workspace at 100 and counts real partial failures', async () => {
    const onboarding = vi.fn(async ({ workspaceId, limit }: { workspaceId: string; limit: number }) => { expect(limit).toBe(100); if (workspaceId === 'ws-b') throw new Error('database unavailable'); return { dispatched: 2, expired: 1 } })
    const subscriptions = vi.fn(async ({ workspaceId, limit }: { workspaceId: string; limit: number }) => { expect(limit).toBe(100); return { dispatched: workspaceId === 'ws-b' ? 3 : 0, expired: 0, canceled: 1 } })
    const result = await runCommercialScheduledGrantDispatch({ workspaces: ['ws-a', 'ws-b', 'ws-a'], concurrency: 2, limit: 999, onboarding, subscriptions })
    expect(onboarding).toHaveBeenCalledTimes(2); expect(subscriptions).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ onboardingGrantDispatch: { completed: 1, failed: 1, dispatched: 2, expired: 1, canceled: 0 }, subscriptionGrantDispatch: { completed: 2, failed: 0, dispatched: 3, expired: 0, canceled: 2 } })
  })
  it('still runs subscription maintenance when the other executor throws synchronously', async () => {
    const subscriptions = vi.fn(async () => ({ dispatched: 1, expired: 0 }))
    expect(await runCommercialScheduledGrantDispatch({ workspaces: ['ws-a'], concurrency: 1, limit: 50, onboarding: () => { throw new Error('onboarding failure') }, subscriptions })).toMatchObject({ onboardingGrantDispatch: { failed: 1 }, subscriptionGrantDispatch: { completed: 1, dispatched: 1 } })
    expect(subscriptions).toHaveBeenCalledOnce()
  })
})

describe('commercial worker actual complete schema fence', () => {
  it('keeps all legacy bridge prefixes quiet without disabling old onboarding maintenance', async () => {
    const expectedMigrations = await loadMigrations()
    for (const observedVersion of [254, 255, 256, 257, 258, 259, 262]) {
      const query = vi.fn(async () => { throw new Error('new commercial schema must not be queried') })
      expect(await verifyCommercialWorkerMaintenanceSchema({ database: { query }, expectedMigrations, observedVersion, bridgeMode: 'prefix_256_or_257' })).toBe(false)
      expect(query).not.toHaveBeenCalled()
    }
    const onboarding = vi.fn(async () => ({ dispatched: 1, expired: 0 }))
    const result = await runCommercialScheduledGrantDispatch({ workspaces: ['ws-old'], concurrency: 1, limit: 10, onboarding })
    expect(onboarding).toHaveBeenCalledOnce()
    expect(result).toEqual({ onboardingGrantDispatch: { completed: 1, failed: 0, dispatched: 1, expired: 0, canceled: 0 }, subscriptionGrantDispatch: { completed: 0, failed: 0, dispatched: 0, expired: 0, canceled: 0 } })
  })
  it('requires the real complete checksum history, not a matching maximum version', async () => {
    const expectedMigrations = await loadMigrations()
    const rows = expectedMigrations.map(m => ({ version: m.version, name: m.name, checksum: migrationChecksum(m.sql) }))
    const observedVersion = expectedMigrations.at(-1)!.version
    expect(await verifyCommercialWorkerMaintenanceSchema({ database: { query: async () => ({ rows }) }, expectedMigrations, observedVersion })).toBe(true)
    await expect(verifyCommercialWorkerMaintenanceSchema({ database: { query: async () => ({ rows: [rows.at(-1)!] }) }, expectedMigrations, observedVersion })).rejects.toThrow('incomplete')
    await expect(verifyCommercialWorkerMaintenanceSchema({ database: { query: async () => ({ rows: rows.map((r,i) => i === 262 ? { ...r, checksum: 'a'.repeat(64) } : r) }) }, expectedMigrations, observedVersion })).rejects.toThrow()
  })
})

describe('commercial notification poll acknowledgement', () => {
  it('permits idle and fully delivered batches and a legacy poll without commercial maintenance', () => {
    expect(() => requireCommercialNotificationPollSuccess({})).not.toThrow()
    expect(() => requireCommercialNotificationPollSuccess({ commercialNotifications: { failed: 0 }, purchaseResultNotifications: { failed: 0 } })).not.toThrow()
  })
  it('rejects publication and result failures before readiness and poll success can be recorded', () => {
    for (const result of [{ commercialNotifications: { failed: 1 } }, { purchaseResultNotifications: { failed: 2 } }, { commercialNotifications: { failed: 1 }, purchaseResultNotifications: { failed: 2 } }]) {
      expect(() => requireCommercialNotificationPollSuccess(result)).toThrow('require retry')
      try { requireCommercialNotificationPollSuccess(result) } catch (error) { expect(error).toMatchObject({ code: 'COMMERCIAL_NOTIFICATION_POLL_FAILED' }) }
    }
  })
})
