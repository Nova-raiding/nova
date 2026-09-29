# Production demo billing/commercial MCP read-only audit

- Time UTC: 2026-09-29T00:21:06.391648+00:00
- API origin: https://yxsona.com
- Workspace: ws_guirenniaoniao
- Session: production password login → short-lived MCP token → local stdio bridge; credentials not persisted or printed.
- All calls below are read-only. Both `*.get` calls with an invalid QA ID are expected not-found checks.

| Method | MCP result | Code/status | Redacted shape |
|---|---|---|---|
| `commercial.access.get` | ok |  | keys=decision |
| `commercial.catalog.get` | ok | available | keys=catalog,schema_version,status; list_counts={'catalog': 12} |
| `creative-points.balance.get` | ok |  | keys=access_revision,availability,available_points,balance_state,reserved_points,schema_version,settled_points,updated_at |
| `creative-points.statement.list` | ok |  | keys=entries,next_cursor,schema_version; list_counts={'entries': 20} |
| `subscription.get` | ok | trialing | keys=billingCycle,commercial_entitlement,currentPeriodEnd,currentPeriodStart,entitlements,includedStores,includedTasks,legacy_commercial_entitlement,planCode,planName,priceCny,revision,status,updatedAt,workspaceId; list_counts={'entitlements': 0} |
| `subscription.orders.list` | ok |  | structuredContent=list |
| `billing.export` | ok | MERCHANT_BILLING_EXPORT_CONSOLE_ONLY | keys=available,code,message,next_action,schema_version |
| `billing.status` | ok |  | keys=access_revision,allowed,availability,available_points,balance_state,next_actions,schema_version,viewer; list_counts={'next_actions': 3} |
| `billing.model-usage.statement` | ok |  | keys=available,message,next_action,schema_version |
| `billing.recharge.list` | ok |  | keys=legacy_unattributed_hidden,orders,returned,scope,summary,total; list_counts={'orders': 1} |
| `billing.transactions` | ok |  | keys=available,message,next_action,schema_version |
| `commercial.order.payment.get` | isError=true | COMMERCIAL_ORDER_NOT_FOUND | keys=code,message |
| `billing.recharge.get` | isError=true | BILLING_ORDER_NOT_FOUND | keys=code,message |

## Follow-up with existing own recharge order

- `billing.recharge.list` returned one own order in `pending` state. Its ID was used only in memory for `billing.recharge.get`; the get call returned the same `pending` state and order detail keys. No payment was confirmed or settled.
- `billing.model-usage.statement` and `billing.transactions` returned `available=true` with `next_action=open_merchant_console`; these are console handoff responses, not detailed ledger pages in ChatGPT.
- `billing.export` returned `available=false`, code `MERCHANT_BILLING_EXPORT_CONSOLE_ONLY`, `next_action=open_merchant_console`. This is an intentional product gate, not a successful in-ChatGPT export.
- The invalid-ID `*.get` checks returned `COMMERCIAL_ORDER_NOT_FOUND` and `BILLING_ORDER_NOT_FOUND` as expected.
