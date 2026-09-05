# Open-work inventory and release disposition (2026-09-02)

## Scope

This inventory covers all 93 files under `doc/todo`. The repository currently has 76 Markdown files and 17 non-Markdown files. The 41 Markdown files containing open-status markers are not 41 equivalent code defects: several are historical audit documents whose evidence must remain immutable.

## Current disposition

| Disposition | Count | Meaning |
| --- | ---: | --- |
| No open marker | 35 Markdown files | No open-status marker remains in the document. This is documentation-clean, not proof of production readiness. |
| Open marker | 41 Markdown files | Requires either evidence refresh, implementation, or an external release prerequisite. |
| Non-Markdown | 17 files | Must be reviewed by the owning implementation or release check; marker counts above intentionally exclude them. |

## Implementation disposition

### Completed in the repository and locally verified

- Workspace and role-scoped authorization, including persistent member/RLS transaction paths.
- Commercial access fail-closed contracts, worker re-checks, reservation and settlement evidence handling.
- Publish, generation, campaign and asset operations reject missing or stale scope/evidence instead of performing external writes.
- OAuth callback workspace binding and OpenAPI/MCP contract parity.
- Object key validation, orphan queue safety, image-generation callback/reconciliation guards.
- Ops console and Merchant Studio desktop flows, including explicit empty, blocked, simulated and external-pending states.
- Release/runtime/fault gates and targeted persistence/commercial zero-side-effect checks passed in the available local environment.

### Still incomplete or externally blocked

- Six platform production OAuth, read, write, media-upload, read-back and canary evidence.
- Real payment provider order, callback, refund and reconciliation evidence.
- Production model relay/provider evidence for all five modalities, including usage and cost records.
- Cloud object storage, KMS, PITR/recovery and production scanner evidence.
- Production PostgreSQL/RLS attack matrix across replicas and production capacity/long-run evidence.
- Formal ChatGPT host/OIDC installation flow evidence.
- Signed production artifact, trust/attestation, alerting, rollback and release binding evidence.
- Existing scanner dead-letter remediation and fresh ClamAV definitions; these must not be hidden by deleting data or weakening health checks.
- Business approval-dependent entitlement, eligibility, credit and custom-order rules.

### Local scanner recovery evidence

- 2026-09-02: `freshclam` downloaded daily database `28111`.
- 2026-09-02: restarted local ClamAV so `clamd` reloaded the database; `clamdscan --ping` returned `PONG`.
- 2026-09-02: local `clamav` and `worker-scan` both became healthy.
- Six historical dead-letter events still require an authorized commercial-access snapshot before redrive; no data was deleted and no readiness check was weakened.

## CodeGraph evidence

CodeGraph was synchronized on 2026-09-02. The relevant dependency path is:

`commercial access snapshot -> WorkerCommercialAccessGuard -> authoritative recheck -> provider I/O -> durable outcome/reconciliation`

Any release item claiming these capabilities complete must provide runtime evidence at the real ChatGPT plugin/API/MCP and desktop operations surfaces. Fixture, local storage, simulated provider responses, or static source presence do not close a production gate.

## Release decision

The repository is not launch-ready while the externally blocked items above remain unresolved. The correct next work is to obtain the missing authorized environments and evidence, then update the owning audit rows; mass replacement of historical status text would corrupt the release record.
