import type { AuthorizeInput, AuthorizeResult, ConnectorContext, CredentialRef, Cursor, FakeConnectorOptions, MappingVersion, NormalizedPlatformError, PlatformConnector, PlatformProfile, PlatformWriteDraft, ProductPage, RawProduct, WriteIdentity, WriteReceipt, WriteStatus } from './types.js';
export declare class FakePlatformConnector implements PlatformConnector {
    readonly profile: PlatformProfile;
    readonly platform: PlatformConnector['platform'];
    private readonly writes;
    private revoked;
    private readonly options;
    constructor(profile: PlatformProfile, options?: FakeConnectorOptions);
    private throwFault;
    private notConfigured;
    authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
    exchangeCode(input: {
        code: string;
        state: string;
        codeVerifier?: string;
        workspaceId?: string;
    }): Promise<CredentialRef>;
    refreshCredential(ref: CredentialRef): Promise<{
        expiresAt: string;
        accountId: string;
        credentialRef: string;
        workspaceId?: string;
        scope?: string;
        refreshable?: boolean;
    }>;
    revoke(_ref: CredentialRef): Promise<void>;
    syncProducts(_ctx: ConnectorContext, cursor?: Cursor): Promise<ProductPage>;
    mapToCanonical(raw: RawProduct, mapping: MappingVersion): import("./types.js").CommerceProductDraft;
    validateWrite(input: PlatformWriteDraft): import("./types.js").ValidationFinding[];
    createProduct(ctx: ConnectorContext, input: PlatformWriteDraft): Promise<WriteReceipt>;
    updateProduct(ctx: ConnectorContext, input: PlatformWriteDraft): Promise<WriteReceipt>;
    queryWrite(_ctx: ConnectorContext, request: WriteIdentity): Promise<WriteStatus>;
    normalizeError(error: unknown): NormalizedPlatformError;
    private write;
    private unauthorized;
}
export declare class ConnectorFailure extends Error {
    readonly normalized: NormalizedPlatformError;
    constructor(normalized: NormalizedPlatformError);
}
//# sourceMappingURL=fake-connector.d.ts.map