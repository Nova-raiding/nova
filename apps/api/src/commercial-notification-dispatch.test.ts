import { describe, expect, it, vi } from 'vitest'
import { handleInternalRuntimeRoute } from './http-internal-runtime-routes.js'
import type { InternalRuntimeContext } from './server.js'

function fixture(input: Record<string, unknown> = {}) {
  const authorize = vi.fn(async () => undefined)
  const run = vi.fn(async () => ({ eventId: 'event', scanned: 200, delivered: 180, complete: false }))
  const send = vi.fn()
  const context = {
    req: { method: 'POST' }, res: {}, path: '/v1/internal/commercial/notifications/tick',
    requireWorkerAuthorization: authorize, headerRequired: () => 'ws',
    runCommercialNotifications: run, body: async () => input, send,
  } as unknown as InternalRuntimeContext
  return { context, authorize, run, send }
}

describe('signed publication notification dispatch', () => {
  it('returns bounded worker progress after authentication', async () => {
    const f = fixture()
    expect(await handleInternalRuntimeRoute(f.context)).toBe(true)
    expect(f.authorize).toHaveBeenCalledWith(f.context.req)
    expect(f.send).toHaveBeenCalledWith(f.context.res, 200, 'ws', {
      eventId: 'event', scanned: 200, delivered: 180, complete: false,
    }, null, f.context.req)
  })
  it('binds result dispatch to its authenticated workspace and rejects unknown modes', async () => {
    const f = fixture({ notification_kind: 'purchase_result' })
    await handleInternalRuntimeRoute(f.context)
    expect(f.run).toHaveBeenCalledWith('purchase_result', 'ws')
    const invalid = fixture({ notification_kind: 'made_up' })
    await expect(handleInternalRuntimeRoute(invalid.context)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(invalid.run).not.toHaveBeenCalled()
  })
  it('does not claim or dispatch notifications when signing fails', async () => {
    const f = fixture()
    f.authorize.mockRejectedValueOnce(new Error('invalid worker proof'))
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toThrow('invalid worker proof')
    expect(f.run).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })
  it('propagates durable worker failures without acknowledging success', async () => {
    const f = fixture()
    f.run.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(handleInternalRuntimeRoute(f.context)).rejects.toThrow('database unavailable')
    expect(f.send).not.toHaveBeenCalled()
  })
})
