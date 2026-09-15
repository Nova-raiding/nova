import { createHash } from 'node:crypto'

export type AssetSignatureClass =
  | 'pe'
  | 'elf'
  | 'mach_o'
  | 'shebang'
  | 'pdf'
  | 'zip'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'mp4'
  | 'webm'
  | 'svg'
  | 'postscript'
  | 'json'
  | 'text'
  | 'unknown'

export type AssetUploadReasonCode =
  | 'ASSET_INPUT_INVALID'
  | 'ASSET_SIZE_INVALID'
  | 'ASSET_FILENAME_CONTROL_CHARACTER'
  | 'ASSET_FILENAME_UNICODE_CONFUSABLE'
  | 'ASSET_FILENAME_PATH_UNSAFE'
  | 'ASSET_DOUBLE_EXTENSION_REJECTED'
  | 'ASSET_TYPE_UNSUPPORTED'
  | 'ASSET_DECLARED_MIME_INVALID'
  | 'ASSET_EXECUTABLE_REJECTED'
  | 'ASSET_EXTENSION_MIME_MISMATCH'
  | 'ASSET_EXTENSION_SIGNATURE_MISMATCH'
  | 'ASSET_MIME_SIGNATURE_MISMATCH'
  | 'ASSET_SVG_SCRIPT_REJECTED'
  | 'ASSET_SVG_EXTERNAL_REFERENCE_REJECTED'
  | 'ASSET_SVG_EVENT_HANDLER_REJECTED'
  | 'ASSET_SVG_FOREIGN_OBJECT_REJECTED'

export interface AssetUploadSecurityInput {
  fileName: string
  declaredMime: string
  bytes: Uint8Array
}

export interface AssetUploadAuditScope {
  workspaceId?: unknown
  actorId?: unknown
  requestId?: unknown
}

export interface AssetUploadAuditPayload {
  workspace_id: string | null
  actor_id: string | null
  request_id: string | null
  file_name_sha256: string
  size_bytes: number
  declared_mime: string | null
  signature_class: AssetSignatureClass
  decision: 'allow' | 'reject'
  reason_code: AssetUploadReasonCode | null
}

export interface AssetUploadSecurityResult {
  decision: 'allow' | 'reject'
  reasonCode: AssetUploadReasonCode | null
  reasonCodes: readonly AssetUploadReasonCode[]
  audit: Readonly<AssetUploadAuditPayload>
}

interface AssetTypePolicy {
  mimes: readonly string[]
  signatures: readonly AssetSignatureClass[]
}

const MAX_ASSET_BYTES = 50 * 1024 * 1024
const extensionPolicies = new Map<string, AssetTypePolicy>([
  ['.pdf', { mimes: ['application/pdf'], signatures: ['pdf'] }],
  ['.docx', { mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], signatures: ['zip'] }],
  ['.xlsx', { mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], signatures: ['zip'] }],
  ['.csv', { mimes: ['text/csv', 'application/csv', 'text/plain'], signatures: ['text'] }],
  ['.txt', { mimes: ['text/plain'], signatures: ['text'] }],
  ['.md', { mimes: ['text/markdown', 'text/plain'], signatures: ['text'] }],
  ['.json', { mimes: ['application/json', 'text/json'], signatures: ['json'] }],
  ['.png', { mimes: ['image/png'], signatures: ['png'] }],
  ['.jpg', { mimes: ['image/jpeg'], signatures: ['jpeg'] }],
  ['.jpeg', { mimes: ['image/jpeg'], signatures: ['jpeg'] }],
  ['.gif', { mimes: ['image/gif'], signatures: ['gif'] }],
  ['.webp', { mimes: ['image/webp'], signatures: ['webp'] }],
  ['.mp4', { mimes: ['video/mp4'], signatures: ['mp4'] }],
  ['.webm', { mimes: ['video/webm'], signatures: ['webm'] }],
  ['.svg', { mimes: ['image/svg+xml', 'text/xml', 'application/xml'], signatures: ['svg'] }],
  ['.ai', { mimes: ['application/pdf', 'application/postscript', 'application/illustrator'], signatures: ['pdf', 'postscript'] }],
  ['.eps', { mimes: ['application/postscript'], signatures: ['postscript'] }],
])

