# Internal alert receiver

This service is the auditable receiver for Store Nova operational-alert webhooks. It is deliberately separate from the merchant API.

- Bind it to loopback or a private network. The default is `127.0.0.1:8791`, deliberately distinct from the payment gateway on 8790.
- Terminate public HTTPS at the existing trusted reverse proxy and proxy only `POST /internal/v1/alerts` to this service. Do not expose the container port publicly.
- Project `ALERT_RECEIVER_HMAC_SECRET_FILE` from the same secret-manager value used by the sender's `OPS_ALERT_WEBHOOK_SECRET_FILE`; never put the value in Compose, source control, or a production environment variable. Direct `ALERT_RECEIVER_HMAC_SECRET` / `OPS_ALERT_WEBHOOK_SECRET` values remain only for controlled local tests.
- Containers must use `ALERT_RECEIVER_HMAC_SECRET_FILE` and `ALERT_RECEIVER_DATABASE_URL_FILE`; direct values exist only for controlled local tests. Defining both forms is rejected. A missing, unreadable, or empty projected file prevents startup.
- The database URL secret must authenticate as the dedicated `merchant_alert_receiver` role. Do not reuse the API (`merchant_app`), operations (`merchant_ops`), or schema-owner credential. The receiver role has no direct table privileges; it can execute only `public.append_alert_webhook_receipt(text,text,timestamptz,timestamptz,text,jsonb)` and `public.alert_webhook_receipts_ready()`.
- Configure the sender URL as `https://<controlled-host>/internal/v1/alerts` and keep that host in `OPS_ALERT_WEBHOOK_ALLOWED_HOSTS`.

`GET /healthz` checks the process only. `GET /readyz` verifies the audit table through the database role. A valid alert returns HTTP 202. Replayed `request_id` or `alert_id` returns HTTP 409. Invalid, stale, or modified messages are rejected before persistence.

The persisted payload is the exact authenticated envelope plus its SHA-256 digest, receipt time and sender time. Rejected messages log only status, code and request ID; the alert body and secret are never logged.

This receiver proves authenticated delivery and durable receipt only. It is not an on-call provider, pager, escalation policy, or evidence that a human acknowledged an alert. Production readiness still requires a separately operated human-notification channel.

## The delivery chain ends in a table

```text
API sweepOperationalAlerts() -> notifyOperationalAlert() (HMAC POST OPS_ALERT_WEBHOOK_URL)
  -> POST /internal/v1/alerts -> public.alert_webhook_receipts
  + workspace_operation_alert_notifications (delivery / attempts / reason)
```

Nothing after this receiver pushes a signal to a human. Two consequences are deliberate and must not be papered over:

- **This service has no `/metrics` endpoint.** It answers only `/healthz`, `/readyz`, and `/internal/v1/alerts`, so the receiver side of the chain is invisible to collection: "is the receiver up?" has no series, and a delivery that fails *inside* this service (5xx, rejected signature, stale timestamp) is only observable through the sender's own counters or by grepping the rejected-message log line. The sender-side signals are `merchant_alert_delivery_attempts_total` / `merchant_alert_deliveries_total{result}` on the API's `GET /metrics`, so "no successful delivery in the last N minutes" (`MerchantAlertChannelNoSuccessfulDelivery`) *can* be evaluated there — provided a Prometheus exists and an Alertmanager routes it somewhere a human reads. Delivery evidence itself still lives in `workspace_operation_alert_notifications` (`delivery` / `attempts` / `reason`) and `alert_webhook_receipts`, i.e. it is only seen when someone actively looks.
- **It is not scraped and not reachable from a monitoring namespace.** `NetworkPolicy/merchant-alert-receiver-boundary` permits ingress from `ingress-nginx` only, and the sender side is disabled by default in the pilot Compose stack (`OPS_ALERT_NOTIFICATIONS_ENABLED: "false"`, `OPS_ALERT_WEBHOOK_URL: ""`), so even durable receipt is an opt-in profile (`profiles: ["alerts"]`).

Adding metrics here would be necessary but not sufficient: the scrape allowance, an Alertmanager, and a real paging channel are outside this repository. See `infra/observability/prometheus-alerts.example.yaml` (`MerchantAlertChannelNoSuccessfulDelivery`, `MerchantAlertPipelineWatchdog`) and `doc/todo/release/production-ops-runbook.md` section 3.4 for the full list of what is still missing.
