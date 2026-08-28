import { randomUUID } from 'node:crypto';
export class WorkerFailure extends Error {
    error;
    constructor(error) {
        super(error.message);
        this.error = error;
    }
}
export class InMemoryJobRunner {
    kind;
    handler;
    jobs = new Map();
    idempotency = new Map();
    baseDelayMs;
    maxDelayMs;
    clock;
    idFactory;
    constructor(kind, handler, options = {}) {
        this.kind = kind;
        this.handler = handler;
        this.baseDelayMs = options.baseDelayMs ?? 100;
        this.maxDelayMs = options.maxDelayMs ?? 30_000;
        this.clock = options.now ?? (() => Date.now());
        this.idFactory = options.idFactory ?? (() => randomUUID());
    }
    enqueue(input) {
        // Idempotency is tenant-scoped. A merchant-supplied key may legitimately
        // be reused in another workspace and must never return that workspace's job.
        const scopedKey = `${input.workspaceId.length}:${input.workspaceId}:${input.idempotencyKey}`;
        const existingId = this.idempotency.get(scopedKey);
        if (existingId)
            return this.jobs.get(existingId);
        const job = { id: `job_${this.idFactory()}`, kind: this.kind, workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey, payload: input.payload, attempt: 0, maxAttempts: input.maxAttempts ?? 5, state: 'queued', notBefore: this.clock(), createdAt: this.clock() };
        this.jobs.set(job.id, job);
        this.idempotency.set(scopedKey, job.id);
        return job;
    }
    async runNext() {
        const job = [...this.jobs.values()].find(candidate => candidate.state === 'queued' && candidate.notBefore <= this.clock());
        if (!job)
            return undefined;
        job.state = 'running';
        job.attempt += 1;
        try {
            const result = await this.handler({ job, now: this.clock(), attempt: job.attempt });
            const normalized = result && typeof result === 'object' && ('state' in result || 'value' in result) ? result : { value: result };
            job.result = normalized.value;
            job.state = normalized.state ?? 'succeeded';
            return job;
        }
        catch (cause) {
            const error = normalizeWorkerError(cause);
            job.lastError = error;
            if (error.unknown) {
                job.state = 'unknown';
            }
            else if (error.retryable && job.attempt < job.maxAttempts) {
                job.state = 'queued';
                job.notBefore = this.clock() + Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (job.attempt - 1));
            }
            else {
                job.state = job.attempt >= job.maxAttempts && error.retryable ? 'dead_letter' : 'failed';
            }
            return job;
        }
    }
    async runUntilIdle(limit = 100) {
        const completed = [];
        for (let index = 0; index < limit; index += 1) {
            const job = await this.runNext();
            if (!job)
                break;
            completed.push(job);
        }
        return completed;
    }
    retryUnknown(jobId, proof) {
        const job = this.must(jobId);
        if (job.state !== 'unknown')
            throw new Error('Only unknown jobs can be reconciled');
        if (!proof.remoteAbsent || !proof.safeToRetry)
            throw new Error('Unknown job requires remote absence and connector safe-retry proof');
        job.state = 'queued';
        job.notBefore = this.clock();
        return job;
    }
    must(id) { const job = this.jobs.get(id); if (!job)
        throw new Error(`Job ${id} not found`); return job; }
}
export function normalizeWorkerError(cause) {
    if (cause instanceof WorkerFailure)
        return cause.error;
    const candidate = cause;
    return { code: candidate?.code ?? 'WORKER_ERROR', message: candidate?.message ?? 'Worker execution failed', retryable: candidate?.retryable ?? false, unknown: candidate?.unknown ?? false };
}
//# sourceMappingURL=runner.js.map