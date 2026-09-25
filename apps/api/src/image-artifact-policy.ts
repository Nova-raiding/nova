import { DomainError } from '../../../packages/application/src/service.js'
import { assertOutboundUrl } from '../../../packages/connectors/src/outbound-security.js'
import { reviewProductImages } from '../../../packages/review/src/review.js'

export function reviewProductImagesForMcp(images: readonly string[] | undefined) {
  return reviewProductImages(images)
}

export function parseImageListForMcp(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const raw = value.trim()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed.map(item => item.trim()).filter(Boolean)
    }
  } catch {
    // Keep accepting the original comma-separated form for ordinary URLs.
  }
  // A data URI contains a comma between its media type and payload. Split only
  // at the boundary between multiple data URIs so Codex cannot turn one image
  // into IMAGE_URL_INVALID fragments during review.
  if (/^data:image\//iu.test(raw)) return raw.split(/,(?=data:image\/)/iu).map(item => item.trim()).filter(Boolean)
  return raw.split(',').map(item => item.trim()).filter(Boolean)
}

export const GENERATED_IMAGE_MIME = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'],
])
export const MAX_ARCHIVED_IMAGE_BYTES = 15 * 1024 * 1024

function imageArtifactAllowedHosts(): readonly string[] | undefined {
  const configured = (process.env.IMAGE_ARTIFACT_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  if (configured.length) return configured
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') throw new DomainError('IMAGE_ARTIFACT_ALLOWLIST_MISSING', '生产环境必须配置图片 artifact 域名白名单', 503)
  return undefined
}

// DashScope image artifacts are served from short-lived OSS URLs whose bucket
// names can rotate. Alibaba documents the host shape rather than a stable list
// of bucket names, so validate that narrow shape and then allow only the exact
// host observed on this request. This keeps the SSRF allowlist fail-closed
// without trusting all of aliyuncs.com.
export function trustedDashScopeImageArtifactHost(raw: string): string | undefined {
  let host: string
  try { host = new URL(raw).hostname.toLowerCase().replace(/\.$/u, '') } catch { return undefined }
  return /^dashscope-[a-z0-9-]{1,96}\.oss-(?:accelerate|cn-[a-z0-9-]{1,48})\.aliyuncs\.com$/u.test(host) ? host : undefined
}

const ARTIFACT_DOWNLOAD_TIMEOUT_MS = Math.max(1_000, Number(process.env.ARTIFACT_DOWNLOAD_TIMEOUT_MS ?? 30_000))

/**
 * Bound an outbound artifact download in time, not just in size. The byte caps
 * at the call sites limit memory, but a host that accepts the connection and
 * then stalls leaves `reader.read()` pending forever, holding the request, the
 * socket and any surrounding durable lease. `AbortSignal.timeout` also cancels
 * the response body stream, so a single signal covers connect, headers and body.
 */
export function artifactDownloadSignal() {
  return AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MS)
}

/** Map an aborted/stalled artifact download to a retryable gateway timeout. */
export function artifactDownloadFailure(error: unknown, message: string): never {
  if (error instanceof DomainError) throw error
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new DomainError('ARTIFACT_DOWNLOAD_TIMEOUT', `${message}（下载超时，请稍后重试）`, 504)
  throw error
}

export async function imageArtifactBody(raw: string): Promise<{ mimeType: string; body: Uint8Array }> {
  const configuredHosts = imageArtifactAllowedHosts()
  const trustedDynamicHost = trustedDashScopeImageArtifactHost(raw)
  const allowedHosts = trustedDynamicHost ? [...(configuredHosts ?? []), trustedDynamicHost] : configuredHosts
  await assertOutboundUrl(raw, { environment: process.env.NODE_ENV, allowedHosts, resolveDns: true })
  const response = await fetch(raw, { method: 'GET', headers: { accept: 'image/png, image/jpeg, image/webp' }, redirect: 'error', signal: artifactDownloadSignal() }).catch((error: unknown) => artifactDownloadFailure(error, '图片归档下载失败'))
  if (!response.ok || !response.body) throw new DomainError('IMAGE_ARTIFACT_DOWNLOAD_FAILED', `图片归档下载失败（HTTP ${response.status}）`, 502)
  const declaredSize = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ARCHIVED_IMAGE_BYTES) throw new DomainError('GENERATED_IMAGE_TOO_LARGE', '生成图片超过归档大小限制', 413)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read().catch((error: unknown) => artifactDownloadFailure(error, '图片归档下载失败'))
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_ARCHIVED_IMAGE_BYTES) throw new DomainError('GENERATED_IMAGE_TOO_LARGE', '生成图片超过归档大小限制', 413)
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  const mimeType = (response.headers.get('content-type')?.split(';', 1)[0] ?? '').trim().toLowerCase()
  if (!GENERATED_IMAGE_MIME.has(mimeType) || !generatedImageSignatureMatches(mimeType, body)) throw new DomainError('GENERATED_IMAGE_SIGNATURE_INVALID', '图片生成服务返回的 MIME 类型与文件内容不匹配', 502)
  return { mimeType, body }
}

export const MAX_ARCHIVED_VIDEO_BYTES = 50 * 1024 * 1024
let videoArtifactFetcherForTests: typeof fetch | undefined

function videoArtifactAllowedHosts(): readonly string[] | undefined {
  const configured = (process.env.VIDEO_ARTIFACT_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  if (configured.length) return configured
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') throw new DomainError('VIDEO_ARTIFACT_ALLOWLIST_MISSING', '生产环境必须配置视频 artifact 域名白名单', 503)
  return undefined
}

export async function assertVideoArtifactUrl(raw: string): Promise<void> {
  await assertOutboundUrl(raw, { environment: process.env.NODE_ENV, allowedHosts: videoArtifactAllowedHosts(), resolveDns: true })
}

export function setVideoArtifactFetcherForTests(fetcher?: typeof fetch) {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') throw new Error('VIDEO_ARCHIVE_RUNTIME_TEST_ONLY')
  videoArtifactFetcherForTests = fetcher
}

export function videoSignatureMatches(mimeType: string, body: Uint8Array) {
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') return body.length >= 12 && Buffer.from(body.slice(4, 8)).toString('ascii') === 'ftyp'
  if (mimeType === 'video/webm') return body.length >= 4 && body[0] === 0x1a && body[1] === 0x45 && body[2] === 0xdf && body[3] === 0xa3
  return false
}

export async function readBoundedVideoBody(response: Response, limit: number) {
  if (!response.body) throw new DomainError('VIDEO_ARTIFACT_BODY_MISSING', '视频 provider 响应没有可读取的二进制内容', 502)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read().catch((error: unknown) => artifactDownloadFailure(error, '视频归档下载失败'))
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) throw new DomainError('VIDEO_ARTIFACT_TOO_LARGE', '视频归档超过 50MB 限制', 413)
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

export function generatedImageSignatureMatches(mimeType: string, body: Uint8Array) {
  if (mimeType === 'image/png') return body.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => body[index] === value)
  if (mimeType === 'image/jpeg') return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
  if (mimeType === 'image/webp') return body.length >= 12 && Buffer.from(body.slice(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(body.slice(8, 12)).toString('ascii') === 'WEBP'
  return false
}


export function videoArtifactFetcherForTestsValue() { return videoArtifactFetcherForTests }
