import type { AccessCredential, CredentialProvider, CredentialRef, VaultCredentialProvider } from './types.js';
export interface VaultFetchLike {
    (input: string | URL, init?: RequestInit): Promise<Response>;
}
export interface VaultCredentialProviderOptions {
    address: string;
    token: string;
    mount?: string;
    namespace?: string;
    pathPrefix?: string;
    timeoutMs?: number;
    fetch?: VaultFetchLike;
}
/**
 * HashiCorp Vault KV v2 adapter. Credential refs are opaque `vault://...`
 * paths; access and refresh tokens never leave this provider boundary.
 */
export declare class VaultKvCredentialProvider implements VaultCredentialProvider {
    private readonly options;
    readonly kind: "vault";
    private readonly fetchImpl;
    private readonly address;
    private readonly mount;
    private readonly namespace?;
    private readonly pathPrefix;
    constructor(options: VaultCredentialProviderOptions);
    resolve(ref: CredentialRef | {
        accountId: string;
        credentialRef?: string;
    }): Promise<AccessCredential | undefined>;
    store(input: {
        workspaceId?: string;
        accountId: string;
        credential: AccessCredential;
    }): Promise<CredentialRef>;
    revoke(ref: CredentialRef): Promise<void>;
    private pathFrom;
    private request;
    private json;
}
export declare function createVaultCredentialProviderFromEnv(source?: Record<string, string | undefined>): CredentialProvider | undefined;
//# sourceMappingURL=vault-provider.d.ts.map