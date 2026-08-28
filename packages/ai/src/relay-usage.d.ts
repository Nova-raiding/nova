export type RelayUsageModality = 'text' | 'image' | 'image_edit' | 'ocr' | 'video';
export interface RelayUsageContext {
    workspaceId?: string;
    actionId?: string;
}
export interface RelayUsageRecord {
    workspaceId?: string;
    actionId?: string;
    modality: RelayUsageModality;
    model: string;
    providerRequestId?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costCny?: number;
    observedAt: string;
    metadata?: Record<string, unknown>;
}
export type RelayUsageSettlement = 'recorded' | 'unknown';
export type RelayUsageSink = (record: RelayUsageRecord) => void | Promise<void>;
export declare class ModelUsageSettlementPendingError extends Error {
    readonly receiptKey: string;
    readonly code = "MODEL_USAGE_SETTLEMENT_PENDING";
    readonly providerSucceeded = true;
    constructor(receiptKey: string);
}
export declare function relayUsageReceiptKey(usage: Pick<RelayUsageRecord, 'workspaceId' | 'actionId' | 'model' | 'modality' | 'providerRequestId'>): string;
/** Extract the provider-neutral usage shape without trusting arbitrary response fields. */
export declare function parseRelayUsage(payload: unknown, headers: Headers, defaults: {
    modality: RelayUsageModality;
    model: string;
    context?: RelayUsageContext;
}): RelayUsageRecord | undefined;
export declare function emitRelayUsage(sink: RelayUsageSink | undefined, payload: unknown, headers: Headers, defaults: {
    modality: RelayUsageModality;
    model: string;
    context?: RelayUsageContext;
}): Promise<RelayUsageRecord | undefined>;
//# sourceMappingURL=relay-usage.d.ts.map
