/**
 * Projects the server-owned connector capability evidence into the small
 * response shape consumed by the merchant desktop readiness panel.
 *
 * Media lifecycle evidence is deliberately joined only from an approved,
 * desktop-scoped platform media specification. Missing or non-approved
 * records are omitted; the client must then remain unverified.
 */
export type PlatformCapabilityEvidenceRow = {
  capability: string
  state: string
  evidenceRef?: string
  verifiedBy?: string
  verifiedAt?: string
  apiVersion?: string
  scope?: string
  source?: string
  version?: string
  expiresAt?: string
  status?: "approved" | "expired" | "draft"
}

export type PlatformMediaSpecEvidence = {
  platform: string
  device: "desktop" | "mobile"
  version: string
  sourceUrl: string
  checkedAt: string
  evidenceArtifactRef?: string
  status: "draft" | "approved" | "expired"
  expiresAt?: string
  updatedAt: string
}

export function projectPlatformCapabilityEvidence(
  capabilities: readonly PlatformCapabilityEvidenceRow[],
  mediaSpecs: readonly PlatformMediaSpecEvidence[],
  platform: string,
): PlatformCapabilityEvidenceRow[] {
  const desktopApproved = mediaSpecs
    .filter((spec) => spec.platform === platform && spec.device === "desktop" && spec.status === "approved")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const mediaSpec = desktopApproved[0]
  if (!mediaSpec) return capabilities.map((item) => ({ ...item }))

  return capabilities.map((item) => item.capability === "media_upload"
    ? {
        ...item,
        source: mediaSpec.sourceUrl,
        version: mediaSpec.version,
        expiresAt: mediaSpec.expiresAt,
        status: mediaSpec.status,
        verifiedAt: mediaSpec.checkedAt,
        ...(mediaSpec.evidenceArtifactRef ? { evidenceRef: mediaSpec.evidenceArtifactRef } : {}),
      }
    : { ...item })
}
