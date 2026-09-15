# Production configuration runtime check — 2026-09-15

## Observed runtime

- The workstation locator `.env.production-config-path` points to ignored
  `.env.production.yaml`. The target is an explicitly blocked draft, not a
  rendered production configuration.
- Executing `sh infra/scripts/launch-preflight.sh` without an environment
  override reads the persisted locator and exits **1**:
  `required production config key is missing: plugin_enabled`.
- The same entrypoint with `PRODUCTION_CONFIG_PATH=/nonexistent/production.yaml`
  exits **2** before deployment. An explicit environment path takes precedence
  over the workstation locator.
- Local Compose reported all 13 services running and healthy after rebuilding
  the shared worker image for migration 211. No database rollback, migration
  rerun, readiness-file fabrication or volume deletion was performed.
- The running local API returned HTTP 200 from `/readyz`, with
  `data.status=ok` and `data.writesEnabled=false`. Healthy infrastructure does
  not establish production readiness or authorize production writes.

These are local runtime observations, not production canary evidence. The
seven-file delivery browser acceptance is a separate run and its result is not
claimed here. The shared worktree also contains other uncommitted delivery and
plugin changes; they are not covered by this configuration check.

## Missing external input

No production deployment target or accessible Secret Manager binding was found
in the inspected project/process configuration. Repository default domains are
not proof that those endpoints are deployed or authorized.

To render the real configuration, provide the production server/cluster target
and the controlled configuration-file location or Secret Manager access
location. Do not paste credentials in chat. The authorized deployment environment
must supply the actual database, Redis, object storage, OIDC/MCP, payment and
five-modality relay configuration and approved limits.

Release additionally requires immutable images and signed, same-release runtime
evidence, including real ChatGPT host, payment, relay, restore and capacity
checks. A filled YAML file alone cannot satisfy these gates.
