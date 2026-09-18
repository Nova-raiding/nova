import { createHash } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { lookup as lookupDns } from 'node:dns/promises'
import type { IncomingMessage } from 'node:http'
import { Agent, request as requestHttps } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { DomainError } from '../../../packages/application/src/service.js'
import { classifyAssetUpload } from './asset-upload-security.js'
import { CUSTOMER_DELIVERY_UPLOAD_MAX_BYTES } from './customer-delivery-upload.js'

type DocumentMime = 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'image/png' | 'image/jpeg'
export interface DownloadedCustomerDeliveryContract {
  name: string
  mime_type: DocumentMime
  content_base64: string
  sha256: string
}
type PinnedAddress = { address: string; family: 4 | 6 }

const DEADLINE_MS = 40_000
const MAX_CONCURRENT_DOWNLOADS = 2
const extensions = new Map<DocumentMime, string>([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['image/png', 'png'], ['image/jpeg', 'jpg'],
])
const blockedV4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(address, prefix, 'ipv4')
// Azure's platform virtual IP is not a public file origin despite its address.
blockedV4.addAddress('168.63.129.16', 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const blockedV6 = new BlockList()
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]] as const) {
  blockedV6.addSubnet(address, prefix, 'ipv6')
}
let activeDownloads = 0
let activeDnsLookups = 0

const invalidUrl = () => new DomainError('CUSTOMER_DELIVERY_CONTRACT_URL_INVALID', '请填写不含账号、片段或特殊端口的公开 HTTPS 文件直链', 400)
const blockedUrl = () => new DomainError('CUSTOMER_DELIVERY_CONTRACT_URL_BLOCKED', '合同链接必须指向公开网络地址', 400)
const failedDownload = () => new DomainError('CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_FAILED', '合同文件下载失败，请检查直链是否可公开访问后重试', 502)
const busyDownload = () => new DomainError('CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_BUSY', '合同下载任务较多，请稍后重试', 503)
const unsupportedType = () => new DomainError('CUSTOMER_DELIVERY_UPLOAD_TYPE_UNSUPPORTED', '合同直链须返回与文件内容一致的 PDF、DOCX、PNG 或 JPEG，不支持网页或网盘预览页', 400)
const sizeLimit = () => new DomainError('CUSTOMER_DELIVERY_UPLOAD_SIZE_LIMIT', '每个交付文件须大于 0 字节且不超过 50 MiB', 413)
const cancelledDownload = () => new DomainError('CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_CANCELLED', '合同下载已取消', 499)

function assertPublicAddress(address: string, declaredFamily?: number): PinnedAddress {
  const family = isIP(address)
  if ((family !== 4 && family !== 6) || (declaredFamily !== undefined && family !== declaredFamily)
    || (family === 4 ? blockedV4.check(address, 'ipv4') : !globalV6.check(address, 'ipv6') || blockedV6.check(address, 'ipv6'))) throw blockedUrl()
  return { address, family }
}

