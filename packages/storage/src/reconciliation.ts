export type ReconciliationFindingCode =
  | 'MISSING_OBJECT'
  | 'OBJECT_METADATA_MISMATCH'
  | 'ORPHAN_OBJECT'
  | 'CROSS_WORKSPACE_REFERENCE'
  | 'CROSS_WORKSPACE_OBJECT'
  | 'DUPLICATE_OBJECT'
  | 'DUPLICATE_REFERENCE'
  | 'INVALID_OBJECT_METADATA'
  | 'QUOTA_EXCEEDED'

export interface DurableObjectReference {
  workspaceId: string
  assetId: string
  storageKey: string
  sha256: string
  sizeBytes: number
}

export interface ObjectInventoryEntry {
  workspaceId: string
  storageKey: string
  sha256: string
  sizeBytes: number
}

export interface ReconciliationFinding {
  code: ReconciliationFindingCode
  workspaceId: string
  storageKey?: string
  assetId?: string
  detail?: string
}

export interface ReconciliationReport {
  workspaceId: string
  status: 'clean' | 'attention_required'
  /** Describes whether the latest inventory attempt completed. `status` remains
   * the inventory health result so a failed attempt cannot look clean. */
  runStatus?: 'succeeded' | 'failed'
  lastRunAt?: string
  error?: ReconciliationErrorEvidence
  quota: {
    limitBytes?: number
    reservedBytes: number
    usedBytes: number
    projectedBytes: number
    availableBytes?: number
  }
  counts: {
    references: number
    inventoryObjects: number
    matched: number
    missing: number
    metadataMismatches: number
    orphans: number
    crossWorkspace: number
    duplicates: number
    invalidMetadata: number
  }
  findings: ReconciliationFinding[]
}

export interface ReconciliationErrorEvidence {
  code: string
  message: string
  /** Present on runner-produced failures; optional for legacy persisted snapshots. */
  retryable?: boolean
  nextActions?: readonly ('retry' | 'manual_review')[]
}

export interface ReconciliationInput {
  workspaceId: string
  references: readonly DurableObjectReference[]
  inventory: readonly ObjectInventoryEntry[]
  quota?: { limitBytes: number; reservedBytes?: number }
}

function validateReconciliationInput(input: ReconciliationInput): void {
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) throw new Error('RECONCILIATION_WORKSPACE_REQUIRED')
  if (!input.quota) return
  if (!Number.isSafeInteger(input.quota.limitBytes) || input.quota.limitBytes < 0 ||
    (input.quota.reservedBytes !== undefined && (!Number.isSafeInteger(input.quota.reservedBytes) || input.quota.reservedBytes < 0))) {
    throw new Error('RECONCILIATION_QUOTA_INVALID')
  }
}

function findingOrder(left: ReconciliationFinding, right: ReconciliationFinding) {
  return left.code.localeCompare(right.code) || (left.storageKey ?? '').localeCompare(right.storageKey ?? '') || (left.assetId ?? '').localeCompare(right.assetId ?? '')
}

