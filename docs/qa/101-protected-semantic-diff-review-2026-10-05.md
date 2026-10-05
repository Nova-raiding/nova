# 101 protected semantic diff review (2026-10-05)

This is a read-only candidate-bound comparison. It does not approve overwriting the host or deployment.

- Candidate Git SHA: `59eb1e8db78005a2f9be1b8a808507422ffc82b8`
- Candidate archive: `sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1`
- Candidate sync plan: `sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6`
- Remote: `101:/opt/merchant-deploy` (no `.git` checkout)
- Scope: 23 protected paths, fetched read-only; raw remote bytes were used only in a temporary directory and are not persisted as candidate artifacts.

All 23 protected paths differ byte-for-byte from the candidate archive. The differences include credential-source wiring, OAuth/local-stdio mode, compose image and migration identity, worker credentials, deployment preflight, database-role checks, payment rotation, and release metadata. Because no trusted remote commit/parent or merge base exists, and no owner-approved per-file preservation decision is recorded, every file remains `REVIEW_REQUIRED`; aggregate approval is `false`.

| Path | Remote bytes | Candidate bytes | Removed | Added | Decision |
|---|---:|---:|---:|---:|---|
| `.env.example` | 11699 | 22742 | 29 | 233 | `REVIEW_REQUIRED` |
| `apps/api/src/aliyun-ecs-role-credentials.ts` | 2606 | 1220 | 52 | 26 | `REVIEW_REQUIRED` |
| `apps/ops-console/.env.example` | 825 | 479 | 8 | 2 | `REVIEW_REQUIRED` |
| `infra/local/docker-compose.ecs-pilot-release.yml` | 2290 | 4483 | 1 | 43 | `REVIEW_REQUIRED` |
| `infra/local/docker-compose.ecs-pilot.yml` | 15730 | 37321 | 25 | 453 | `REVIEW_REQUIRED` |
| `infra/local/docker-compose.ecs-production-migration.yml` | 2535 | 2574 | 0 | 1 | `REVIEW_REQUIRED` |
| `infra/local/docker-compose.yml` | 29532 | 33321 | 13 | 72 | `REVIEW_REQUIRED` |
| `infra/local/ecs-production-compose.layers` | 224 | 329 | 0 | 2 | `REVIEW_REQUIRED` |
| `infra/local/ensure-app-role.sql` | 12756 | 30248 | 4 | 297 | `REVIEW_REQUIRED` |
| `infra/scripts/apply-migrations.sh` | 7387 | 11356 | 8 | 95 | `REVIEW_REQUIRED` |
| `infra/scripts/deploy-preflight-ecs.sh` | 20137 | 31161 | 45 | 180 | `REVIEW_REQUIRED` |
| `infra/scripts/deploy-preflight.sh` | 13776 | 20159 | 14 | 76 | `REVIEW_REQUIRED` |
| `infra/scripts/deploy-verified-ecs-compose.sh` | 26739 | 46477 | 48 | 293 | `REVIEW_REQUIRED` |
| `infra/scripts/generate-container-source-manifest.mjs` | 10157 | 10323 | 6 | 8 | `REVIEW_REQUIRED` |
| `infra/scripts/pilot-compose-preflight.sh` | 1305 | 5290 | 7 | 73 | `REVIEW_REQUIRED` |
| `infra/scripts/render-ecs-production-compose.sh` | 1880 | 5954 | 1 | 91 | `REVIEW_REQUIRED` |
| `infra/scripts/rotate-alipay-secrets.sh` | 5790 | 581 | 111 | 6 | `REVIEW_REQUIRED` |
| `infra/scripts/stage-verified-ecs-release.sh` | 7232 | 16203 | 4 | 142 | `REVIEW_REQUIRED` |
| `infra/scripts/validate-ecs-production-compose.mjs` | 9048 | 13453 | 7 | 63 | `REVIEW_REQUIRED` |
| `infra/scripts/validate-production-config-yaml.rb` | 4663 | 7589 | 7 | 70 | `REVIEW_REQUIRED` |
| `infra/scripts/validate-production-config.sh` | 26915 | 29464 | 8 | 34 | `REVIEW_REQUIRED` |
| `infra/scripts/verify-runtime-db-role.sh` | 21925 | 36681 | 2 | 199 | `REVIEW_REQUIRED` |
| `release-metadata.json` | 224 | 257 | 5 | 6 | `REVIEW_REQUIRED` |

The candidate-bound triage copy is
`artifacts/deployment-candidates/ecs-20261004T214923Z/protected-onsite-semantic-diff.json`.
It records the absent/unverified trusted baseline explicitly and is consumed as
`protected_onsite.semantic_diff.status=not_run`; it cannot approve the 23 paths.
