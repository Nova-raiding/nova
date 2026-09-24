# Read-only ECS source review acquisition

`infra/scripts/acquire-ecs-review-source.mjs` obtains review evidence for
candidate `review_required` files that are application/library source. It does
not write to the ECS host and it does not perform a merge. It is deliberately
not a general remote copy command.

Run it against an already generated candidate bundle:

```sh
node infra/scripts/acquire-ecs-review-source.mjs \
  artifacts/deployment-candidates/ecs-<candidate-sha>
```

The helper verifies the candidate identity bindings for `files.txt` and
`sync-plan.tsv`. It only selects `review_required` entries under the source
directories named in `ecs-review-source-policy.mjs` with source-code
extensions. Infrastructure, all Compose files, `.env` files, production
configuration, secrets, credentials, tokens, private keys, and evidence are
excluded. The remote reader opens every path component without following
symlinks and rejects anything that is not a regular file. Each transferred
record's SHA-256 must match both the bytes and the exact `remote_sha256` bound
in that path's candidate sync-plan row; duplicate/malformed rows fail closed.
The complete transfer is verified before files are written, then the output
directory is atomically published inside the candidate bundle with mode 0700;
source files are written mode 0600. A failed or drifted transfer leaves no
partial output directory.
If a path is refused, the report lists its path without reading its contents.

The remote command is a fixed Python read-only reader, invoked over SSH in
BatchMode. Candidate paths are passed on stdin, never interpolated into remote
shell source. SSH errors are not echoed because remote stderr could contain
host-specific output. Any remote refusal or protocol mismatch aborts the
acquisition.

Unpack the already digest-bound candidate archive into a new local review
directory (never onto the ECS checkout), then compare:

```sh
mkdir -m 700 artifacts/deployment-candidates/ecs-<candidate-sha>/candidate-review-tree
tar -xf artifacts/deployment-candidates/ecs-<candidate-sha>/candidate-source.tar \
  -C artifacts/deployment-candidates/ecs-<candidate-sha>/candidate-review-tree
diff -ru \
  artifacts/deployment-candidates/ecs-<candidate-sha>/candidate-review-tree \
  artifacts/deployment-candidates/ecs-<candidate-sha>/remote-review-source
```

The helper does not unpack the candidate archive automatically. Manually review
each diff and merge chosen changes into a separate review
checkout. This evidence is not an approved merge and does not authorize
staging or deployment.

The helper refuses server-only Compose and configuration files rather than
redacting them client-side. For those, the authorized host operator must
produce a sanitized structural diff that preserves local-only wiring without
revealing values. No such diff should include secret values, credentials,
private keys, or rendered production configuration. The existing safe-sync
runbook remains authoritative for manual three-way merge and all release
gates.
