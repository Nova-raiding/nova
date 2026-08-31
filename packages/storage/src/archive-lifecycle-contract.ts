export type DurableArchiveKind = 'asset' | 'generated_image' | 'generated_video'

export interface DurableArchiveReference {
  kind: DurableArchiveKind
  workspaceId: string
  entityId: string
  storageKey: string
  sha256: string
  sizeBytes: number
  revision: number
}

export interface DurableArchiveCheck {
  restorable: boolean
  reasons: string[]
}

const SHA256 = /^[a-f0-9]{64}$/iu

/**
 * Release-time contract for artifacts that claim restart/backup recovery.
 * Provider URLs, job IDs and fixture URIs are deliberately not accepted as
 * durable archive references.
 */
export function checkDurableArchiveReference(input: unknown): DurableArchiveCheck {
  const reasons: string[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { restorable: false, reasons: ['archive reference must be an object'] }
  const value = input as Partial<DurableArchiveReference>
  if (!['asset', 'generated_image', 'generated_video'].includes(String(value.kind))) reasons.push('kind is unsupported')
  if (!value.workspaceId || !value.entityId) reasons.push('workspaceId and entityId are required')
  const keyParts = typeof value.storageKey === 'string' ? value.storageKey.split('/') : []
  if (typeof value.storageKey !== 'string' || !['quarantine', 'clean'].includes(keyParts[0] ?? '') || keyParts[1] !== value.workspaceId || keyParts.length < 4 || value.storageKey.startsWith('fixture://')) reasons.push('storageKey must be a workspace-scoped quarantine/clean object key')
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) reasons.push('sha256 must be a SHA-256 digest')
  const sizeBytes = value.sizeBytes
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) reasons.push('sizeBytes must be positive')
  const revision = value.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) reasons.push('revision must be positive')
  return { restorable: reasons.length === 0, reasons }
}
