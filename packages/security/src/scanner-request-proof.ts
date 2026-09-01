import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SCANNER_REQUEST_PROOF_MAX_SKEW_SECONDS = 60
const MAX_REQUEST_TARGET_LENGTH = 2_048
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

export interface ScannerRequestProofInput {
  secret: string
  method: string
  requestTarget: string
  workspaceId: string
  body?: string | Uint8Array
  timestampSeconds?: number
  nonce?: string
}

export interface ScannerRequestProof {
  timestamp: string
  nonce: string
  bodySha256: string
  signature: string
  canonical: string
  headers: Record<string, string>
}

export interface ScannerRequestProofVerificationInput extends Omit<ScannerRequestProofInput, 'timestampSeconds' | 'nonce'> {
  timestamp: string
  nonce: string
  bodySha256: string
  signature: string
  nowSeconds?: number
  maxSkewSeconds?: number
}

function bodyBytes(body: string | Uint8Array | undefined): string | Uint8Array {
  return body ?? new Uint8Array()
}

export function scannerRequestBodySha256(body?: string | Uint8Array): string {
  return createHash('sha256').update(bodyBytes(body)).digest('hex')
}

export function canonicalScannerRequestProof(input: {
  method: string
  requestTarget: string
  workspaceId: string
  timestamp: string
  nonce: string
  bodySha256: string
}): string {
  return [input.method, input.requestTarget, input.workspaceId, input.timestamp, input.nonce, input.bodySha256].join('\n')
}

function assertGenerationInput(input: ScannerRequestProofInput, timestamp: string, nonce: string): void {
  if (!input.secret) throw new Error('scanner request proof secret is required')
  if (!/^[A-Z]+$/u.test(input.method)) throw new Error('scanner request proof method is invalid')
  if (!isSafeRequestTarget(input.requestTarget)) throw new Error('scanner request proof target is invalid')
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.workspaceId)) throw new Error('scanner request proof workspace is invalid')
  if (!/^\d{10}$/u.test(timestamp)) throw new Error('scanner request proof timestamp is invalid')
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) throw new Error('scanner request proof nonce is invalid')
}

function isSafeRequestTarget(value: string): boolean {
  return value.length > 0 && value.length <= MAX_REQUEST_TARGET_LENGTH && value.startsWith('/') && !CONTROL_CHARACTER.test(value)
}

export function createScannerRequestProof(input: ScannerRequestProofInput): ScannerRequestProof {
  const timestamp = String(input.timestampSeconds ?? Math.floor(Date.now() / 1000))
  const nonce = input.nonce ?? randomBytes(24).toString('base64url')
  assertGenerationInput(input, timestamp, nonce)
  const bodySha256 = scannerRequestBodySha256(input.body)
  const canonical = canonicalScannerRequestProof({ method: input.method, requestTarget: input.requestTarget, workspaceId: input.workspaceId, timestamp, nonce, bodySha256 })
  const signature = createHmac('sha256', input.secret).update(canonical).digest('hex')
  return {
    timestamp,
    nonce,
    bodySha256,
    signature,
    canonical,
    headers: {
      'x-scanner-timestamp': timestamp,
      'x-scanner-nonce': nonce,
      'x-scanner-body-sha256': bodySha256,
      'x-scanner-workspace-signature': signature,
    },
  }
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function verifyScannerRequestProof(input: ScannerRequestProofVerificationInput): boolean {
  try {
    if (!input || typeof input !== 'object' || typeof input.secret !== 'string' || input.secret.length === 0
      || typeof input.method !== 'string' || typeof input.requestTarget !== 'string' || typeof input.workspaceId !== 'string'
      || typeof input.timestamp !== 'string' || typeof input.nonce !== 'string' || typeof input.bodySha256 !== 'string'
      || typeof input.signature !== 'string'
      || (input.body !== undefined && typeof input.body !== 'string' && !(input.body instanceof Uint8Array))) return false
    const timestampSeconds = Number(input.timestamp)
    const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000)
    const maxSkewSeconds = input.maxSkewSeconds ?? SCANNER_REQUEST_PROOF_MAX_SKEW_SECONDS
    if (!/^[A-Z]+$/u.test(input.method) || !isSafeRequestTarget(input.requestTarget)
      || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.workspaceId)
      || !Number.isSafeInteger(timestampSeconds) || !/^\d{10}$/u.test(input.timestamp)
      || !Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(maxSkewSeconds) || maxSkewSeconds < 0
      || Math.abs(nowSeconds - timestampSeconds) > maxSkewSeconds || !/^[A-Za-z0-9_-]{16,128}$/u.test(input.nonce)) return false
    const actualBodySha256 = scannerRequestBodySha256(input.body)
    if (!safeEqualHex(input.bodySha256.toLowerCase(), actualBodySha256)) return false
    const canonical = canonicalScannerRequestProof({ method: input.method, requestTarget: input.requestTarget, workspaceId: input.workspaceId, timestamp: input.timestamp, nonce: input.nonce, bodySha256: input.bodySha256.toLowerCase() })
    const expected = createHmac('sha256', input.secret).update(canonical).digest('hex')
    return safeEqualHex(input.signature.toLowerCase(), expected)
  } catch { return false }
}
