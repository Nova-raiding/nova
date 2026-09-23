# API replica credential rotation prototype

`api-replica-credentials.mjs` is a local, non-mutating dry-run. It accepts a
0600 JSON array containing the two full `docker inspect` objects and a 0600
JSON object containing the current `API_AUTH_TOKENS` mapping:

```sh
node infra/scripts/rotation/api-replica-credentials.mjs --dry-run \
  --inspect-json /protected/api-inspects.json \
  --grants-file=/protected/api-auth-tokens.json
```

Only counts, immutable image IDs, network IDs, and config fingerprints appear
on stdout. Neither the old nor the generated keys appear. The Engine adapter
and `rotateReplicaPair` state machine are exercised by fake Engine tests.
The private 0600 writer, stopped clone preflight, Docker adapter, and
sequential recovery core are implemented and tested. `rotateWithGateway` is
an executable, dependency-injected state machine that creates two new,
unpublished green replicas with the rotated grants, waits for both health
checks, persists the new source mapping, changes the one public Nginx upstream,
verifies public auth, and only then stops old containers. The green replicas
get unique network aliases and no Compose ownership labels or published ports.
Writable shared mounts and replicas without health checks are rejected.

**The production `--execute` CLI remains disabled** with
`PUBLIC_UPSTREAM_HANDOFF_NOT_PROVEN` before any Engine call. The injected
`source.persist` must atomically update the protected Compose source *and all
dependent callers* without writing a partial old/new mapping. The injected
`gateway.install` must compare the exact source digest, atomically replace the
running config, run `nginx -t`, reload, and prove the new digest. The injected
`gateway.verify` must use the public TLS route to prove the rotated grant works
and every old grant fails. These production adapters and a matching runbook
have not been implemented or validated on host 101. A failed or ambiguous
gateway install keeps both green replicas alive and requires manual recovery;
it never auto-reverts to compromised grants.

An isolated local Docker clone and start/health round trip pass for a
two-network test container, including the unpublished green replicas.
Production-specific parity and the public gateway handoff remain unproven.
The dry-run also blocks an old token embedded in another environment variable.
