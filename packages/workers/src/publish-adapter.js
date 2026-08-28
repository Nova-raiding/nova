import { WorkerFailure } from './runner.js';
export function createPublishHandler(connector, inputFor) {
    return async (context) => {
        const input = await inputFor(context.job.payload);
        const remoteId = typeof input.remoteId === 'string' && input.remoteId.trim()
            ? input.remoteId.trim()
            : typeof input.fields.remoteId === 'string' && input.fields.remoteId.trim()
                ? input.fields.remoteId.trim()
                : undefined;
        const findings = connector.validateWrite({ fields: input.fields, ...(remoteId ? { remoteId } : {}), idempotencyKey: input.idempotencyKey });
        if (findings.some(finding => finding.severity === 'error'))
            throw new WorkerFailure({ code: 'VALIDATION_FAILED', message: findings.map(finding => finding.message).join('; '), retryable: false });
        try {
            const connectorContext = { workspaceId: context.job.workspaceId, accountId: input.accountId, traceId: context.job.id };
            const draft = { fields: input.fields, ...(remoteId ? { remoteId } : {}), idempotencyKey: input.idempotencyKey };
            const receipt = remoteId
                ? await connector.updateProduct(connectorContext, draft)
                : await connector.createProduct(connectorContext, draft);
            // A 2xx/write receipt is not publication proof. Always query the remote
            // status before exposing a successful publish outcome to the application.
            const remoteStatus = await connector.queryWrite(connectorContext, { idempotencyKey: input.idempotencyKey, remoteId: receipt.remoteId });
            const result = { receipt, remoteStatus };
            if (!remoteStatus.found || remoteStatus.state === 'unknown')
                return { state: 'unknown', value: result };
            return { value: result };
        }
        catch (error) {
            const normalized = 'normalized' in Object(error) ? error.normalized : connector.normalizeError(error);
            throw new WorkerFailure({ code: normalized.code, message: normalized.message, retryable: normalized.retryable, unknown: normalized.unknown });
        }
    };
}
export function createReconcileHandler(connector, contextFor, identityFor) {
    return async (context) => {
        const status = await connector.queryWrite(await contextFor(context.job.payload), identityFor(context.job.payload));
        if (!status.found || status.state === 'unknown')
            return { state: 'unknown', value: status };
        return { value: status };
    };
}
//# sourceMappingURL=publish-adapter.js.map