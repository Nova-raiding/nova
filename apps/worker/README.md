# Durable worker

The worker is a separate Node process. It claims pending outbox rows per explicitly configured or PostgreSQL auto-discovered tenant, restores them into `DurableOutboxDispatcher`, processes the safe local events, and acknowledges only after the PostgreSQL state transition succeeds.

Required environment:

```text
DATABASE_URL=postgres://...
WORKER_WORKSPACES=workspace_a,workspace_b
```

For a dynamic merchant fleet, use `WORKER_WORKSPACES=auto` (or `WORKER_AUTO_DISCOVER=true`) to discover active workspaces on every poll. An empty scope without auto-discovery is rejected.

Optional: `REDIS_URL` enables a Redis list isolated by worker role and workspace (`merchant:outbox:<role>:<workspace_id>`); without it the worker uses an in-process queue and relies on PostgreSQL lease recovery. `WORKER_POLL_INTERVAL_MS`, `STORAGE_RECONCILIATION_INTERVAL_MS`, `WORKER_BATCH_SIZE`, `WORKER_WORKSPACE_BATCH_SIZE`, `WORKER_LEASE_MS`, and `WORKER_ONCE=true` are also available. Storage reconciliation defaults to every 15 minutes so a reconcile worker does not rescan every queue poll. The workspace batch cap defaults to 10 so a noisy tenant cannot consume a whole worker poll.

For production execution, inject `WORKER_API_BASE_URL` plus a role-specific `WORKER_API_TOKEN` and `WORKER_API_SIGNING_SECRET`. The API must receive the corresponding `WORKER_API_CREDENTIALS` role map from its secret manager; credentials must not be shared between sync, generation, publish, reconcile, and automation workers. During rotation, one role may temporarily contain `[current, previous]` credentials (maximum two): expand API trust first, roll that worker, then remove the previous credential. Every callback proof binds the role, method, exact request target, workspace, body digest, timestamp, and one-time nonce. The worker reads platform connector configuration and Vault credential settings from the process environment. Missing connector readiness, account binding, publish fields, observation reporting, role credentials, or replay storage fails closed.

`WORKER_ROLE=sync` claims `sync.requested` events. It reads the durable job cursor, executes the platform connector page by page, posts each page to `/v1/sync-jobs/:id/progress`, and posts the terminal state to `/v1/sync-jobs/:id/result`. Progress is page-number idempotent, so a lease-recovered event does not duplicate a committed page.

`state.snapshot` and `task.created` are validated, projected in-process, and acknowledged. In production, the publish worker injects `ConnectorRuntime` and executes only after the API execution gate, Vault credential lookup, payload-hash check, quota admission, connector write, and authoritative remote read-back. If the connector, credential, or observation path is unavailable, the event fails closed as `unknown`; this worker never infers `published` from a write receipt. The handler's `CONNECTOR_HANDLER_UNAVAILABLE` branch remains the safe default for an unconfigured embedding.

Critical outbox work also has a separate execution-authorization boundary. The durable event must carry an `authorization_snapshot` (schema, enqueue decision, actor, workspace context/version, policy version, grant revision, capability, resource, allow result, and decision time), and an injected authority must return a fresh live recheck bound to the same actor, workspace context, capability, and aggregate immediately before the external callback. Missing or malformed snapshots are dead-lettered before the side effect; revoked decisions are denied; stale/malformed/unavailable live evidence fails closed. The producer contract and authoritative recheck repository are not yet fully wired across these event types, so production publish, reconcile, generation, image-generation, sync, and image-continuation events without both forms of evidence are intentionally blocked with `AUTHZ_EXECUTION_SNAPSHOT_INVALID` or `AUTHZ_EXECUTION_RECHECK_UNAVAILABLE` rather than manufacturing authorization evidence.

If the process stops after claiming an event, PostgreSQL lease expiry makes it claimable by the next worker. If the handler completes but the acknowledgement transaction fails, the dispatcher requeues the message and the next poll can safely recover it.
