export interface OutboxEvent {
    id: string;
    workspaceId: string;
    aggregateId: string;
    eventType: string;
    sequence: number;
    payload: Record<string, unknown>;
    publishedAt?: string;
    createdAt: string;
    attempts?: number;
    nextAttemptAt?: string;
    leaseToken?: string;
    leaseUntil?: string;
    lastError?: Record<string, unknown>;
    unknownAt?: string;
}
export type OutboxEventInput = Omit<OutboxEvent, 'id' | 'createdAt'>;
/**
 * A deliberately small structural subset of pg's Pool/PoolClient API.
 *
 * Keeping this port local means applications can pass a `pg.Pool` without
 * making `pg` a dependency of this package (or of local tests/builds).
 */
export interface SqlQueryResult<Row = Record<string, unknown>> {
    rows: Row[];
    rowCount?: number | null;
}
export interface SqlClient {
    query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
    release?: () => void;
}
export interface SqlPool {
    connect(): Promise<SqlClient>;
}
export interface OutboxRepository {
    append(input: OutboxEventInput): Promise<OutboxEvent>;
    pending(workspaceId: string, limit?: number): Promise<OutboxEvent[]>;
    markPublished(workspaceId: string, id: string, publishedAt?: string): Promise<OutboxEvent>;
    listAggregateEvents(workspaceId: string, aggregateId: string, limit?: number): Promise<OutboxEvent[]>;
    listWorkspaceEvents?(workspaceId: string, limit?: number): Promise<OutboxEvent[]>;
}
export interface OutboxFailure {
    code: string;
    message: string;
    retryable: boolean;
    unknown?: boolean;
}
export interface DurableOutboxRepository extends OutboxRepository {
    claimPending(workspaceId: string, options?: OutboxClaimOptions): Promise<OutboxEvent[]>;
    recordFailure(workspaceId: string, id: string, failure: OutboxFailure, nextAttemptAt: string, leaseToken?: string): Promise<OutboxEvent>;
    markUnknown(workspaceId: string, id: string, failure: OutboxFailure, leaseToken?: string): Promise<OutboxEvent>;
    ack(workspaceId: string, id: string, leaseToken?: string, publishedAt?: string): Promise<OutboxEvent>;
    loadStateSnapshots(workspaceId: string): Promise<Array<{
        aggregateId: string;
        sequence: number;
        payload: Record<string, unknown>;
    }>>;
    listActiveWorkspaceIds(): Promise<string[]>;
}
/** Optional routing constraints used by independently scaled worker pools. */
export interface OutboxClaimOptions {
    limit?: number;
    leaseMs?: number;
    now?: string;
    eventTypes?: readonly string[];
    snapshotEntityTypes?: readonly string[];
}
export declare class TenantScopeError extends Error {
    constructor();
}
export declare class OutboxEventNotFoundError extends Error {
    readonly code = "OUTBOX_EVENT_NOT_FOUND";
    constructor();
}
export declare class InMemoryOutbox {
    private readonly events;
    append(input: OutboxEventInput): OutboxEvent;
    pending(limit?: number): OutboxEvent[];
    markPublished(id: string): OutboxEvent;
    all(): OutboxEvent[];
    listAggregateEvents(workspaceId: string, aggregateId: string, limit?: number): OutboxEvent[];
    listWorkspaceEvents(workspaceId: string, limit?: number): OutboxEvent[];
}
export declare function requireWorkspaceScope(workspaceId: string | undefined): string;
/**
 * PostgreSQL-backed outbox repository. Every public operation owns a short
 * transaction so the RLS setting cannot leak between pooled connections.
 */
export declare class PostgresOutboxRepository implements DurableOutboxRepository {
    private readonly pool;
    constructor(pool: SqlPool);
    append(input: OutboxEventInput): Promise<OutboxEvent>;
    /** Append inside a caller-owned transaction for atomic business+outbox writes. */
    appendInTransaction(client: SqlClient, input: OutboxEventInput): Promise<OutboxEvent>;
    pending(workspaceId: string, limit?: number): Promise<OutboxEvent[]>;
    markPublished(workspaceId: string, id: string, publishedAt?: string): Promise<OutboxEvent>;
    listAggregateEvents(workspaceId: string, aggregateId: string, limit?: number): Promise<OutboxEvent[]>;
    listWorkspaceEvents(workspaceId: string, limit?: number): Promise<OutboxEvent[]>;
    claimPending(workspaceId: string, options?: OutboxClaimOptions): Promise<OutboxEvent[]>;
    recordFailure(workspaceId: string, id: string, failure: OutboxFailure, nextAttemptAt: string, leaseToken?: string): Promise<OutboxEvent>;
    markUnknown(workspaceId: string, id: string, failure: OutboxFailure, leaseToken?: string): Promise<OutboxEvent>;
    ack(workspaceId: string, id: string, leaseToken?: string, publishedAt?: string): Promise<OutboxEvent>;
    loadStateSnapshots(workspaceId: string): Promise<{
        aggregateId: string;
        sequence: number;
        payload: Record<string, unknown>;
    }[]>;
    listActiveWorkspaceIds(): Promise<string[]>;
}
/**
 * Runs work with an RLS scope local to the current transaction.
 * `set_config(..., true)` is PostgreSQL's parameter-safe equivalent of
 * `SET LOCAL app.workspace_id = ...`; unlike string interpolation it keeps
 * arbitrary workspace ids out of SQL text.
 */
export declare function withWorkspaceTransaction<T>(pool: SqlPool, workspaceId: string | undefined, work: (client: SqlClient) => Promise<T>): Promise<T>;
//# sourceMappingURL=repository.d.ts.map