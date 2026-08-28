import type { RunnerOptions, WorkerError, WorkerHandler, WorkerJob, WorkerKind } from './types.js';
export declare class WorkerFailure extends Error {
    readonly error: WorkerError;
    constructor(error: WorkerError);
}
export declare class InMemoryJobRunner<T, R> {
    readonly kind: WorkerKind;
    private readonly handler;
    readonly jobs: Map<string, WorkerJob<T>>;
    private readonly idempotency;
    private readonly baseDelayMs;
    private readonly maxDelayMs;
    private readonly clock;
    private readonly idFactory;
    constructor(kind: WorkerKind, handler: WorkerHandler<T, R>, options?: RunnerOptions);
    enqueue(input: {
        workspaceId: string;
        idempotencyKey: string;
        payload: T;
        maxAttempts?: number;
    }): WorkerJob<T>;
    runNext(): Promise<WorkerJob<T> | undefined>;
    runUntilIdle(limit?: number): Promise<WorkerJob<T>[]>;
    retryUnknown(jobId: string, proof: {
        remoteAbsent: boolean;
        safeToRetry: boolean;
    }): WorkerJob<T>;
    private must;
}
export declare function normalizeWorkerError(cause: unknown): WorkerError;
//# sourceMappingURL=runner.d.ts.map