function parseSource(sourceUrl: string): { url: URL; hostname: string; literal?: PinnedAddress } {
  if (typeof sourceUrl !== 'string' || !sourceUrl.trim() || sourceUrl.length > 2000
    || /[\u0000-\u0020\u007f-\u009f\\#]/u.test(sourceUrl) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(sourceUrl)) throw invalidUrl()
  let url: URL
  try { url = new URL(sourceUrl) } catch { throw invalidUrl() }
  const authority = sourceUrl.slice(sourceUrl.indexOf('//') + 2).split(/[/?#]/u, 1)[0] ?? ''
  if (url.protocol !== 'https:' || !sourceUrl.toLowerCase().startsWith('https://') || url.username || url.password || authority.includes('@')
    || url.hash || (url.port && url.port !== '443')) throw invalidUrl()
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (!hostname || hostname === 'localhost' || /\.(?:localhost|local|internal)$/u.test(hostname)) throw invalidUrl()
  // WHATWG URL normalizes decimal/octal/hex IPv4 forms before this check.
  return { url, hostname, ...(isIP(hostname) ? { literal: assertPublicAddress(hostname) } : {}) }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof DomainError ? signal.reason : cancelledDownload()
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof DomainError ? signal.reason : cancelledDownload())
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(value => { signal.removeEventListener('abort', onAbort); resolve(value) }, error => { signal.removeEventListener('abort', onAbort); reject(error) })
    if (signal.aborted) onAbort()
  })
}

async function resolvePinned(hostname: string, signal: AbortSignal): Promise<PinnedAddress> {
  // OS lookup cannot be cancelled. Keep its permit until it actually settles,
  // even if the user-facing deadline has elapsed, so stalled DNS cannot pile up.
  if (activeDnsLookups >= MAX_CONCURRENT_DOWNLOADS) throw busyDownload()
  activeDnsLookups++
  let pending: Promise<LookupAddress[]>
  try { pending = lookupDns(hostname, { all: true, verbatim: true }) } catch (error) { activeDnsLookups--; throw error }
  const answers = await abortable(pending.finally(() => { activeDnsLookups-- }), signal)
  throwIfAborted(signal)
  if (!Array.isArray(answers) || !answers.length) throw blockedUrl()
  const checked = answers.map(answer => assertPublicAddress(answer.address, answer.family))
  return checked[0]!
}

function pinnedLookup(hostname: string, pinned: PinnedAddress): LookupFunction {
  return (requestedHost, options, callback) => {
    if (requestedHost !== hostname) { callback(new Error('Unexpected pinned host'), '', 0); return }
    if (options.all) callback(null, [pinned])
    else callback(null, pinned.address, pinned.family)
  }
}

function responseType(response: IncomingMessage): { mime: DocumentMime; length?: number } {
  const encoding = response.headers['content-encoding']
  if (encoding !== undefined && (typeof encoding !== 'string' || encoding.trim().toLowerCase() !== 'identity')) throw failedDownload()
  const rawMime = response.headers['content-type']
  const mime = typeof rawMime === 'string' ? rawMime.split(';', 1)[0]!.trim().toLowerCase() as DocumentMime : undefined
  if (!mime || !extensions.has(mime)) throw unsupportedType()
  const rawLength = response.headers['content-length']
  if (rawLength === undefined) return { mime }
  if (typeof rawLength !== 'string' || !/^[0-9]+$/u.test(rawLength)) throw failedDownload()
  const length = Number(rawLength)
  if (!Number.isSafeInteger(length) || length <= 0 || length > CUSTOMER_DELIVERY_UPLOAD_MAX_BYTES) throw sizeLimit()
  return { mime, length }
}

async function receiveDocument(url: URL, hostname: string, pinned: PinnedAddress, signal: AbortSignal): Promise<DownloadedCustomerDeliveryContract> {
  // Never use globalAgent: Node can configure it from environment proxy flags.
  // A new agent also prevents reuse of a connection resolved for another URL.
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 })
  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      let response: IncomingMessage | undefined
      const finish = (error?: unknown, result?: DownloadedCustomerDeliveryContract) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        if (error) {
          request.destroy()
          response?.destroy()
          reject(error)
        } else resolve(result!)
      }
      const onAbort = () => finish(signal.reason instanceof DomainError ? signal.reason : cancelledDownload())
      const request = requestHttps({
        protocol: 'https:', hostname, port: 443, method: 'GET', path: `${url.pathname}${url.search}`,
        agent, lookup: pinnedLookup(hostname, pinned), family: pinned.family,
        // IP literals have no SNI; Node still performs its default IP identity
        // check. DNS names retain their original logical TLS identity.
        ...(isIP(hostname) ? {} : { servername: hostname }),
        rejectUnauthorized: true, maxHeaderSize: 16 * 1024, signal,
        headers: { Accept: [...extensions.keys()].join(', '), 'Accept-Encoding': 'identity' },
      }, incoming => {
        response = incoming
        if (settled) { incoming.destroy(); return }
        void (async () => {
          if (incoming.statusCode !== 200) {
            if (incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400) throw new DomainError('CUSTOMER_DELIVERY_CONTRACT_REDIRECT_REJECTED', '合同链接发生跳转，请使用最终文件的公开 HTTPS 直链', 400)
            throw failedDownload()
          }
          const { mime, length } = responseType(incoming)
          const chunks: Buffer[] = []
          let size = 0
          const hash = createHash('sha256')
          for await (const chunk of incoming) {
            throwIfAborted(signal)
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            size += bytes.length
            if (size > CUSTOMER_DELIVERY_UPLOAD_MAX_BYTES) throw sizeLimit()
            hash.update(bytes)
            chunks.push(bytes)
          }
          throwIfAborted(signal)
          if (!size) throw sizeLimit()
          if (!incoming.complete || (length !== undefined && size !== length)) throw failedDownload()
          const bytes = Buffer.concat(chunks, size)
          const sha256 = hash.digest('hex')
          const name = `contract-${sha256.slice(0, 16)}.${extensions.get(mime)!}`
          // The existing classifier checks extension/MIME/signature. DOCX is
          // ZIP-signature admission, not OOXML parsing or malware clearance.
          if (classifyAssetUpload({ fileName: name, declaredMime: mime, bytes }).decision !== 'allow') throw unsupportedType()
          return { name, mime_type: mime, content_base64: bytes.toString('base64'), sha256 }
        })().then(result => finish(undefined, result), error => finish(error))
      })
      request.on('error', error => finish(signal.aborted ? signal.reason : error))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      else request.end()
    })
  } finally { agent.destroy() }
}

/** Download only. Registration, quarantine, scanning, authorization and evidence
 * binding must remain in the existing customer-delivery upload caller. */
export async function downloadCustomerDeliveryContract(sourceUrl: string, options: { signal?: AbortSignal } = {}): Promise<DownloadedCustomerDeliveryContract> {
  const { url, hostname, literal } = parseSource(sourceUrl)
  if (options.signal?.aborted) throw cancelledDownload()
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) throw busyDownload()
  activeDownloads++
  const controller = new AbortController()
  const cancel = () => controller.abort(cancelledDownload())
  options.signal?.addEventListener('abort', cancel, { once: true })
  const deadline = setTimeout(() => controller.abort(new DomainError('CUSTOMER_DELIVERY_CONTRACT_DOWNLOAD_TIMEOUT', '合同下载超时，请使用可直接访问的文件链接后重试', 504)), DEADLINE_MS)
  try {
    throwIfAborted(controller.signal)
    const pinned = literal ?? await resolvePinned(hostname, controller.signal)
    throwIfAborted(controller.signal)
    return await receiveDocument(url, hostname, pinned, controller.signal)
  } catch (error) {
    if (error instanceof DomainError) throw error
    // Never expose upstream error messages: they can contain signed URLs.
    throw failedDownload()
  } finally {
    clearTimeout(deadline)
    options.signal?.removeEventListener('abort', cancel)
    activeDownloads--
  }
}
