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
The workstation launch command (`npm run infra:launch-preflight`) now enters the
ECS Compose preflight in `infra/scripts/deploy-preflight-ecs.sh`. It requires the
rendered Compose release, exact image digests, a clean Git worktree, current
migration version, protected evidence trust anchor and release-bound production
evidence. The separate Kubernetes manifest preflight remains for legacy
Kubernetes deployment scripts and is not the ECS launch gate.

## Server-side preparation

`infra/scripts/render-production-config-from-env.mjs ENV OUTPUT GATE [LOCATOR]`
prepares a new, mode-600 YAML file from explicit deployment environment values.
It reads the required-key contract from `validate-production-config.sh`, never
exports raw credentials or invents secret-store references, and exits 2 when
inputs remain missing or unresolved. Existing output files are not overwritten.
Its successful preparation exit code does not indicate release readiness.

Known deployment aliases `MCP_AUTHZ_MODE`,
`AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED` and `PUBLIC_APP_BASE_URL` are accepted;
conflicting explicit/alias values are rejected without printing them. Enabled
alerts, KMS encryption and social-platform opt-ins retain their conditional
fields. No missing secret references or authorization flags are invented.

Use the optional `LOCATOR` argument only for a new path record. If it already
exists, it is preserved and the command fails; the separately created YAML
may remain for private review. Do not delete the existing configuration or
environment file to retry. Prepare a new YAML without `LOCATOR`, then review
it and supply its explicit path to preflight.

`infra/scripts/install-production-config-locator.mjs ROOT` updates only the
locator-loading block in an older launch entrypoint, preserving unrelated code
and its mode. The previous script is backed up in
`deploy/production-config/launch-preflight.before-locator.sh`. It does not deploy,
restart services or modify the runtime environment file.
The locator must be one path line, either a regular file or a controlled link
to a regular file inside `ROOT`; its link, content and permissions are not
modified. Escaping/dangling links, directories, symlink launchers and partial
or duplicate patches are rejected before installation writes.

On SSH alias `101`, the configured target is now
`/opt/merchant-deploy/deploy/production-config/production.yaml`, reached through
`/opt/merchant-deploy/.env.production-config-path`. A subsequent owner read-only
check confirmed this locator is a controlled root-local symlink; its content
target and the YAML are mode 600, and the configuration directory is mode 700.
The configuration remains
blocked until real secret references, auth/platform declarations, PITR/pooler,
approved limits and release inputs are supplied.

The server host currently lacks Node.js/npm/npx, Ruby, Git, psql and shasum;
only the Docker CLI was found in the release tool inventory. A real ECS launch
must run from a reviewed checkout with the required host toolchain and
`npm ci`-installed local `tsx`. The preflight checks these commands explicitly
and never lets `npx` download a replacement dependency. Until the toolchain is
provisioned, the launch remains blocked; container health does not satisfy this
release-host requirement. The actual launch entrypoint was also
executed inside the pinned Ruby validation container
`ruby@sha256:2f763b37070564bb00b736f1d4dba6e8f8d203b5f93b94463879fd8d79966f28`
with network disabled and the project mounted read-only. It read the persisted
locator and exited 1 on the unresolved configuration marker, before any
operations/deployment action. The host entrypoint may still stop during the
configuration validator while Ruby is absent; the release toolchain check is
reached after configuration validation and before any operations action.
