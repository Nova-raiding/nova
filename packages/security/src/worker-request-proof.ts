import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const WORKER_REQUEST_PROOF_MAX_SKEW_SECONDS = 60
export const WORKER_ROLES = ['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan'] as const
export type WorkerRequestRole = typeof WORKER_ROLES[number]

const MAX_REQUEST_TARGET_LENGTH = 2_048
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

function isSafeRequestTarget(value: string): boolean {
  return value.length > 0 && value.length <= MAX_REQUEST_TARGET_LENGTH && value.startsWith('/') && !CONTROL_CHARACTER.test(value)
}

type ProofBase = {
  secret: string
  role: WorkerRequestRole
  method: string
  requestTarget: string
  workspaceId: string
  body?: string | Uint8Array
}

export function workerRequestBodySha256(body?: string | Uint8Array): string {
  return createHash('sha256').update(body ?? new Uint8Array()).digest('hex')
}

export function canonicalWorkerRequestProof(input: Omit<ProofBase, 'secret' | 'body'> & { timestamp: string; nonce: string; bodySha256: string }): string {
  return [input.role, input.method, input.requestTarget, input.workspaceId, input.timestamp, input.nonce, input.bodySha256].join('\n')
}

export function createWorkerRequestProof(input: ProofBase & { timestampSeconds?: number; nonce?: string }) {
  const timestamp = String(input.timestampSeconds ?? Math.floor(Date.now() / 1000))
  const nonce = input.nonce ?? randomBytes(24).toString('base64url')
  if (!input.secret || !WORKER_ROLES.includes(input.role) || !/^[A-Z]+$/u.test(input.method) || !isSafeRequestTarget(input.requestTarget)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.workspaceId) || !/^\d{10}$/u.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) {
    throw new Error('worker request proof input is invalid')
  }
  const bodySha256 = workerRequestBodySha256(input.body)
  const canonical = canonicalWorkerRequestProof({ role: input.role, method: input.method, requestTarget: input.requestTarget, workspaceId: input.workspaceId, timestamp, nonce, bodySha256 })
  const signature = createHmac('sha256', input.secret).update(canonical).digest('hex')
  return { timestamp, nonce, bodySha256, signature, canonical, headers: { 'x-worker-role': input.role, 'x-worker-timestamp': timestamp, 'x-worker-nonce': nonce, 'x-worker-body-sha256': bodySha256, 'x-worker-workspace-signature': signature } }
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function verifyWorkerRequestProof(input: ProofBase & { timestamp: string; nonce: string; bodySha256: string; signature: string; nowSeconds?: number; maxSkewSeconds?: number }): boolean {
  try {
    if (!input || typeof input !== 'object' || typeof input.secret !== 'string' || input.secret.length === 0
      || typeof input.role !== 'string' || typeof input.method !== 'string' || typeof input.requestTarget !== 'string'
      || typeof input.workspaceId !== 'string' || typeof input.timestamp !== 'string' || typeof input.nonce !== 'string'
      || typeof input.bodySha256 !== 'string' || typeof input.signature !== 'string'
      || (input.body !== undefined && typeof input.body !== 'string' && !(input.body instanceof Uint8Array))) return false
    const timestampSeconds = Number(input.timestamp)
    const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000)
    const maxSkewSeconds = input.maxSkewSeconds ?? WORKER_REQUEST_PROOF_MAX_SKEW_SECONDS
    if (!WORKER_ROLES.includes(input.role) || !/^[A-Z]+$/u.test(input.method) || !isSafeRequestTarget(input.requestTarget)
      || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.workspaceId) || !Number.isSafeInteger(timestampSeconds) || !/^\d{10}$/u.test(input.timestamp)
      || !Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(maxSkewSeconds) || maxSkewSeconds < 0
      || Math.abs(nowSeconds - timestampSeconds) > maxSkewSeconds || !/^[A-Za-z0-9_-]{16,128}$/u.test(input.nonce)) return false
    const actualDigest = workerRequestBodySha256(input.body)
    if (!safeEqualHex(input.bodySha256.toLowerCase(), actualDigest)) return false
    const canonical = canonicalWorkerRequestProof({ role: input.role, method: input.method, requestTarget: input.requestTarget, workspaceId: input.workspaceId, timestamp: input.timestamp, nonce: input.nonce, bodySha256: input.bodySha256.toLowerCase() })
    return safeEqualHex(input.signature.toLowerCase(), createHmac('sha256', input.secret).update(canonical).digest('hex'))
  } catch { return false }
}
