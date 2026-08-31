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

  const text = decodeText(bytes)
  if (text !== null && /^(?:\uFEFF|\s)*(?:<\?xml\b[^>]*>\s*)?<svg(?:\s|>)/iu.test(text)) return 'svg'
  if (text !== null && isJson(text)) return 'json'
  if (text !== null && isSafeText(text)) return 'text'
  return 'unknown'
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
