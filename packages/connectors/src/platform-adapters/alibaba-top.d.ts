import type { PlatformWriteDraft, RawProduct, RequestSigner, WriteIdentity, WriteReceipt, WriteStatus } from '../types.js';
export interface AlibabaTopSignerOptions {
    appKey: string;
    appSecret: string;
    now?: () => Date;
    signMethod?: 'hmac-sha256' | 'hmac' | 'md5';
}
/**
 * Alibaba TOP signer for Taobao/Tmall HTTP calls. The endpoint path must carry
 * the TOP `method` query parameter (for example
 * `?method=taobao.item.seller.get`). The access token is held in memory and
 * emitted as TOP's `session` form parameter for this request only.
 */
export declare function createAlibabaTopSigner(options: AlibabaTopSignerOptions): RequestSigner;
declare function formatTopTimestamp(value: Date): string;
export { formatTopTimestamp };
/** Conservative mapper for the common TOP item envelope. Unknown fields stay
 * in platformFields and are never promoted to confirmed facts automatically. */
export declare function mapAlibabaTopProducts(payload: unknown, platform: 'taobao' | 'tmall'): RawProduct[];
export declare function mapAlibabaTopWriteReceipt(payload: unknown, input: PlatformWriteDraft, operation: 'create' | 'update', platform: 'taobao' | 'tmall'): WriteReceipt;
export declare function mapAlibabaTopWriteStatus(payload: unknown, request: WriteIdentity, platform: 'taobao' | 'tmall'): WriteStatus;
//# sourceMappingURL=alibaba-top.d.ts.map