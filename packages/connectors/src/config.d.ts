import type { GenericResponseMapping, HttpConnectorConfig, Platform } from './types.js';
import { type ConnectorReadiness } from './readiness.js';
/**
 * The application may provide this port from a secret/config service.  The
 * adapter never reads process.env directly; this keeps config parsing
 * deterministic and makes secret injection auditable.
 */
export type ConfigSource = Readonly<Record<string, string | undefined>>;
export interface StructuredPlatformConfig {
    clientId: string;
    clientSecret?: string;
    oauth: HttpConnectorConfig['oauth'];
    api: HttpConnectorConfig['api'];
    mediaUploadPath?: string;
    mediaUploadEvidence?: HttpConnectorConfig['mediaUploadEvidence'];
    timeoutMs?: number;
    allowedHosts?: readonly string[];
    signer?: HttpConnectorConfig['signer'];
    mapProducts?: HttpConnectorConfig['mapProducts'];
    mapWriteReceipt?: HttpConnectorConfig['mapWriteReceipt'];
    mapWriteStatus?: HttpConnectorConfig['mapWriteStatus'];
    mappingEvidence?: HttpConnectorConfig['mappingEvidence'];
    capabilityEvidence?: HttpConnectorConfig['capabilityEvidence'];
    responseMapping?: GenericResponseMapping;
}
export interface PlatformConfigBuildResult {
    configs: Partial<Record<Platform, HttpConnectorConfig>>;
    /** All syntactically complete candidates, including those held back by
     * evidence/readiness gates; used for operator diagnostics only. */
    allConfigs: Partial<Record<Platform, HttpConnectorConfig>>;
    /** Compatibility view for runtime consumers; contains only ready connectors. */
    candidates: Record<string, HttpConnectorConfig | undefined>;
    missing: Record<Platform, string[]>;
    readiness: Record<Platform, ConnectorReadiness>;
}
export declare function buildHttpConnectorConfigs(source?: ConfigSource): PlatformConfigBuildResult;
/** Builds the same six-platform map when configuration comes from a typed
 * secret/config service instead of process.env. No credentials are included
 * in this structure; those stay behind CredentialProvider. */
export declare function buildHttpConnectorConfigsFromStructured(source: Partial<Record<Platform, StructuredPlatformConfig>>): PlatformConfigBuildResult;
export declare function platformConfigPrefix(platform: Platform): string;
//# sourceMappingURL=config.d.ts.map