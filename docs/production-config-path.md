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
