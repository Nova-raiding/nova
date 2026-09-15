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
