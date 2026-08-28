import type { ConnectorContext, PlatformConnector, PlatformWriteDraft, WriteIdentity } from '../../connectors/src/types.js';
import type { PublishPayload, ReconcilePayload } from './factories.js';
import type { WorkerContext } from './types.js';
export interface PublishAdapterInput extends PublishPayload {
    accountId: string;
    fields: PlatformWriteDraft['fields'];
}
export interface PublishHandlerResult {
    receipt?: Awaited<ReturnType<PlatformConnector['updateProduct']>>;
    /** The only authoritative post-write state; the write receipt is merely acceptance. */
    remoteStatus: Awaited<ReturnType<PlatformConnector['queryWrite']>>;
}
export declare function createPublishHandler(connector: PlatformConnector, inputFor: (payload: PublishPayload) => Promise<PublishAdapterInput>): (context: WorkerContext<PublishPayload>) => Promise<{
    state: "unknown";
    value: PublishHandlerResult;
} | {
    value: PublishHandlerResult;
    state?: undefined;
}>;
export declare function createReconcileHandler(connector: PlatformConnector, contextFor: (payload: ReconcilePayload) => Promise<ConnectorContext>, identityFor: (payload: ReconcilePayload) => WriteIdentity): (context: WorkerContext<ReconcilePayload>) => Promise<{
    state: "unknown";
    value: import("../../connectors/src/types.js").WriteStatus;
} | {
    value: import("../../connectors/src/types.js").WriteStatus;
    state?: undefined;
}>;
//# sourceMappingURL=publish-adapter.d.ts.map