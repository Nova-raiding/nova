import type { PlatformWriteDraft, RawProduct, RequestSigner, WriteIdentity, WriteReceipt, WriteStatus } from '../types.js';
export interface JdSignerOptions {
    appKey: string;
    appSecret: string;
    now?: () => Date;
}
/** JD Open Platform routerjson signer. Values are signed before URL encoding. */
export declare function createJdSigner(options: JdSignerOptions): RequestSigner;
declare function formatJdTimestamp(value: Date): string;
export declare function mapJdProducts(payload: unknown): RawProduct[];
export declare function mapJdWriteReceipt(payload: unknown, input: PlatformWriteDraft, operation: 'create' | 'update'): WriteReceipt;
export declare function mapJdWriteStatus(payload: unknown, request: WriteIdentity): WriteStatus;
export { formatJdTimestamp };
//# sourceMappingURL=jd.d.ts.map