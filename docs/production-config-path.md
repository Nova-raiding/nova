# Production configuration locator

`infra:launch-preflight` and `dev:doctor:production` read the ignored root file
`.env.production-config-path` when `PRODUCTION_CONFIG_PATH` is not explicitly
set. It contains one path, not shell commands or dotenv assignments. The launch
command's explicit path argument takes precedence over both.

The configured workstation target is `.env.production.yaml`. It is an ignored,
blocked draft, not real production configuration. Replace it with the real
rendered configuration following `doc/todo/infra/production-config.example.yaml`.
Never commit credentials. Production checks do not load the developer `.env`.

A configured locator does not establish production readiness. Configuration
validation, release evidence, runtime checks and launch preflight must all pass.

## Server-side preparation

`infra/scripts/render-production-config-from-env.mjs ENV OUTPUT GATE [LOCATOR]`
prepares a new, mode-600 YAML file from explicit deployment environment values.
It reads the required-key contract from `validate-production-config.sh`, never
exports raw credentials or invents secret-store references, and exits 2 when
inputs remain missing or unresolved. Existing output files are not overwritten.
Its successful preparation exit code does not indicate release readiness.

`infra/scripts/install-production-config-locator.mjs ROOT` updates only the
locator-loading block in an older launch entrypoint, preserving unrelated code
and its mode. The previous script is backed up in
`deploy/production-config/launch-preflight.before-locator.sh`. It does not deploy,
restart services or modify the runtime environment file.

On SSH alias `101`, the configured target is now
`/opt/merchant-deploy/deploy/production-config/production.yaml`, reached through
`/opt/merchant-deploy/.env.production-config-path`. Both generated files are
mode 600 and the containing directory is mode 700. The configuration remains
blocked until real secret references, auth/platform declarations, PITR/pooler,
approved limits and release inputs are supplied.

The server host currently lacks Ruby. The actual launch entrypoint was also
executed inside the pinned Ruby validation container
`ruby@sha256:2f763b37070564bb00b736f1d4dba6e8f8d203b5f93b94463879fd8d79966f28`
with network disabled and the project mounted read-only. It read the persisted
locator and exited 1 on the unresolved configuration marker, before any
operations/deployment action. The host entrypoint exits 127 for missing Ruby;
a supported full preflight runtime is still required before launch.
