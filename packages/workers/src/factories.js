import { InMemoryJobRunner } from './runner.js';
export function createSyncWorker(handler, options) { return new InMemoryJobRunner('sync', handler, options); }
export function createGenerationWorker(handler, options) { return new InMemoryJobRunner('generation', handler, options); }
export function createPublishWorker(handler, options) { return new InMemoryJobRunner('publish', handler, options); }
export function createReconcileWorker(handler, options) { return new InMemoryJobRunner('reconcile', handler, options); }
//# sourceMappingURL=factories.js.map