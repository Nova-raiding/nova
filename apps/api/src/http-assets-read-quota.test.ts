import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { routeAssetHttp } from './http-asset-routes.js'

const workspaceId = 'ws_assets_read_quota'

function runtime(effectiveStorageQuotaSnapshot: () => Promise<unknown>, options: {
  assets?: Array<Record<string, unknown>>
  accessibleAssetIds?: () => Promise<ReadonlySet<string> | undefined>
} = {}) {
  const assets = options.assets ?? [
  { id: 'asset_visible', name: 'visible.png', workspaceId, mimeType: 'image/png', sizeBytes: 4 },
  { id: 'asset_hidden', name: 'hidden.png', workspaceId, mimeType: 'image/png', sizeBytes: 8 },
  ]
  const send = vi.fn((_res: ServerResponse, status: number, _workspaceId: string, data: unknown, error: unknown) => ({ status, data, error }))
  const listAssets = vi.fn(() => assets)
  const putQuarantineObject = vi.fn()
  const executeDurableAssetParse = vi.fn()
  const req = { method: 'GET' } as IncomingMessage
  const res = {} as ServerResponse
  const runtime = {
    DomainError,
    ObjectStorageError: class extends Error {},
    ERROR_CODES: { INVALID_REQUEST: 'INVALID_REQUEST' },
    demoUnscannedAssetsEnabled: () => false,
    SUPPORTED_PLATFORMS: [],
    service: { listAssets },
    persistence: {},
    configuredAssetLimit: () => 100,
    configuredStorageQuotaLimit: () => 123456,
    effectiveStorageQuotaSnapshot,
    accessibleAssetIds: options.accessibleAssetIds ?? vi.fn(async () => new Set(['asset_visible'])),
    assetDisplayProjection: () => ({ status: 'ready' }),
    resolveWorkspace: () => workspaceId,
    putQuarantineObject,
    executeDurableAssetParse,
    send,
  } as never
  return { req, res, runtime, send, listAssets, putQuarantineObject, executeDurableAssetParse }
}

async function getAssets(effectiveStorageQuotaSnapshot: () => Promise<unknown>, paginated = false) {
  const context = runtime(effectiveStorageQuotaSnapshot)
  const url = new URL(`http://localhost/v1/assets${paginated ? '?limit=10' : ''}`)
  await routeAssetHttp(context.req, context.res, '/v1/assets', url, context.runtime)
  return context.send.mock.results[0]?.value as { status: number; data: any; error: unknown }
}

describe('GET /v1/assets when storage quota evidence cannot be resolved', () => {
  it.each([
    ['missing entitlement', 'COMMERCIAL_ENTITLEMENT_REQUIRED', 402],
    ['unavailable entitlement', 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE', 503],
    ['overlapping entitlements', 'COMMERCIAL_ENTITLEMENT_AMBIGUOUS', 409],
    ['unknown storage usage', 'STORAGE_QUOTA_USAGE_UNAVAILABLE', 503],
  ])('keeps ACL-filtered asset data readable for %s', async (_label, code, status) => {
    const unavailable = async () => { throw new DomainError(code, 'quota evidence unavailable', status) }
    const result = await getAssets(unavailable)

    expect(result.status).toBe(200)
    expect(result.error).toBeNull()
    expect(result.data).toEqual([
      expect.objectContaining({ id: 'asset_visible', name: 'visible.png' }),
    ])

    const paginated = await getAssets(unavailable, true)
    expect(paginated.status).toBe(200)
    expect(paginated.data).toMatchObject({ total: 1, items: [expect.objectContaining({ id: 'asset_visible', name: 'visible.png' })] })
    expect(paginated.data).not.toHaveProperty('storage_quota')
  })

  it('still propagates unrelated and untyped failures', async () => {
    await expect(getAssets(async () => { throw new DomainError('DATABASE_UNAVAILABLE', 'db down', 503) })).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' })
    await expect(getAssets(async () => { throw Object.assign(new Error('unexpected'), { code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' }) })).rejects.toMatchObject({ message: 'unexpected' })
  })

  it('does not invent a configured quota when the usage snapshot is absent', async () => {
    const result = await getAssets(async () => undefined, true)
    expect(result.status).toBe(200)
    expect(result.data).not.toHaveProperty('storage_quota')
  })

  it('returns the authoritative quota when available and performs no upload or parse work', async () => {
    const context = runtime(async () => ({ limitBytes: 100, usedBytes: 40, reservedBytes: 10 }))
    const url = new URL('http://localhost/v1/assets?limit=10')
    await routeAssetHttp(context.req, context.res, '/v1/assets', url, context.runtime)
    const response = context.send.mock.results[0]?.value as { status: number; data: any; error: unknown }

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ storage_quota: { limitBytes: 100, usedBytes: 40, reservedBytes: 10, availableBytes: 50 } })
    expect(context.putQuarantineObject).not.toHaveBeenCalled()
    expect(context.executeDurableAssetParse).not.toHaveBeenCalled()
  })

  it('propagates ACL denial before consulting quota or listing assets', async () => {
    const quota = vi.fn(async () => ({ limitBytes: 100, usedBytes: 0, reservedBytes: 0 }))
    const access = vi.fn(async () => { throw new DomainError('FORBIDDEN', 'asset scope denied', 403) })
    const context = runtime(quota, { accessibleAssetIds: access })

    await expect(routeAssetHttp(context.req, context.res, '/v1/assets', new URL('http://localhost/v1/assets'), context.runtime))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(access).toHaveBeenCalledOnce()
    expect(quota).not.toHaveBeenCalled()
    expect(context.listAssets).not.toHaveBeenCalled()
  })

  it.each(['?limit=0', '?limit=101', '?offset=-1', '?offset=1.5'])(
    'rejects invalid pagination %s without listing assets', async query => {
      const context = runtime(async () => ({ limitBytes: 100, usedBytes: 0, reservedBytes: 0 }))

      await expect(routeAssetHttp(
        context.req,
        context.res,
        '/v1/assets',
        new URL(`http://localhost/v1/assets${query}`),
        context.runtime,
      )).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })

      expect(context.listAssets).not.toHaveBeenCalled()
    },
  )
})
