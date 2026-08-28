import type { CapabilityEvidence, CapabilityName } from './capability-evidence.js';
import type { ConnectorContext, Platform, PlatformConnector } from './types.js';
export interface PlatformCanaryInput {
    connector: PlatformConnector;
    context: ConnectorContext;
    evidenceRef: string;
    verifiedBy: string;
    verifiedAt?: string;
    apiVersion: string;
    scope: string;
    /** Real create/update calls are opt-in because they mutate a test store. */
    allowWrite: boolean;
    /** Revoke is separately opt-in because it invalidates the test account. */
    allowRevoke: boolean;
    writeFields?: Record<string, unknown>;
    /** A controlled test image used to prove the platform media-upload mapping. */
    mediaFile?: {
        bytes: Uint8Array;
        mimeType: string;
        sha256: string;
    };
}
export interface PlatformCanaryCheck {
    capability: CapabilityName;
    passed: boolean;
    simulated: boolean;
    detail?: string;
}
export interface PlatformCanaryResult {
    platform: Platform;
    passed: boolean;
    checks: readonly PlatformCanaryCheck[];
    evidence: readonly CapabilityEvidence[];
}
/**
 * Executes the real connector boundary against a controlled test store. This
 * runner never invents production_canary evidence: every write/revoke check
 * must be explicitly enabled and every response must be non-simulated.
 */
export declare function runPlatformCanary(input: PlatformCanaryInput): Promise<PlatformCanaryResult>;
//# sourceMappingURL=canary.d.ts.map