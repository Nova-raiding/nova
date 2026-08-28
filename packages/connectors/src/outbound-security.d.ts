import type { Platform } from './types.js';
export type OutboundSecurityReason = 'HTTPS_REQUIRED' | 'HOST_NOT_ALLOWLISTED' | 'PRIVATE_ADDRESS_BLOCKED' | 'INVALID_OUTBOUND_URL';
/**
 * Exact production hosts published by the platform adapters. An installation
 * may add an explicitly reviewed host through HttpConnectorConfig.allowedHosts;
 * wildcards are never implied by a parent domain.
 */
export declare const OFFICIAL_PLATFORM_HOSTS: Readonly<Record<Platform, readonly string[]>>;
export interface OutboundUrlPolicy {
    environment?: string;
    allowedHosts?: readonly string[];
    /** Used only for a trusted Vault endpoint explicitly allowlisted by an operator. */
    allowPrivateHosts?: boolean;
    resolveDns?: boolean;
}
export declare function isSecureEnvironment(environment?: string | undefined): boolean;
export declare function inspectOutboundUrl(raw: string, policy?: OutboundUrlPolicy): OutboundSecurityReason | undefined;
export declare function assertOutboundUrl(raw: string, policy?: OutboundUrlPolicy): Promise<void>;
export declare function officialHostsFor(platform: Platform): readonly string[];
//# sourceMappingURL=outbound-security.d.ts.map