import type { CapabilityEvidence, CapabilityEvidenceState, CapabilityName } from './capability-evidence.js'
import type { HttpConnectorConfig, Platform } from './types.js'
import { inspectOutboundUrl, isSecureEnvironment, officialHostsFor } from './outbound-security.js'

export const REQUIRED_CONNECTOR_CAPABILITIES: readonly CapabilityName[] = [
  'authorize', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload',
]

export type ConnectorReadinessReason =
  | 'CONFIG_MISSING'
  | 'CLIENT_ID_MISSING'
  | 'OAUTH_ENDPOINT_MISSING'
  | 'API_ENDPOINT_MISSING'
  | 'API_PATH_MISSING'
  | 'API_PATH_MUST_BE_RELATIVE'
  | 'HTTPS_REQUIRED'
  | 'HOST_NOT_ALLOWLISTED'
  | 'PRIVATE_ADDRESS_BLOCKED'
  | 'INVALID_OUTBOUND_URL'
  | 'SIGNER_MISSING'
  | 'SIGNER_NOT_ATTESTED'
  | 'PRODUCT_MAPPING_MISSING'
  | 'WRITE_RECEIPT_MAPPING_MISSING'
  | 'WRITE_STATUS_MAPPING_MISSING'
  | 'MAPPING_EVIDENCE_MISSING'
  | 'CAPABILITY_EVIDENCE_MISSING'
  | 'CAPABILITY_EVIDENCE_NOT_E2E'
  | 'CAPABILITY_EVIDENCE_UNATTRIBUTED'

export interface ConnectorReadiness {
  platform: Platform
  ready: boolean
  reasons: readonly ConnectorReadinessReason[]
  verifiedCapabilities: readonly CapabilityName[]
}

/** OAuth is intentionally a narrower gate than catalog/publish readiness.
 * A merchant must be able to grant access before test-e2e catalog evidence can
 * be collected; sync and writes continue to require full connector readiness. */
export function validateConnectorAuthorizationReadiness(
  platform: Platform,
  config: HttpConnectorConfig | undefined,
): ConnectorReadiness {
  const reasons: ConnectorReadinessReason[] = []
  if (!config) return { platform, ready: false, reasons: ['CONFIG_MISSING'], verifiedCapabilities: [] }
  if (!config.clientId.trim()) reasons.push('CLIENT_ID_MISSING')
  if (!validUrl(config.oauth.authorizeUrl) || !validUrl(config.oauth.tokenUrl)) reasons.push('OAUTH_ENDPOINT_MISSING')
  if (isSecureEnvironment()) {
    const allowedHosts = config.allowedHosts ?? officialHostsFor(platform)
    for (const endpoint of [config.oauth.authorizeUrl, config.oauth.tokenUrl, config.oauth.refreshUrl, config.oauth.revokeUrl]) {
      if (!endpoint) continue
      const reason = inspectOutboundUrl(endpoint, { allowedHosts, resolveDns: false })
      if (reason) reasons.push(reason)
    }
  }
  return { platform, ready: reasons.length === 0, reasons: [...new Set(reasons)], verifiedCapabilities: [] }
}

const evidenceOrder: readonly CapabilityEvidenceState[] = ['unverified', 'documented', 'fixture_verified', 'test_e2e', 'production_canary']

function validUrl(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && inspectOutboundUrl(value, { environment: 'development', resolveDns: false }) !== 'INVALID_OUTBOUND_URL'
}

function validRelativePath(value: unknown): value is string {
  return typeof value === 'string' && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(value) && !value.startsWith('//')
}

function isAttributed(evidence: CapabilityEvidence): boolean {
  return Boolean(evidence.evidenceRef?.trim() && evidence.verifiedBy?.trim() && evidence.verifiedAt?.trim())
}

function evidenceFor(evidence: readonly CapabilityEvidence[] | undefined, platform: Platform, capability: CapabilityName) {
  return evidence?.find(item => item.platform === platform && item.capability === capability)
}

