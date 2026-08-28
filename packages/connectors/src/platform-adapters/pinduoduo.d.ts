import type { PlatformWriteDraft, RawProduct, RequestSigner, WriteIdentity, WriteReceipt, WriteStatus } from '../types.js';
export interface PinduoduoSignerOptions {
    clientId: string;
    clientSecret: string;
    now?: () => Date;
}
/** Pinduoduo router signer. The generic connector supplies the API `type` in the URL. */
export declare function createPinduoduoSigner(options: PinduoduoSignerOptions): RequestSigner;
export declare function mapPinduoduoProducts(payload: unknown): RawProduct[];
export declare function mapPinduoduoWriteReceipt(payload: unknown, input: PlatformWriteDraft, operation: 'create' | 'update'): WriteReceipt;
export declare function mapPinduoduoWriteStatus(payload: unknown, request: WriteIdentity): WriteStatus;
//# sourceMappingURL=pinduoduo.d.ts.map