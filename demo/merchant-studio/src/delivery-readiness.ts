import type { CapabilityEvidenceRow, PlatformCapability, PlatformId } from './api.js'

export type MediaSpecReadiness = 'approved' | 'expired' | 'unverified'
export type DeliveryFindingReadiness = 'approved' | 'blocked' | 'unverified'

export function deliveryFindingReadiness(status: string | undefined, findings: readonly unknown[]): DeliveryFindingReadiness {
  if (findings.length > 0) return 'blocked'
  return status === 'passed' ? 'approved' : 'unverified'
}

export interface MediaSpecReadinessRow {
  id: string
  platform: PlatformId
  capability: string
  readiness: MediaSpecReadiness
  source: string | null
  version: string | null
  validUntil: string | null
  evidence: string | null
  nextAction: string
}

const MEDIA_CAPABILITY = /(?:media|image|video|asset|upload|图片|视频|媒体|素材)/iu

function evidenceStatus(row: CapabilityEvidenceRow, now: number): MediaSpecReadiness {
  const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : Number.NaN
  if (row.status === 'expired' || Number.isFinite(expiresAt) && expiresAt <= now) return 'expired'
  const evidenceReady = ['production_canary', 'test_e2e'].includes(row.state) && Boolean(row.evidenceRef?.trim())
  const lifecycleReady = row.status === 'approved' && Boolean((row.version ?? row.apiVersion)?.trim()) && Number.isFinite(expiresAt) && expiresAt > now
  return evidenceReady && lifecycleReady ? 'approved' : 'unverified'
}

export function mediaSpecReadiness(capabilities: readonly PlatformCapability[], now = Date.now()): MediaSpecReadinessRow[] {
  return capabilities.flatMap(platform => {
    const mediaRows = platform.capabilities.filter(row => MEDIA_CAPABILITY.test(row.capability))
    if (!mediaRows.length) return [{
      id: `${platform.platform}:missing`, platform: platform.platform, capability: '平台媒体规格', readiness: 'unverified' as const,
      source: null, version: null, validUntil: null, evidence: null,
      nextAction: '由运营端接入已批准且未过期的平台媒体规格，并提供来源、版本、有效期与验证证据。',
    }]
    return mediaRows.map(row => {
      const readiness = evidenceStatus(row, now)
      return {
        id: `${platform.platform}:${row.capability}`,
        platform: platform.platform,
        capability: row.capability,
        readiness,
        source: row.source?.trim() || null,
        version: (row.version ?? row.apiVersion)?.trim() || null,
        validUntil: row.expiresAt?.trim() || null,
        evidence: row.evidenceRef?.trim() || null,
        nextAction: readiness === 'approved' ? '规格证据完整，可继续执行字段 mapping preflight。' : readiness === 'expired' ? '更新平台规格并重新批准后再生成交付物。' : '补齐来源、版本、有效期、approved 状态及 canary/E2E evidence。',
      }
    })
  })
}
