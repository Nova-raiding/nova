# Billing and commercial write acceptance, isolated runtime

- Date: 2026-09-29 UTC.
- Runtime: newly created, automatically disposed local PostgreSQL fixture; local API and local stdio plugin bridge. No production database write or real provider payment.
- Test report: `artifacts/isolated-postgres/run-nZfsWz/vitest.json` (`tests/mcp-oauth-commercial-payment.postgres.test.ts`: 1 passed).
- Merchant identity: local plugin PKCE-issued merchant tokens. `ops.session` returned `workbench=workspace`; `ops.users.list` was denied with HTTP 403. The second merchant member could not read the first member's order.

| Flow | Observed result |
| --- | --- |
| `commercial.order.create` for approved `points_500` SKU | Created a pending order using the server-owned ¥300 fixture price and a fixture checkout URL. |
| Signed provider callback and replay | First callback marked the order paid; the repeated callback reported `replayed=true`. |
| `commercial.order.payment.get` | Paid order reported `access_revision=1`; second merchant member received `COMMERCIAL_ORDER_NOT_FOUND`. |
| `creative-points.balance.get` | Reported 500 available points and access revision 1. Database contained one grant, one payment event and one granted ledger event. |
| `commercial.service-boundary.accept` in a funded local API fixture | First call: HTTP 200, `accepted=true`, `replayed=false`; exact replay: HTTP 200, `replayed=true`; conflicting idempotency key: HTTP 409 `SERVICE_BOUNDARY_ACCEPTANCE_CONFLICT`; stale policy checksum: HTTP 409 `SERVICE_BOUNDARY_POLICY_VERSION_INVALID`. |
| `commercial.service-boundary.accept` with unknown balance | HTTP 503 `CREATIVE_POINTS_UNAVAILABLE`, before recording acceptance. |

Additional targeted tests passed: 10 files / 71 tests for commercial access, purchase, payment, contracts and API; 4 files / 94 tests for recharge reconciliation, payment provider and fixture guards.

The production demo has read-only billing evidence in `billing-readonly-audit.md`. This isolated test is not evidence of a real Alipay charge, a production order creation, or a customer accepting service terms in production.