const signatureMimes = new Map<AssetSignatureClass, readonly string[]>([
  ['pdf', ['application/pdf']],
  ['zip', ['application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']],
  ['png', ['image/png']],
  ['jpeg', ['image/jpeg']],
  ['gif', ['image/gif']],
  ['webp', ['image/webp']],
  ['mp4', ['video/mp4']],
  ['webm', ['video/webm']],
  ['svg', ['image/svg+xml', 'text/xml', 'application/xml']],
  ['postscript', ['application/postscript', 'application/illustrator']],
  ['json', ['application/json', 'text/json']],
  ['text', ['text/plain', 'text/csv', 'application/csv', 'text/markdown']],
])

const knownDisguiseExtensions = new Set([
  ...extensionPolicies.keys(),
  '.exe', '.dll', '.com', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.app', '.dmg', '.elf', '.bin', '.scr', '.jar',
])

const executableSignatures = new Set<AssetSignatureClass>(['pe', 'elf', 'mach_o', 'shebang'])
const unsafeFilenameControls = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u
const safeAuditIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u

export function classifyAssetUpload(input: AssetUploadSecurityInput, scope: AssetUploadAuditScope = {}): AssetUploadSecurityResult {
  const fileName = typeof input?.fileName === 'string' ? input.fileName : ''
  const bytes = input?.bytes instanceof Uint8Array ? input.bytes : new Uint8Array()
  const declaredMime = normalizeMime(input?.declaredMime)
  const signatureClass = classifySignature(bytes)
  const reasons: AssetUploadReasonCode[] = []
  const addReason = (reason: AssetUploadReasonCode) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  if (typeof input?.fileName !== 'string' || !(input?.bytes instanceof Uint8Array) || typeof input?.declaredMime !== 'string') addReason('ASSET_INPUT_INVALID')
  if (bytes.byteLength > MAX_ASSET_BYTES) addReason('ASSET_SIZE_INVALID')
  if (unsafeFilenameControls.test(fileName)) addReason('ASSET_FILENAME_CONTROL_CHARACTER')
  if (hasUnicodeConfusable(fileName)) addReason('ASSET_FILENAME_UNICODE_CONFUSABLE')
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') addReason('ASSET_FILENAME_PATH_UNSAFE')
  if (hasSuspiciousDoubleExtension(fileName)) addReason('ASSET_DOUBLE_EXTENSION_REJECTED')

  const extension = finalExtension(fileName)
  const policy = extensionPolicies.get(extension)
  if (!policy) addReason('ASSET_TYPE_UNSUPPORTED')
  if (!declaredMime) addReason('ASSET_DECLARED_MIME_INVALID')
  if (executableSignatures.has(signatureClass)) addReason('ASSET_EXECUTABLE_REJECTED')

  if (signatureClass === 'svg') inspectSvg(bytes).forEach(addReason)
  if (policy && declaredMime && !policy.mimes.includes(declaredMime)) addReason('ASSET_EXTENSION_MIME_MISMATCH')
  if (policy && !policy.signatures.includes(signatureClass)) addReason('ASSET_EXTENSION_SIGNATURE_MISMATCH')
  const compatibleMimes = signatureMimes.get(signatureClass)
  if (declaredMime && compatibleMimes && !compatibleMimes.includes(declaredMime)) addReason('ASSET_MIME_SIGNATURE_MISMATCH')

  const decision = reasons.length === 0 ? 'allow' as const : 'reject' as const
  const reasonCode = reasons[0] ?? null
  const audit = Object.freeze({
    workspace_id: auditIdentifier(scope.workspaceId),
    actor_id: auditIdentifier(scope.actorId),
    request_id: auditIdentifier(scope.requestId),
    file_name_sha256: createHash('sha256').update(fileName, 'utf8').digest('hex'),
    size_bytes: bytes.byteLength,
    declared_mime: declaredMime,
    signature_class: signatureClass,
    decision,
    reason_code: reasonCode,
  })
  return Object.freeze({ decision, reasonCode, reasonCodes: Object.freeze(reasons), audit })
}