/**
 * Computes the minimum safe readiness for a real connector. This deliberately
 * requires test-e2e evidence, not just documentation or fixture evidence.
 * Production-canary promotion remains a separate gate.
 */
export function validateConnectorReadiness(
  platform: Platform,
  config: HttpConnectorConfig | undefined,
  options: { allowTestAdapters?: boolean } = {},
): ConnectorReadiness {
  const reasons: ConnectorReadinessReason[] = []
  if (!config) {
    return { platform, ready: false, reasons: ['CONFIG_MISSING'], verifiedCapabilities: [] }
  }
  if (!config.clientId.trim()) reasons.push('CLIENT_ID_MISSING')
  if (!validUrl(config.oauth.authorizeUrl) || !validUrl(config.oauth.tokenUrl)) reasons.push('OAUTH_ENDPOINT_MISSING')
  if (!validUrl(config.api.baseUrl)) reasons.push('API_ENDPOINT_MISSING')
  const apiPaths = [config.api.syncPath, config.api.createPath, config.api.updatePath, config.api.queryPath]
  if (apiPaths.some(path => !path?.trim())) reasons.push('API_PATH_MISSING')
  else if (apiPaths.some(path => !validRelativePath(path))) reasons.push('API_PATH_MUST_BE_RELATIVE')
  if (!options.allowTestAdapters && isSecureEnvironment()) {
    const endpoints = [config.oauth.authorizeUrl, config.oauth.tokenUrl, config.oauth.refreshUrl, config.oauth.revokeUrl, config.api.baseUrl]
    const allowedHosts = config.allowedHosts ?? officialHostsFor(platform)
    for (const endpoint of endpoints) {
      if (!endpoint) continue
      const reason = inspectOutboundUrl(endpoint, { allowedHosts, resolveDns: false })
      if (reason) reasons.push(reason)
      if (isSecureEnvironment() && reason === 'HTTPS_REQUIRED') reasons.push('HTTPS_REQUIRED')
    }
  }
  // Test adapters intentionally provide only transport fixtures. They still
  // need valid client/endpoint shape, but do not pretend to have production
  // signer, mapping, or platform evidence.
  if (options.allowTestAdapters) return { platform, ready: reasons.length === 0, reasons, verifiedCapabilities: [] }
  if (!config.signer) reasons.push('SIGNER_MISSING')
  else if (config.signer.kind !== 'platform' && !options.allowTestAdapters) reasons.push('SIGNER_NOT_ATTESTED')
  if (!config.mapProducts) reasons.push('PRODUCT_MAPPING_MISSING')
  if (!config.mapWriteReceipt) reasons.push('WRITE_RECEIPT_MAPPING_MISSING')
  if (!config.mapWriteStatus) reasons.push('WRITE_STATUS_MAPPING_MISSING')
  const mapping = config.mappingEvidence
  if (!mapping?.version.trim() || !mapping.evidenceRef.trim() || !mapping.verifiedBy.trim() || !mapping.verifiedAt.trim()) reasons.push('MAPPING_EVIDENCE_MISSING')

  const verifiedCapabilities: CapabilityName[] = []
  for (const capability of REQUIRED_CONNECTOR_CAPABILITIES) {
    const item = evidenceFor(config.capabilityEvidence, platform, capability)
    if (options.allowTestAdapters) continue
    if (!item) {
      reasons.push('CAPABILITY_EVIDENCE_MISSING')
      continue
    }
    if (evidenceOrder.indexOf(item.state) < evidenceOrder.indexOf('test_e2e')) reasons.push('CAPABILITY_EVIDENCE_NOT_E2E')
    else if (!isAttributed(item)) reasons.push('CAPABILITY_EVIDENCE_UNATTRIBUTED')
    else verifiedCapabilities.push(capability)
  }
  return { platform, ready: reasons.length === 0, reasons: [...new Set(reasons)], verifiedCapabilities }
}
