import type { CapabilityName } from './capability-evidence.js';
import type { HttpConnectorConfig, Platform } from './types.js';
export declare const REQUIRED_CONNECTOR_CAPABILITIES: readonly CapabilityName[];
export type ConnectorReadinessReason = 'CONFIG_MISSING' | 'CLIENT_ID_MISSING' | 'OAUTH_ENDPOINT_MISSING' | 'API_ENDPOINT_MISSING' | 'API_PATH_MISSING' | 'API_PATH_MUST_BE_RELATIVE' | 'HTTPS_REQUIRED' | 'HOST_NOT_ALLOWLISTED' | 'PRIVATE_ADDRESS_BLOCKED' | 'INVALID_OUTBOUND_URL' | 'SIGNER_MISSING' | 'SIGNER_NOT_ATTESTED' | 'PRODUCT_MAPPING_MISSING' | 'WRITE_RECEIPT_MAPPING_MISSING' | 'WRITE_STATUS_MAPPING_MISSING' | 'MAPPING_EVIDENCE_MISSING' | 'CAPABILITY_EVIDENCE_MISSING' | 'CAPABILITY_EVIDENCE_NOT_E2E' | 'CAPABILITY_EVIDENCE_UNATTRIBUTED';
export interface ConnectorReadiness {
    platform: Platform;
    ready: boolean;
    reasons: readonly ConnectorReadinessReason[];
    verifiedCapabilities: readonly CapabilityName[];
}
/** OAuth is intentionally a narrower gate than catalog/publish readiness.
 * A merchant must be able to grant access before test-e2e catalog evidence can
 * be collected; sync and writes continue to require full connector readiness. */
export declare function validateConnectorAuthorizationReadiness(platform: Platform, config: HttpConnectorConfig | undefined): ConnectorReadiness;
/**
 * Computes the minimum safe readiness for a real connector. This deliberately
 * requires test-e2e evidence, not just documentation or fixture evidence.
 * Production-canary promotion remains a separate gate.
 */
export declare function validateConnectorReadiness(platform: Platform, config: HttpConnectorConfig | undefined, options?: {
    allowTestAdapters?: boolean;
}): ConnectorReadiness;
//# sourceMappingURL=readiness.d.ts.map