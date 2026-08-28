import { InMemoryJobRunner } from './runner.js'
import type { HandlerResult, RunnerOptions, WorkerHandler } from './types.js'

export interface SyncPayload { accountId: string; cursor?: string }
export interface GenerationPayload { taskId: string; directionVersion: string }
export interface PublishPayload { taskId: string; contentVersionId: string; platform: string; idempotencyKey: string; fields?: Record<string, unknown>; remoteId?: string }
export interface ReconcilePayload { publishJobId: string; idempotencyKey: string }

export function createSyncWorker<R = unknown>(handler: WorkerHandler<SyncPayload, R>, options?: RunnerOptions) { return new InMemoryJobRunner('sync', handler, options) }
export function createGenerationWorker<R = unknown>(handler: WorkerHandler<GenerationPayload, R>, options?: RunnerOptions) { return new InMemoryJobRunner('generation', handler, options) }
export function createPublishWorker<R = unknown>(handler: WorkerHandler<PublishPayload, R>, options?: RunnerOptions) { return new InMemoryJobRunner('publish', handler, options) }
export function createReconcileWorker<R = unknown>(handler: WorkerHandler<ReconcilePayload, R>, options?: RunnerOptions) { return new InMemoryJobRunner('reconcile', handler, options) }

export type AnyHandlerResult = HandlerResult<unknown>
