import { type ConnectorReadiness } from './readiness.js';
import type { AuthorizeInput, AuthorizeResult, ConnectorContext, CredentialProvider, CredentialRef, Cursor, HttpConnectorConfig, MappingVersion, NormalizedPlatformError, Platform, PlatformConnector, PlatformProfile, PlatformWriteDraft, ProductPage, RawProduct, WriteIdentity, WriteReceipt, WriteStatus, MediaUploadInput, MediaUploadReceipt } from './types.js';
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface HttpPlatformConnectorOptions {
    config?: HttpConnectorConfig;
    credentials?: CredentialProvider;
    fetch?: FetchLike;
    /** Explicit test-only escape hatch for an in-memory provider. */
    allowTestCredentials?: boolean;
    /** Explicit test-only escape hatch for test signer/mapping adapters. */
    allowTestAdapters?: boolean;
}
export declare class HttpPlatformConnector implements PlatformConnector {
    readonly profile: PlatformProfile;
    private readonly options;
    readonly platform: Platform;
    readonly readiness: ConnectorReadiness;
    readonly authorizationReadiness: ConnectorReadiness;
    private readonly fetchImpl;
    private readonly writes;
    constructor(profile: PlatformProfile, options: HttpPlatformConnectorOptions);
    private get config();
    mediaUploadReady(): boolean;
    mediaUploadReadiness(): {
        configured: boolean;
        evidence: boolean;
        ready: boolean;
    };
    private notConfigured;
    private requireConfig;
    private requireOAuthConfig;
    private requireRevokeConfig;
    private requireProvider;
    authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
    exchangeCode(input: {
        code: string;
        state: string;
        codeVerifier?: string;
        workspaceId?: string;
    }): Promise<CredentialRef>;
    refreshCredential(ref: CredentialRef): Promise<CredentialRef>;
    revoke(ref: CredentialRef): Promise<void>;
    syncProducts(ctx: ConnectorContext, cursor?: Cursor): Promise<ProductPage>;
    mapToCanonical(raw: RawProduct, mapping: MappingVersion): import("./types.js").CommerceProductDraft;
    validateWrite(input: PlatformWriteDraft): import("./types.js").ValidationFinding[];
    createProduct(ctx: ConnectorContext, input: PlatformWriteDraft): Promise<WriteReceipt>;
    updateProduct(ctx: ConnectorContext, input: PlatformWriteDraft): Promise<WriteReceipt>;
    queryWrite(ctx: ConnectorContext, request: WriteIdentity): Promise<WriteStatus>;
    uploadMedia(ctx: ConnectorContext, input: MediaUploadInput): Promise<MediaUploadReceipt>;
    normalizeError(error: unknown): NormalizedPlatformError;
    private write;
    private resolveCredential;
    private parseCredential;
    private request;
}
export declare function createHttpConnector(platform: Platform, options: HttpPlatformConnectorOptions): PlatformConnector;
//# sourceMappingURL=http-connector.d.ts.map