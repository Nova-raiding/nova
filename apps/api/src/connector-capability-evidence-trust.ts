import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import type { ProductionCapabilityEvidenceTrust } from '../../../packages/connectors/src/capability-evidence.js'

const TRUST_ROOT = '/run/release-security/evidence-trust'
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024
const MAX_TRUST_FILE_BYTES = 16 * 1024

export interface CapabilityEvidenceTrustPaths {
  evidencePath?: string
  publicKeyPath?: string
  keyIdPath?: string
}

/**
 * Read the release-bound capability document and its public trust anchor.
 * Any missing, symlinked, non-regular, empty, or oversized input disables the
 * trust object; connector readiness then fails closed without capability
 * evidence. Signature, release identity, and key ID are verified downstream
 * by the connector configuration boundary.
 */
export function loadConnectorCapabilityEvidenceTrust(
  source: Readonly<Record<string, string | undefined>> = process.env,
  paths: CapabilityEvidenceTrustPaths = {},
): ProductionCapabilityEvidenceTrust | undefined {
  const evidencePath = paths.evidencePath ?? source.CAPABILITY_EVIDENCE_PATH?.trim()
  if (source.NODE_ENV !== 'production' || !evidencePath) return undefined

  const publicKeyPath = paths.publicKeyPath ?? `${TRUST_ROOT}/production-evidence-public.pem`
  const keyIdPath = paths.keyIdPath ?? `${TRUST_ROOT}/production-evidence-key-id`
  try {
    const readProtectedRegularFile = (path: string, maxBytes: number) => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const metadata = fstatSync(fd)
        if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) return undefined
        const contents = readFileSync(fd)
        if (contents.byteLength <= 0 || contents.byteLength > maxBytes) return undefined
        return contents.toString('utf8')
      } finally {
        closeSync(fd)
      }
    }
    const documentJson = readProtectedRegularFile(evidencePath, MAX_EVIDENCE_BYTES)
    const publicKeyPem = readProtectedRegularFile(publicKeyPath, MAX_TRUST_FILE_BYTES)
    const trustedKeyId = readProtectedRegularFile(keyIdPath, MAX_TRUST_FILE_BYTES)?.trim()
    if (!documentJson?.trim() || !publicKeyPem?.trim() || !trustedKeyId) return undefined
    return { documentJson, publicKeyPem, trustedKeyId }
  } catch {
    return undefined
  }
}
