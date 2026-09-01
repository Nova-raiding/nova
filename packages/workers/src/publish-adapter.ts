import type { ConnectorContext, PlatformConnector, PlatformWriteDraft, WriteIdentity } from '../../connectors/src/types.js'
import { WorkerFailure } from './runner.js'
import type { PublishPayload, ReconcilePayload } from './factories.js'
import type { WorkerContext } from './types.js'

export interface PublishAdapterInput extends PublishPayload {
  accountId: string
  fields: PlatformWriteDraft['fields']
}

export interface PublishHandlerResult {
  receipt?: Awaited<ReturnType<PlatformConnector['updateProduct']>>
  /** The only authoritative post-write state; the write receipt is merely acceptance. */
  remoteStatus: Awaited<ReturnType<PlatformConnector['queryWrite']>>
}

export function createPublishHandler(connector: PlatformConnector, inputFor: (payload: PublishPayload) => Promise<PublishAdapterInput>) {
  return async (context: WorkerContext<PublishPayload>) => {
    const input = await inputFor(context.job.payload)
    const remoteId = typeof input.remoteId === 'string' && input.remoteId.trim()
      ? input.remoteId.trim()
      : typeof input.fields.remoteId === 'string' && input.fields.remoteId.trim()
        ? input.fields.remoteId.trim()
        : undefined
    const findings = connector.validateWrite({ fields: input.fields, ...(remoteId ? { remoteId } : {}), idempotencyKey: input.idempotencyKey })
    if (findings.some(finding => finding.severity === 'error')) throw new WorkerFailure({ code: 'VALIDATION_FAILED', message: findings.map(finding => finding.message).join('; '), retryable: false })
    try {
      const connectorContext = { workspaceId: context.job.workspaceId, accountId: input.accountId, traceId: context.job.id } satisfies ConnectorContext
      const draft = { fields: input.fields, ...(remoteId ? { remoteId } : {}), idempotencyKey: input.idempotencyKey }
      const receipt = remoteId
        ? await connector.updateProduct(connectorContext, draft)
        : await connector.createProduct(connectorContext, draft)
      // A 2xx/write receipt is not publication proof. Always query the remote
      // status before exposing a successful publish outcome to the application.
      let remoteStatus: Awaited<ReturnType<PlatformConnector['queryWrite']>>
      try {
        remoteStatus = await connector.queryWrite(connectorContext, { idempotencyKey: input.idempotencyKey, remoteId: receipt.remoteId })
      } catch (error) {
        // The write may already have reached the platform. An unstructured
        // query failure therefore cannot be retried as a fresh write: retain
        // the idempotency key and require reconciliation to prove absence or
        // completion before another attempt.
        const normalized = 'normalized' in Object(error) ? (error as { normalized: ReturnType<PlatformConnector['normalizeError']> }).normalized : connector.normalizeError(error)
        throw new WorkerFailure({ code: 'PUBLISH_STATUS_UNKNOWN', message: `发布写入已受理，但远端状态查询失败：${normalized.message}`, retryable: false, unknown: true })
      }
      const result: PublishHandlerResult = { receipt, remoteStatus }
      if (!remoteStatus.found || remoteStatus.state === 'unknown') return { state: 'unknown' as const, value: result }
      return { value: result }
    } catch (error) {
      if (error instanceof WorkerFailure) throw error
      const normalized = 'normalized' in Object(error) ? (error as { normalized: ReturnType<PlatformConnector['normalizeError']> }).normalized : connector.normalizeError(error)
      throw new WorkerFailure({ code: normalized.code, message: normalized.message, retryable: normalized.retryable, unknown: normalized.unknown })
    }
  }
}

export function createReconcileHandler(connector: PlatformConnector, contextFor: (payload: ReconcilePayload) => Promise<ConnectorContext>, identityFor: (payload: ReconcilePayload) => WriteIdentity) {
  return async (context: WorkerContext<ReconcilePayload>) => {
    const status = await connector.queryWrite(await contextFor(context.job.payload), identityFor(context.job.payload))
    if (!status.found || status.state === 'unknown') return { state: 'unknown' as const, value: status }
    return { value: status }
  }
}
