import type { Platform } from './types.js';
export type CapabilityName = 'authorize' | 'read' | 'full_sync' | 'incremental_sync' | 'create' | 'update' | 'query_status' | 'revoke' | 'media_upload';
export type CapabilityEvidenceState = 'unverified' | 'documented' | 'fixture_verified' | 'test_e2e' | 'production_canary';
export interface CapabilityEvidence {
    platform: Platform;
    capability: CapabilityName;
    state: CapabilityEvidenceState;
    applicationId?: string;
    scope?: string;
    apiVersion?: string;
    testAccountId?: string;
    evidenceRef?: string;
    verifiedBy?: string;
    verifiedAt?: string;
}
export declare function advanceCapabilityEvidence(current: CapabilityEvidence, next: CapabilityEvidenceState, proof?: Partial<CapabilityEvidence>): CapabilityEvidence;
export declare function isProductionCanaryReady(evidence: readonly CapabilityEvidence[], platform: Platform): boolean;
//# sourceMappingURL=capability-evidence.d.ts.map