# ECS production runtime constraints — 2026-09-15

Owner-integrated, read-only probes used existing SSH alias `101` and the
project `/opt/merchant-deploy`. No credentials were printed or downloaded.

## Actual runtime, not approved targets

- PostgreSQL 16.15 has `archive_mode=off`, disabled archive command, zero
  archived WAL files and no successful archiving timestamp. PITR is not enabled.
- Database `max_connections=100`, below the gate's 300-backend contract.
- No pooler appeared in container, process or systemd listings or common host
  listen ports. Connection pooling cannot be declared enabled on this evidence.
- Scanner worker sets `CLAMAV_MAX_FILE_BYTES=104857600` (100MiB). The older
  server gate/checklist in this observation expected 52428800 (50MiB); the
  integrated candidate explicitly requires 104857600 for the delivery scanner.
  Product uploads remain limited to 50MiB. Preserve the actual recorded value;
  do not lower the scanner limit or restart services to match the older gate.
- API declares scanner mode `clamav_worker`, local scan fixture disabled,
  merchant bearer hostname `yxsona.com`, and policy `local-real-scan-v1`.
- ClamAV repository digest observed:
  `sha256:be3cb41d9833ce9ffb98f3d3e1483c35c0d87060c2bda3624d75fd28bbf0b3bd`.
- Auth/MCP/durable/OPS/platform flags and signature age were not explicit in
  the inspected container environments; their production declarations remain
  unresolved. All 17 observed running containers reported healthy.

## Safe changes made

These observed values were inserted into the existing blocked server config.
Its previous contents are recoverable from
`deploy/production-config/production.before-runtime-observations.yaml` (600).
The blocked marker was retained; no service environment or database was changed.

The old YAML validator was verified byte-identical to the reviewed source before
update and backed up as
`deploy/production-config/validate-production-config-yaml.before-null-guard.rb`.
It now rejects missing required values and non-string/empty/null secret refs.
Six previously accepted null/non-string reference forms reproduced a bypass;
the added rejection cases now pass. Related regression: 74 tests passed;
project typecheck passed.

The actual launch entrypoint in the pinned, network-disabled Ruby container
exited 1: `required production config value is missing: plugin_enabled`. This
is a blocked configuration check, not a successful release gate.

Further runtime changes require an approved backup destination/retention and
recovery plan, real pooler deployment, compatible connection budgets, and a
scanner identity/definitions/policy verification against the current candidate.
Do not enable PITR by declaration, fabricate refs,
raise database limits without capacity evidence, or silently restart services.
