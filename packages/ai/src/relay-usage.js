import { createHash } from 'node:crypto';
export class ModelUsageSettlementPendingError extends Error {
    receiptKey;
    code = 'MODEL_USAGE_SETTLEMENT_PENDING';
    providerSucceeded = true;
    constructor(receiptKey) {
        super('model usage settlement is pending');
        this.receiptKey = receiptKey;
        this.name = 'ModelUsageSettlementPendingError';
    }
}
function record(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function finiteNonNegative(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        return undefined;
    return value;
}
function numberFrom(value) {
    if (typeof value === 'number')
        return finiteNonNegative(value);
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim()))
        return finiteNonNegative(Number(value));
    return undefined;
}
function firstNumber(...values) {
    for (const value of values) {
        const parsed = numberFrom(value);
        if (parsed !== undefined)
            return parsed;
    }
    return undefined;
}
export function relayUsageReceiptKey(usage) {
    const providerRequestId = usage.providerRequestId?.trim();
    if (providerRequestId)
        return providerRequestId;
    const identity = JSON.stringify([
        usage.workspaceId?.trim() ?? '',
        usage.actionId?.trim() ?? '',
        usage.model.trim(),
        usage.modality,
    ]);
    return `relay_usage_${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}
/** Extract the provider-neutral usage shape without trusting arbitrary response fields. */
export function parseRelayUsage(payload, headers, defaults) {
    const root = record(payload) ? payload : {};
    const usage = record(root.usage) ? root.usage : record(root.data) && record(root.data.usage) ? root.data.usage : undefined;
    const inputTokens = firstNumber(usage?.prompt_tokens, usage?.input_tokens, usage?.inputTokens);
    const outputTokens = firstNumber(usage?.completion_tokens, usage?.output_tokens, usage?.outputTokens);
    const totalTokens = firstNumber(usage?.total_tokens, usage?.totalTokens, inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
    const costCny = firstNumber(usage?.cost_cny, usage?.costCny, root.cost_cny, root.costCny, record(root.data) ? root.data.cost_cny : undefined, record(root.data) ? root.data.costCny : undefined);
    const providerRequestId = headers.get('x-request-id')?.trim() || headers.get('request-id')?.trim() || (typeof root.id === 'string' && root.id.trim() ? root.id.trim() : undefined);
    const usageObserved = inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined || costCny !== undefined;
    return {
        ...(defaults.context?.workspaceId ? { workspaceId: defaults.context.workspaceId } : {}),
        ...(defaults.context?.actionId ? { actionId: defaults.context.actionId } : {}),
        modality: defaults.modality,
        model: defaults.model,
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(costCny !== undefined ? { costCny } : {}),
        observedAt: new Date().toISOString(),
        metadata: { usage_observed: usageObserved },
    };
}
export async function emitRelayUsage(sink, payload, headers, defaults) {
    const usage = parseRelayUsage(payload, headers, defaults);
    if (usage && sink) {
        try {
            await sink(usage);
        }
        catch (error) {
            if (error?.code === 'MODEL_USAGE_COST_MISSING')
                throw error;
            throw new ModelUsageSettlementPendingError(relayUsageReceiptKey(usage));
        }
        usage.metadata = { ...(usage.metadata ?? {}), settlement: 'recorded' };
    }
    return usage;
}
//# sourceMappingURL=relay-usage.js.map
