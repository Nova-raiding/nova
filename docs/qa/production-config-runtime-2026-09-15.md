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

The initial process-variable audit did not discover the deployment target. A
subsequent project-script audit located the existing SSH alias `101` and project
directory `/opt/merchant-deploy`. A strict-host-key, batch-mode, read-only SSH
connection succeeded. Repository default domains alone remain insufficient
proof of endpoint readiness.

The server's actual configuration source is `/opt/merchant-deploy/.env` (mode
600), with relay, five-modality model selection, provider payment, signed
scanning and ECS RAM-role object storage configuration present. No credentials
were copied locally or included in audit output. All observed server containers
reported healthy. This is server configuration/health evidence, not proof of
successful production payment, model usage/cost or ChatGPT host canaries.

The remote project and release directories contained only example production
YAML, not a rendered production config. The remote environment has no
`PRODUCTION_CONFIG_PATH`, `SECRET_PROVIDER` or `RELEASE_ID`; the current pilot
Compose contract instead uses `PILOT_RELEASE_ID`. Neither the `.env` nor the
example YAML should be relabeled as validated production configuration.

The next configuration step can use the existing server-side source, without
asking for a server address again. Render a separate controlled production
configuration on that server, retaining unresolved secret-provider, independent
credential-reference, PITR/pooler and release-evidence requirements as blockers.
Do not paste credentials in chat or download the environment file. Values being
present in an environment file do not verify their availability or correctness.

Release additionally requires immutable images and signed, same-release runtime
evidence, including real ChatGPT host, payment, relay, restore and capacity
checks. A filled YAML file alone cannot satisfy these gates.

## Subsequent server-side configuration

The owner prepared a separate mode-600 YAML from the real server-side `.env`:
`/opt/merchant-deploy/deploy/production-config/production.yaml`. Raw credentials
were neither included in the generated YAML nor downloaded. Unavailable inputs
are null and an explicit `BLOCKED_UNTIL_REQUIRED_PRODUCTION_INPUTS` marker
ensures the production gate rejects the entire draft.

The root locator now links to the generated path record. Only its loading block
was inserted into the old server launch script; the previous entrypoint was
backed up in the mode-700 production-config directory. The runtime `.env`,
database and running service containers were unchanged.

The actual server launch entrypoint read this locator. On the host it exited
127 because Ruby is absent. Inside the pinned Ruby validation container, with
network disabled and the project mounted read-only, it exited 1 with
`production config contains unresolved placeholder or local-only value`.
Configuration preparation is complete; full production validation is not.