export function classifyAssetUploadBatch(inputs: readonly AssetUploadSecurityInput[], scope: AssetUploadAuditScope = {}): readonly AssetUploadSecurityResult[] {
  return Object.freeze(inputs.map(input => {
    try {
      return classifyAssetUpload(input, scope)
    } catch {
      return classifyAssetUpload({ fileName: '', declaredMime: '', bytes: new Uint8Array() }, scope)
    }
  }))
}

function classifySignature(bytes: Uint8Array): AssetSignatureClass {
  if (hasPrefix(bytes, [0x4d, 0x5a])) return 'pe'
  if (hasPrefix(bytes, [0x7f, 0x45, 0x4c, 0x46])) return 'elf'
  if ([
    [0xfe, 0xed, 0xfa, 0xce], [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca],
  ].some(prefix => hasPrefix(bytes, prefix))) return 'mach_o'
  if (hasPrefix(bytes, [0x23, 0x21]) || hasPrefix(bytes, [0xef, 0xbb, 0xbf, 0x23, 0x21])) return 'shebang'
  if (hasPrefix(bytes, ascii('%PDF-'))) return 'pdf'
  if (hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) || hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06]) || hasPrefix(bytes, [0x50, 0x4b, 0x07, 0x08])) return 'zip'
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (hasPrefix(bytes, ascii('GIF87a')) || hasPrefix(bytes, ascii('GIF89a'))) return 'gif'
  if (hasPrefix(bytes, ascii('RIFF')) && bytes.length >= 12 && hasPrefix(bytes.slice(8), ascii('WEBP'))) return 'webp'
  if (hasPrefix(bytes, ascii('%!PS-Adobe'))) return 'postscript'
  if (hasPrefix(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return isWebmContainer(bytes) ? 'webm' : 'unknown'
  if (bytes.length >= 8 && ['ftyp', 'free', 'skip', 'wide'].includes(fourCc(bytes, 4))) return isMp4Container(bytes) ? 'mp4' : 'unknown'

  const text = decodeText(bytes)
  if (text !== null && /^(?:\uFEFF|\s)*(?:<\?xml\b[^>]*>\s*)?<svg(?:\s|>)/iu.test(text)) return 'svg'
  if (text !== null && isJson(text)) return 'json'
  if (text !== null && isSafeText(text)) return 'text'
  return 'unknown'
}

// Container identification only: this does not decode frames or replace the
// quarantine/antimalware scan. Parse bounded headers, never search raw payloads
// for magic strings (which would admit ftyp/DocType text inside arbitrary data).
// Format references: https://www.w3.org/TR/mse-byte-stream-format-isobmff/
// https://www.webmproject.org/docs/container/ and RFC 8794 sections 4-6.
interface ContainerBudget { remaining: number; maxIdWidth?: number; maxSizeWidth?: number }
interface Mp4Box { type: string; start: number; end: number }

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
}

