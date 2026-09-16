# Release integration plan — 2026-09-16

## Integration boundary

- Base: `origin/main` at `365c5d8480675b7a9582b5d8c4ad765964c53af3`.
- Source tip: `codex/fix-relay-pending-state` at `46e3aba708b9df8d22f973bc1fe91cd2e8632bf3`.
- Common ancestor: `d5316a66497d86707692fa967fa56b9335eeaf9f`.
- Strategy: semantic integration onto current main. Preserve main behavior when implementations overlap; do not merge the source branch.
- Plugin canonical source: `apps/plugin`. Marketplace files are synchronized only after canonical integration and verification.

## Patch-equivalent commits skipped

`git cherry origin/main <source-tip>` marks these five commits as already represented on main:

| Source commit | Subject | Decision |
| --- | --- | --- |
| `2075e1bd` | align local API replica relay configuration | Skip (`git cherry -`) |
| `9060c21c` | clarify unavailable content generation gate | Skip (`git cherry -`) |
| `5fbcf1b7` | default text relay to low-cost flash model | Skip (`git cherry -`) |
| `bbfd6fc5` | prefer launchd relay credentials over placeholders | Skip (`git cherry -`) |
| `25469688` | exclude fixture stores from formal onboarding | Skip (`git cherry -`) |

## Migration mapping

Main owns migration numbers 212–214 and those files remain unchanged. Source migrations are moved forward as follows:

| Source | Integrated | Purpose |
| --- | --- | --- |
| `212_customer_delivery_account_binding.sql` | `215_customer_delivery_account_binding.sql` | delivery account binding |
| `213_workspace_content_setup.sql` | `216_workspace_content_setup.sql` | workspace content setup |
| `214_model_usage_embedding_modality.sql` | `217_model_usage_embedding_modality.sql` | embedding usage modality |

The registry must include main migration 214 before 215–217. Migration tests, PostgreSQL release tests, CI entries, rollback/chain assertions, and release metadata must end at 217.

## Commit-to-batch mapping

| Batch | Source commits | Integration method |
| --- | --- | --- |
| A — relay and delivery authorization | `fe5e658e`, `26ba8a7a`, `17892a04` | Apply in order; resolve against main delivery updates; renumber source migration 212 to 215 |
| B — first-use and plugin workflow | `000c710d` through `1e8b04c4` (excluding skipped commits) | Integrate canonical `apps/plugin`, API/contracts/application changes and tests; defer marketplace synchronization |
| C — release and knowledge hardening | `9233ac7d`, `a6ecba2d`, `4d1e6ef2` | Apply semantically; renumber source migrations 213/214 to 216/217; preserve main migrations 212–214 |
| D — source hygiene and current status | `dcb35b21`, `46e3aba7` | Apply redaction/hygiene; reconcile status documentation with integrated state |
| E — marketplace synchronization | no source commit replay | Copy/verify canonical plugin payload into marketplace layout after all canonical changes |

## Verification gates

1. Migration registry and focused 214–217 migration tests.
2. Plugin canonical/marketplace parity and plugin contract tests.
3. `npm run typecheck`.
4. `npm run test:release-gates`.
5. `git diff --check`, clean integration worktree, and final commit map.

No push or deployment is part of this integration.
