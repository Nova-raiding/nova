# Durable worker

The worker is a separate Node process. It claims pending outbox rows per explicitly configured or PostgreSQL auto-discovered tenant, restores them into `DurableOutboxDispatcher`, processes the safe local events, and acknowledges only after the PostgreSQL state transition succeeds.

Required environment:

```text
DATABASE_URL=postgres://...
WORKER_WORKSPACES=workspace_a,workspace_b
```

For a dynamic merchant fleet, use `WORKER_WORKSPACES=auto` (or `WORKER_AUTO_DISCOVER=true`) to discover active workspaces on every poll. An empty scope without auto-discovery is rejected.

Optional: `REDIS_URL` enables a shared Redis list per workspace (`merchant:outbox:<workspace_id>`); without it the worker uses an in-process queue and relies on PostgreSQL lease recovery. `WORKER_POLL_INTERVAL_MS`, `WORKER_BATCH_SIZE`, `WORKER_WORKSPACE_BATCH_SIZE`, `WORKER_LEASE_MS`, and `WORKER_ONCE=true` are also available. The workspace batch cap defaults to 10 so a noisy tenant cannot consume a whole worker poll.

For production sync/publish execution, inject `WORKER_API_BASE_URL`, `WORKER_API_TOKEN`, and (in production) `WORKER_API_SIGNING_SECRET` so paginated sync progress, sync results, and verified connector observations can be written back to the API. The worker reads platform connector configuration and Vault credential settings from the process environment. Missing connector readiness, account binding, publish fields, or observation reporting fails closed into `unknown`.

`WORKER_ROLE=sync` claims `sync.requested` events. It reads the durable job cursor, executes the platform connector page by page, posts each page to `/v1/sync-jobs/:id/progress`, and posts the terminal state to `/v1/sync-jobs/:id/result`. Progress is page-number idempotent, so a lease-recovered event does not duplicate a committed page.

`state.snapshot` and `task.created` are validated, projected in-process, and acknowledged. In production, the publish worker injects `ConnectorRuntime` and executes only after the API execution gate, Vault credential lookup, payload-hash check, quota admission, connector write, and authoritative remote read-back. If the connector, credential, or observation path is unavailable, the event fails closed as `unknown`; this worker never infers `published` from a write receipt. The handler's `CONNECTOR_HANDLER_UNAVAILABLE` branch remains the safe default for an unconfigured embedding.

If the process stops after claiming an event, PostgreSQL lease expiry makes it claimable by the next worker. If the handler completes but the acknowledgement transaction fails, the dispatcher requeues the message and the next poll can safely recover it.