function mp4Boxes(bytes: Uint8Array, start: number, end: number, budget: ContainerBudget, topLevel = false): Mp4Box[] | null {
  const boxes: Mp4Box[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  while (start < end) {
    if (--budget.remaining < 0 || end - start < 8) return null
    const shortSize = view.getUint32(start)
    const type = fourCc(bytes, start + 4)
    let headerSize = 8
    let size = shortSize
    if (shortSize === 1) {
      if (end - start < 16) return null
      const largeSize = view.getBigUint64(start + 8)
      if (largeSize > BigInt(end - start)) return null
      size = Number(largeSize)
      headerSize = 16
    } else if (shortSize === 0) {
      // Size zero consumes the rest of the file, not an enclosing metadata box.
      if (!topLevel || type !== 'mdat') return null
      size = end - start
    }
    if (type === 'uuid') headerSize += 16
    if (size < headerSize || size > end - start) return null
    boxes.push({ type, start: start + headerSize, end: start + size })
    start += size
  }
  return boxes
}

function isMp4Container(bytes: Uint8Array): boolean {
  const budget = { remaining: 4096 }
  const boxes = mp4Boxes(bytes, 0, bytes.length, budget, true)
  if (!boxes) return false
  const fileTypes = boxes.filter(box => box.type === 'ftyp')
  const movies = boxes.filter(box => box.type === 'moov')
  if (fileTypes.length !== 1 || movies.length !== 1 || !boxes.some(box => box.type === 'mdat' && box.end > box.start)) return false
  const fileType = fileTypes[0]!
  if (fileType.end - fileType.start < 8 || (fileType.end - fileType.start) % 4 !== 0 || fileType.end - fileType.start > 4096) return false
  // This upload policy accepts MP4 video, not all ISO-BMFF relatives (HEIF/MOV).
  const brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '])
  if (!brands.has(fourCc(bytes, fileType.start))) return false
  const movie = movies[0]!
  const movieChildren = mp4Boxes(bytes, movie.start, movie.end, budget)
  const movieHeaders = movieChildren?.filter(box => box.type === 'mvhd')
  if (!movieChildren || movieHeaders?.length !== 1) return false
  const movieHeader = movieHeaders[0]!
  const movieVersion = bytes[movieHeader.start]
  if (movieVersion !== 0 && movieVersion !== 1 || movieHeader.end - movieHeader.start < (movieVersion === 1 ? 112 : 100)) return false
  let hasVideoTrack = false
  for (const track of movieChildren.filter(box => box.type === 'trak')) {
    const trackChildren = mp4Boxes(bytes, track.start, track.end, budget)
    if (!trackChildren) return false
    for (const media of trackChildren.filter(box => box.type === 'mdia')) {
      const mediaChildren = mp4Boxes(bytes, media.start, media.end, budget)
      if (!mediaChildren) return false
      for (const handler of mediaChildren.filter(box => box.type === 'hdlr')) {
        // FullBox header, pre_defined, handler_type and three reserved uint32s.
        if (handler.end - handler.start < 24 || bytes[handler.start] !== 0) return false
        if (fourCc(bytes, handler.start + 8) === 'vide') hasVideoTrack = true
      }
    }
  }
  return hasVideoTrack
}

interface EbmlElement { id: number; start: number; end: number; unknownSize: boolean }

function ebmlVint(bytes: Uint8Array, offset: number, end: number, id: boolean): { value: bigint; width: number; unknown: boolean } | null {
  const first = bytes[offset]
  if (offset >= end || first === undefined || first === 0) return null
  let width = 1
  let marker = 0x80
  while ((first & marker) === 0) { width++; marker >>= 1 }
  if (width > (id ? 4 : 8) || offset + width > end) return null
  let data = BigInt(first & (marker - 1))
  for (let index = 1; index < width; index++) data = data * 256n + BigInt(bytes[offset + index]!)
  const unknown = data === (1n << BigInt(7 * width)) - 1n
  if (id && (data === 0n || unknown || width > 1 && data < (1n << BigInt(7 * (width - 1))) - 1n)) return null
  return { value: id ? data + (1n << BigInt(7 * width)) : data, width, unknown }
}

function ebmlElement(bytes: Uint8Array, offset: number, end: number, budget: ContainerBudget): EbmlElement | null {
  if (--budget.remaining < 0) return null
  const id = ebmlVint(bytes, offset, end, true)
  if (!id || id.width > (budget.maxIdWidth ?? 4)) return null
  const size = ebmlVint(bytes, offset + id.width, end, false)
  if (!size || size.width > (budget.maxSizeWidth ?? 8)) return null
  const start = offset + id.width + size.width
  if (!size.unknown && size.value > BigInt(end - start)) return null
  return { id: Number(id.value), start, end: size.unknown ? end : start + Number(size.value), unknownSize: size.unknown }
}

function ebmlChildren(bytes: Uint8Array, start: number, end: number, budget: ContainerBudget): EbmlElement[] | null {
  const children: EbmlElement[] = []
  while (start < end) {
    const child = ebmlElement(bytes, start, end, budget)
    if (!child || child.unknownSize) return null
    children.push(child)
    start = child.end
  }
  return children
}

function webmClusterEnd(bytes: Uint8Array, cluster: EbmlElement, budget: ContainerBudget): number | null {
  let offset = cluster.start
  let hasTimecode = false
  let hasBlock = false
  while (offset < cluster.end) {
    const child = ebmlElement(bytes, offset, cluster.end, budget)
    if (!child) return null
    if (cluster.unknownSize && [0x1f43b675, 0x1c53bb6b, 0x114d9b74, 0x1254c367, 0x1549a966, 0x1654ae6b].includes(child.id)) break
    if (child.unknownSize) return null
    if (child.id === 0xe7) {
      if (child.end - child.start < 1 || child.end - child.start > 8) return null
      hasTimecode = true
    }
    const blocks = child.id === 0xa0 ? ebmlChildren(bytes, child.start, child.end, budget) : [child]
    if (!blocks) return null
    for (const block of blocks.filter(field => field.id === 0xa3 || field.id === 0xa1)) {
      const track = ebmlVint(bytes, block.start, block.end, false)
      // Track number + int16 timecode + flags + nonempty encoded frame. This
      // validates the Block header only; codec and lacing validation is separate.
      if (!hasTimecode || !track || track.unknown || track.value === 0n || block.end - block.start <= track.width + 3) return null
      hasBlock = true
    }
    offset = child.end
  }
  return hasTimecode && hasBlock ? offset : null
}

function isWebmContainer(bytes: Uint8Array): boolean {
  const budget: ContainerBudget = { remaining: 65536 }
  const header = ebmlElement(bytes, 0, bytes.length, budget)
  if (!header || header.id !== 0x1a45dfa3 || header.unknownSize || header.end > 4096) return false
  const headerFields = ebmlChildren(bytes, header.start, header.end, budget)
  const docTypes = headerFields?.filter(field => field.id === 0x4282)
  if (!headerFields || docTypes?.length !== 1 || decodeText(bytes.subarray(docTypes[0]!.start, docTypes[0]!.end)) !== 'webm') return false
  for (const [id, maximum] of [[0x42f2, 4], [0x42f3, 8], [0x42f7, 1], [0x4286, 1], [0x4285, 4]] as const) {
    const limits = headerFields.filter(field => field.id === id)
    if (limits.length > 1 || limits.some(field => field.end - field.start !== 1 || bytes[field.start]! < 1 || bytes[field.start]! > maximum)) return false
  }
  const idLimit = headerFields.find(field => field.id === 0x42f2)
  const sizeLimit = headerFields.find(field => field.id === 0x42f3)
  budget.maxIdWidth = idLimit ? bytes[idLimit.start]! : 4
  budget.maxSizeWidth = sizeLimit ? bytes[sizeLimit.start]! : 8
  const segment = ebmlElement(bytes, header.end, bytes.length, budget)
  if (!segment || segment.id !== 0x18538067 || segment.end !== bytes.length) return false
  let hasInfo = false
  let hasVideoTrack = false
  let hasCluster = false
  let offset = segment.start
  while (offset < segment.end) {
    const child = ebmlElement(bytes, offset, segment.end, budget)
    if (!child) return false
    if (child.id === 0x1f43b675) {
      if (!hasInfo || !hasVideoTrack || child.start === child.end) return false
      const clusterEnd = webmClusterEnd(bytes, child, budget)
      if (clusterEnd === null) return false
      hasCluster = true
      // Live/browser recordings may have unknown-size Clusters. Resume at the
      // next level-1 header, having skipped encoded payloads by declared length.
      offset = clusterEnd
      continue
    } else {
      if (child.unknownSize) return false
      if (child.id === 0x1549a966) {
        const fields = ebmlChildren(bytes, child.start, child.end, budget)
        if (!fields?.length) return false
        hasInfo = true
      }
      if (child.id === 0x1654ae6b) {
        const tracks = ebmlChildren(bytes, child.start, child.end, budget)
        if (!tracks) return false
        for (const track of tracks.filter(field => field.id === 0xae)) {
          const fields = ebmlChildren(bytes, track.start, track.end, budget)
          if (!fields) return false
          const types = fields.filter(field => field.id === 0x83)
          const codecs = fields.filter(field => field.id === 0x86)
          if (types.length !== 1 || codecs.length !== 1) return false
          const type = types[0]!
          const codec = codecs[0]!
          if (type.end - type.start === 1 && bytes[type.start] === 1
            && /^V_(?:VP8|VP9|AV1)$/u.test(decodeText(bytes.subarray(codec.start, codec.end)) ?? '')) hasVideoTrack = true
        }
      }
    }
    offset = child.end
  }
  return hasInfo && hasVideoTrack && hasCluster
}

function inspectSvg(bytes: Uint8Array): AssetUploadReasonCode[] {
  const raw = decodeText(bytes) ?? ''
  const text = decodeXmlCharacterReferences(raw)
  const reasons: AssetUploadReasonCode[] = []
  if (/<(?:[A-Za-z_][\w.-]*:)?script(?:\s|>)/iu.test(text) || /\bjavascript\s*:/iu.test(text)) reasons.push('ASSET_SVG_SCRIPT_REJECTED')
  if (/\bon[A-Za-z][\w.-]*\s*=/iu.test(text)) reasons.push('ASSET_SVG_EVENT_HANDLER_REJECTED')
  if (/<(?:[A-Za-z_][\w.-]*:)?foreignObject(?:\s|>)/iu.test(text)) reasons.push('ASSET_SVG_FOREIGN_OBJECT_REJECTED')
  if (/(?:\b(?:href|xlink:href|src)\s*=\s*["']\s*(?!#)[^"']+|\burl\s*\(\s*["']?\s*(?!#)[^)"']+|@import\b|<!DOCTYPE\b|<!ENTITY\b)/iu.test(text)) reasons.push('ASSET_SVG_EXTERNAL_REFERENCE_REJECTED')
  return reasons
}

function normalizeMime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const mime = value.normalize('NFKC').split(';', 1)[0]!.trim().toLowerCase()
  return mime && mime.length <= 128 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mime) ? mime : null
}

function auditIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim()
  return safeAuditIdentifier.test(normalized) ? normalized : null
}

function hasUnicodeConfusable(fileName: string): boolean {
  if (fileName.normalize('NFKC') !== fileName) return true
  if (/[A-Za-z]/u.test(fileName) && /[\u0370-\u03FF\u0400-\u052F]/u.test(fileName)) return true
  const extension = fileName.match(/\.[^.]*$/u)?.[0]
  return extension !== undefined && !/^\.[A-Za-z0-9]+$/u.test(extension)
}

function hasSuspiciousDoubleExtension(fileName: string): boolean {
  const segments = fileName.toLowerCase().split('.')
  if (segments.length < 3) return false
  return segments.slice(1, -1).some(segment => knownDisguiseExtensions.has(`.${segment}`))
}

function finalExtension(fileName: string): string {
  return fileName.toLowerCase().match(/\.[a-z0-9]+$/u)?.[0] ?? ''
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((value, index) => bytes[index] === value)
}

function ascii(value: string): number[] {
  return [...value].map(character => character.charCodeAt(0))
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function isSafeText(value: string): boolean {
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function decodeXmlCharacterReferences(value: string): string {
  return value
    .replace(/&#x([0-9a-f]{1,8});?/giu, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]{1,8});?/gu, (_match, decimal: string) => safeCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&colon;/giu, ':')
    .replace(/&tab;/giu, '\t')
    .replace(/&newline;/giu, '\n')
}

function safeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : '\uFFFD'
}