function isWorkspaceScopedKey(storageKey: string, workspaceId: string) {
  const parts = storageKey.split('/')
  return (parts[0] === 'quarantine' || parts[0] === 'clean') && parts[1] === workspaceId && parts.length >= 4 && parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

const SHA256 = /^[a-f0-9]{64}$/iu

function hasValidObjectMetadata(value: { sha256: string; sizeBytes: number }): boolean {
  return SHA256.test(value.sha256) && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0
}

/**
 * Compares the database's durable asset references with a provider inventory.
 * This is deliberately side-effect free so the same contract can be used by
 * local acceptance, cloud adapters, and a future scheduled reconciliation job.
 */
export function reconcileObjectInventory(input: ReconciliationInput): ReconciliationReport {
  validateReconciliationInput(input)
  const findings: ReconciliationFinding[] = []
  const references = new Map<string, DurableObjectReference>()
  for (const reference of input.references) {
    if (reference.workspaceId !== input.workspaceId || !isWorkspaceScopedKey(reference.storageKey, input.workspaceId)) {
      findings.push({ code: 'CROSS_WORKSPACE_REFERENCE', workspaceId: input.workspaceId, storageKey: reference.storageKey, assetId: reference.assetId, detail: `reference belongs to ${reference.workspaceId}` })
      continue
    }
    if (!hasValidObjectMetadata(reference)) {
      findings.push({ code: 'INVALID_OBJECT_METADATA', workspaceId: input.workspaceId, storageKey: reference.storageKey, assetId: reference.assetId, detail: 'reference sha256 or sizeBytes is invalid' })
      continue
    }
    if (references.has(reference.storageKey)) {
      findings.push({ code: 'DUPLICATE_REFERENCE', workspaceId: input.workspaceId, storageKey: reference.storageKey, assetId: reference.assetId })
      continue
    }
    references.set(reference.storageKey, reference)
  }

  const inventory = new Map<string, ObjectInventoryEntry>()
  for (const object of input.inventory) {
    if (object.workspaceId !== input.workspaceId || !isWorkspaceScopedKey(object.storageKey, input.workspaceId)) {
      findings.push({ code: 'CROSS_WORKSPACE_OBJECT', workspaceId: input.workspaceId, storageKey: object.storageKey, detail: `object belongs to ${object.workspaceId}` })
      continue
    }
    if (!hasValidObjectMetadata(object)) {
      findings.push({ code: 'INVALID_OBJECT_METADATA', workspaceId: input.workspaceId, storageKey: object.storageKey, detail: 'inventory sha256 or sizeBytes is invalid' })
      continue
    }
    if (inventory.has(object.storageKey)) {
      findings.push({ code: 'DUPLICATE_OBJECT', workspaceId: input.workspaceId, storageKey: object.storageKey })
      continue
    }
    inventory.set(object.storageKey, object)
  }

  let matched = 0
  let missing = 0
  let metadataMismatches = 0
  for (const reference of references.values()) {
    const object = inventory.get(reference.storageKey)
    if (!object) {
      findings.push({ code: 'MISSING_OBJECT', workspaceId: input.workspaceId, storageKey: reference.storageKey, assetId: reference.assetId })
      missing += 1
      continue
    }
    if (object.sha256.toLowerCase() !== reference.sha256.toLowerCase() || object.sizeBytes !== reference.sizeBytes) {
      findings.push({ code: 'OBJECT_METADATA_MISMATCH', workspaceId: input.workspaceId, storageKey: reference.storageKey, assetId: reference.assetId, detail: 'sha256 or sizeBytes differs' })
      metadataMismatches += 1
      continue
    }
    matched += 1
  }

  let usedBytes = 0
  for (const object of inventory.values()) {
    usedBytes += object.sizeBytes
    if (!references.has(object.storageKey)) findings.push({ code: 'ORPHAN_OBJECT', workspaceId: input.workspaceId, storageKey: object.storageKey })
  }
  const orphans = findings.filter(finding => finding.code === 'ORPHAN_OBJECT').length
  const reservedBytes = input.quota?.reservedBytes ?? 0
  const projectedBytes = usedBytes + reservedBytes
  if (input.quota && projectedBytes > input.quota.limitBytes) findings.push({ code: 'QUOTA_EXCEEDED', workspaceId: input.workspaceId, detail: `${projectedBytes} > ${input.quota.limitBytes}` })

  findings.sort(findingOrder)
  const crossWorkspace = findings.filter(finding => finding.code === 'CROSS_WORKSPACE_REFERENCE' || finding.code === 'CROSS_WORKSPACE_OBJECT').length
  const duplicates = findings.filter(finding => finding.code === 'DUPLICATE_OBJECT').length
  const invalidMetadata = findings.filter(finding => finding.code === 'INVALID_OBJECT_METADATA').length
  return {
    workspaceId: input.workspaceId,
    status: findings.length ? 'attention_required' : 'clean',
    quota: { ...(input.quota ? { limitBytes: input.quota.limitBytes } : {}), reservedBytes, usedBytes, projectedBytes, ...(input.quota ? { availableBytes: Math.max(0, input.quota.limitBytes - projectedBytes) } : {}) },
    counts: { references: references.size, inventoryObjects: inventory.size, matched, missing, metadataMismatches, orphans, crossWorkspace, duplicates, invalidMetadata },
    findings,
  }
}
