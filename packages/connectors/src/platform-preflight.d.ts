import { type ConnectorReadiness } from './readiness.js';
import type { CapabilityName } from './capability-evidence.js';
import type { HttpConnectorConfig, Platform, PlatformConnector } from './types.js';
export declare const PLATFORM_CAPABILITY_CONTRACT_PLATFORMS: readonly ["jd", "taobao", "tmall", "pinduoduo", "xiaohongshu", "douyin"];
export declare const PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES: readonly CapabilityName[];
export declare const PLATFORM_CAPABILITY_EVIDENCE_STATES: readonly ["unverified", "documented", "fixture_verified", "test_e2e", "production_canary"];
export type PlatformCapabilityEvidenceState = typeof PLATFORM_CAPABILITY_EVIDENCE_STATES[number];
export interface PlatformCapabilityEvidenceDocument {
    schema_version?: string;
    release_id?: string;
    environment?: string;
    generated_at?: string;
    platforms?: Array<{
        platform?: string;
        application_id?: string;
        test_store_id?: string;
        capabilities?: Record<string, {
            state?: string;
            evidence_ref?: string;
            verified_by?: string;
            verified_at?: string;
            api_version?: string;
            scope?: string;
        }>;
    }>;
}
export interface PlatformPreflightCheck {
    name: string;
    passed: boolean;
    detail?: string;
}
export interface PlatformPreflightPlatformResult {
    platform: Platform;
    contractPassed: boolean;
    checks: readonly PlatformPreflightCheck[];
    readiness?: ConnectorReadiness;
    productionCanaryReady: boolean;
    gaps: readonly string[];
}
export interface PlatformPreflightResult {
    passed: boolean;
    fixtureContractPassed: boolean;
    evidenceValid: boolean;
    productionReady: boolean;
    platforms: readonly PlatformPreflightPlatformResult[];
    gaps: readonly string[];
}
export interface PlatformPreflightOptions {
    /** Optional real connector configs. No credential provider or token is needed for this check. */
    configs?: Partial<Record<Platform, HttpConnectorConfig>>;
    /** Optional evidence JSON loaded by the caller from a secure artifact. */
    evidence?: unknown;
    requireProductionCanary?: boolean;
    /** Factory injection makes the fixture contract deterministic and testable. */
    createConnector?: (platform: Platform) => PlatformConnector;
}
/**
 * Validates the release-bound, secret-free evidence matrix. This is deliberately
 * independent of HTTP and credentials: it checks evidence quality, not whether
 * a platform accepted a request.
 */
export declare function validatePlatformCapabilityEvidence(document: unknown, options?: {
    requireCanary?: boolean;
    expectedReleaseId?: string;
}): string[];
/**
 * Runs the no-credential platform preflight. A passing fixture contract proves
 * the six adapters expose the same safe port; it never promotes a platform to
 * production readiness without real evidence and a ready HTTP configuration.
 */
export declare function runPlatformPreflight(options?: PlatformPreflightOptions): Promise<PlatformPreflightResult>;
//# sourceMappingURL=platform-preflight.d.ts.map