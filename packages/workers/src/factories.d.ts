import { InMemoryJobRunner } from './runner.js';
import type { HandlerResult, RunnerOptions, WorkerHandler } from './types.js';
export interface SyncPayload {
    accountId: string;
    cursor?: string;
}
export interface GenerationPayload {
    taskId: string;
    directionVersion: string;
}
export interface PublishPayload {
    taskId: string;
    contentVersionId: string;
    platform: string;
    idempotencyKey: string;
    fields?: Record<string, unknown>;
    remoteId?: string;
}
export interface ReconcilePayload {
    publishJobId: string;
    idempotencyKey: string;
}
export declare function createSyncWorker<R = unknown>(handler: WorkerHandler<SyncPayload, R>, options?: RunnerOptions): InMemoryJobRunner<SyncPayload, R>;
export declare function createGenerationWorker<R = unknown>(handler: WorkerHandler<GenerationPayload, R>, options?: RunnerOptions): InMemoryJobRunner<GenerationPayload, R>;
export declare function createPublishWorker<R = unknown>(handler: WorkerHandler<PublishPayload, R>, options?: RunnerOptions): InMemoryJobRunner<PublishPayload, R>;
export declare function createReconcileWorker<R = unknown>(handler: WorkerHandler<ReconcilePayload, R>, options?: RunnerOptions): InMemoryJobRunner<ReconcilePayload, R>;
export type AnyHandlerResult = HandlerResult<unknown>;
//# sourceMappingURL=factories.d.ts.map