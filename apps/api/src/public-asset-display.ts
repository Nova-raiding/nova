import { createHash, createHmac } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, isUsableAssetWithoutScan, type AssetMetadata } from '../../../packages/application/src/service.js'
import { ObjectStorageError } from '../../../packages/storage/src/index.js'

const SIGNED_ASSET_URL_TTL_SECONDS = 300

type StoredAsset = {
  body: Uint8Array
  metadata: { sha256: string; sizeBytes: number; contentType: string }
}

export function createPublicAssetDisplayHelpers(runtime: {
  isProduction(): boolean
  demoUnscannedAssetsEnabled(): boolean
  assetForWorkspace(workspaceId: string, assetId: string): AssetMetadata
  safeEqual(left: string, right: string): boolean
  enforceRateLimit(req: IncomingMessage, workspaceId: string): Promise<void>
  hydrateWorkspace(workspaceId: string): Promise<void>
  getStoredObjectWithRetry(workspaceId: string, storageKey: string, options?: { includeQuarantine?: boolean }): Promise<StoredAsset>
  sendAssetDownload(res: ServerResponse, asset: { name: string; mimeType: string; sizeBytes: number }, stored: StoredAsset, req?: IncomingMessage): void
}) {
  const { isProduction, demoUnscannedAssetsEnabled, assetForWorkspace, safeEqual, enforceRateLimit, hydrateWorkspace, getStoredObjectWithRetry, sendAssetDownload } = runtime

  function assetDisplayUrlConfig() {
    const secret = process.env.ASSET_DISPLAY_URL_SIGNING_SECRET?.trim() ?? ''
    const activeKid = process.env.ASSET_DISPLAY_URL_SIGNING_KEY_ID?.trim() || 'primary'
    const rawBaseUrl = process.env.PUBLIC_ASSET_BASE_URL?.trim() ?? ''
    if (!secret || !rawBaseUrl) {
      if (isProduction()) throw new DomainError('ASSET_DISPLAY_URL_NOT_CONFIGURED', '生产图片展示域名或签名密钥未配置，已阻止生成可公开读取的图片地址', 503)
      return undefined
    }
    if (secret.length < 32) throw new DomainError('ASSET_DISPLAY_URL_SIGNING_SECRET_WEAK', '图片展示签名密钥长度不足，已阻止签发', 503)
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(activeKid)) throw new DomainError('ASSET_DISPLAY_URL_SIGNING_KEY_ID_INVALID', '图片展示签名密钥标识无效，已阻止签发', 503)
    const verificationKeys = new Map<string, string>([[activeKid, secret]])
    const rawPreviousKeys = process.env.ASSET_DISPLAY_URL_PREVIOUS_KEYS_JSON?.trim()
    if (rawPreviousKeys) {
      let parsed: unknown
      try { parsed = JSON.parse(rawPreviousKeys) } catch { throw new DomainError('ASSET_DISPLAY_URL_PREVIOUS_KEYS_INVALID', '图片展示历史验签密钥配置无效，已阻止签发', 503) }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DomainError('ASSET_DISPLAY_URL_PREVIOUS_KEYS_INVALID', '图片展示历史验签密钥配置无效，已阻止签发', 503)
      for (const [kid, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9._-]{1,64}$/u.test(kid) || typeof value !== 'string' || value.trim().length < 32 || kid === activeKid) throw new DomainError('ASSET_DISPLAY_URL_PREVIOUS_KEYS_INVALID', '图片展示历史验签密钥配置无效，已阻止签发', 503)
        verificationKeys.set(kid, value.trim())
      }
    }
    let baseUrl: URL
    try { baseUrl = new URL(rawBaseUrl) } catch { throw new DomainError('PUBLIC_ASSET_BASE_URL_INVALID', '图片展示基础地址无效，已阻止签发', 503) }
    const localHttp = baseUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(baseUrl.hostname) && !isProduction()
    if (baseUrl.protocol !== 'https:' && !localHttp) throw new DomainError('PUBLIC_ASSET_BASE_URL_INSECURE', '图片展示基础地址必须使用 HTTPS', 503)
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || !['', '/'].includes(baseUrl.pathname)) throw new DomainError('PUBLIC_ASSET_BASE_URL_INVALID', '图片展示基础地址不能包含凭据、路径或查询参数', 503)
    if (isProduction()) {
      const allowedHosts = (process.env.ASSET_DISPLAY_ALLOWED_HOSTS ?? process.env.MERCHANT_BEARER_HOSTNAME ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
      if (!allowedHosts.length || !allowedHosts.includes(baseUrl.hostname.toLowerCase())) throw new DomainError('PUBLIC_ASSET_BASE_URL_HOST_NOT_ALLOWED', '图片展示域名不在生产允许列表，已阻止签发', 503)
    }
    return { secret, activeKid, verificationKeys, baseUrl }
  }

  function signedAssetCanonical(path: string, workspaceId: string, assetId: string, expires: number, sha256: string, version?: string, kid?: string) {
    return version && kid ? `${version}\n${kid}\nGET\n${path}\n${workspaceId}\n${assetId}\n${expires}\n${sha256}` : `GET\n${path}\n${workspaceId}\n${assetId}\n${expires}\n${sha256}`
  }

  function signedAssetDisplayUrl(workspaceId: string, assetId: string) {
    const config = assetDisplayUrlConfig()
    if (!config) return undefined
    const asset = assetForWorkspace(workspaceId, assetId)
    if (!isUsableAssetWithoutScan(asset, demoUnscannedAssetsEnabled())) throw new DomainError('QUARANTINE_ACCESS_DENIED', '素材尚不可用，已阻止签发图片地址', 403)
    const path = `/v1/public/assets/${encodeURIComponent(asset.id)}/display`
    const expires = Math.floor(Date.now() / 1000) + SIGNED_ASSET_URL_TTL_SECONDS
    const version = '1'
    const signature = createHmac('sha256', config.secret).update(signedAssetCanonical(path, workspaceId, asset.id, expires, asset.sha256, version, config.activeKid)).digest('base64url')
    const url = new URL(path, config.baseUrl)
    url.searchParams.set('v', version); url.searchParams.set('kid', config.activeKid); url.searchParams.set('workspace_id', workspaceId); url.searchParams.set('expires', String(expires)); url.searchParams.set('sha256', asset.sha256); url.searchParams.set('signature', signature)
    return url.toString()
  }

  async function serveSignedAssetDisplay(req: IncomingMessage, res: ServerResponse, url: URL, assetId: string) {
    const config = assetDisplayUrlConfig()
    if (!config) throw new DomainError('ASSET_DISPLAY_URL_NOT_CONFIGURED', '图片展示签名服务未配置', 503)
    const workspaceId = url.searchParams.get('workspace_id')?.trim() ?? ''
    const sha256 = url.searchParams.get('sha256')?.trim().toLowerCase() ?? ''
    const signature = url.searchParams.get('signature')?.trim() ?? ''
    const version = url.searchParams.get('v')?.trim() ?? ''
    const kid = url.searchParams.get('kid')?.trim() ?? ''
    const expires = Number(url.searchParams.get('expires'))
    const now = Math.floor(Date.now() / 1000)
    if (!workspaceId || !/^[a-f0-9]{64}$/u.test(sha256) || !Number.isSafeInteger(expires) || expires < now || expires > now + SIGNED_ASSET_URL_TTL_SECONDS + 30) throw new DomainError('ASSET_DISPLAY_URL_EXPIRED_OR_INVALID', '图片地址无效或已过期，请在对话中重新读取', 403)
    const path = `/v1/public/assets/${encodeURIComponent(assetId)}/display`
    if ((version || kid) && (version !== '1' || !kid)) throw new DomainError('ASSET_DISPLAY_URL_SIGNATURE_VERSION_INVALID', '图片地址签名版本无效', 403)
    const verificationSecret = version === '1' ? config.verificationKeys.get(kid) : config.secret
    if (!verificationSecret) throw new DomainError('ASSET_DISPLAY_URL_SIGNING_KEY_UNKNOWN', '图片地址签名密钥已失效，请在对话中重新读取', 403)
    const expected = createHmac('sha256', verificationSecret).update(signedAssetCanonical(path, workspaceId, assetId, expires, sha256, version || undefined, kid || undefined)).digest('base64url')
    if (!signature || !safeEqual(signature, expected)) throw new DomainError('ASSET_DISPLAY_URL_SIGNATURE_INVALID', '图片地址签名无效', 403)
    await enforceRateLimit(req, workspaceId)
    await hydrateWorkspace(workspaceId)
    const asset = assetForWorkspace(workspaceId, assetId)
    if (!isUsableAssetWithoutScan(asset, demoUnscannedAssetsEnabled()) || asset.sha256 !== sha256) throw new DomainError('ASSET_DISPLAY_SNAPSHOT_MISMATCH', '图片快照已变化，请在对话中重新读取', 409)
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType.toLowerCase())) throw new DomainError('ASSET_DISPLAY_MIME_NOT_ALLOWED', '该素材类型不能通过图片展示地址读取', 415)
    let stored: StoredAsset
    try { stored = await getStoredObjectWithRetry(workspaceId, asset.storageKey, { includeQuarantine: asset.scanStatus === 'unscanned' && demoUnscannedAssetsEnabled() }) } catch (error) {
      if (error instanceof ObjectStorageError && error.code === 'OBJECT_NOT_FOUND') throw new DomainError('ASSET_BINARY_UNAVAILABLE', '图片文件不可用，请重新生成', 410)
      throw error
    }
    const storedDigest = createHash('sha256').update(stored.body).digest('hex')
    if (stored.metadata.sha256 !== asset.sha256 || stored.metadata.sizeBytes !== asset.sizeBytes || stored.metadata.contentType.toLowerCase() !== asset.mimeType.toLowerCase() || storedDigest !== asset.sha256) throw new DomainError('ASSET_BINARY_INTEGRITY_FAILED', '图片对象与已扫描快照不一致，已阻止展示', 409)
    return sendAssetDownload(res, asset, stored, req)
  }

  return { signedAssetDisplayUrl, serveSignedAssetDisplay }
}
