# ECS runtime evidence handoff

The production evidence producers deliberately write immutable host artifacts as
`root:root 0600`. The API and API replica run as UID/GID `10001:10001`, so the
immutable artifact must be handed off to a separate read-only runtime path
before the ECS preflight. Do not change the signer output to group-readable and
do not make either artifact world-readable.

Run the handoff on host `101` as root after the capability/manual attester and
the no-load capacity declaration have been independently validated. Use a
release-scoped directory below the persistent host root. The source files
remain in the protected release artifact directory; the helper creates a new
byte-for-byte file and refuses to replace an existing runtime file. The
directory is created as `root:root 0700` when absent and is never replaced:

```sh
node infra/protected/install-ecs-runtime-evidence.mjs install \
  --kind capability \
  --source /var/lib/merchant-release-security/evidence/<release>/capability.signed.json \
  --target /var/lib/merchant-release-security/runtime-evidence/<release>/platform-capability.json

node infra/protected/install-ecs-runtime-evidence.mjs install \
  --kind capacity \
  --source /var/lib/merchant-release-security/evidence/<release>/capacity.no-load.json \
  --target /var/lib/merchant-release-security/runtime-evidence/<release>/capacity-report.json
```

The helper accepts only canonical regular source files owned by root with mode
`0600`, and only a target of the form
`/var/lib/merchant-release-security/runtime-evidence/release-<id>/<kind-file>`.
It copies with exclusive creation, verifies the SHA-256, and installs the
target as `root:10001` mode `0440`. A failed or mismatched handoff stops the
release; never remove an existing runtime file or the stale
`/run/release-evidence/platform-capability.json` directory to make a retry
pass. Use a new release attempt and preserve the failed artifact for review.

Set `CAPABILITY_EVIDENCE_PATH` and `CAPACITY_REPORT_PATH` in the protected ECS
environment to the two release-scoped host paths above. Compose still mounts
them read-only into the fixed container paths
`/run/release-evidence/platform-capability.json` and
`/run/release-evidence/capacity-report.json`. The preflight then checks the
host runtime metadata before it verifies the signed evidence and the release
bundle. The handoff does not sign, approve, or replace evidence; all release
identity, signature, expiry, and bundle checks remain mandatory.
