# Canonical safe-state reader bootstrap (review-only)

This bootstrap creates a narrowly scoped PostgreSQL login for a future live
canonical mode observer. It is a manual DBA operation, not a repository
migration or deploy hook. It does not collect canonical state, attest source
provenance, sign evidence, or open the full release gate.

## What it provisions

- `canonical_safe_state_reader` is a dedicated `LOGIN` role with `NOINHERIT`,
  no superuser/database/role/replication privileges, and `NOBYPASSRLS`.
- The role receives only effective `SELECT` on `workspaces`,
  `platform_feature_flags`, and `platform_feature_flag_targets`; the immutable
  feature flag event table is not exposed.
- The bootstrap grants `CONNECT` on the current database and `USAGE` on the
  `public` schema explicitly. It fails if the role already exists; an existing
  role must be audited and retired separately, not silently normalized.
- A `FOR SELECT` RLS policy permits this role to enumerate the workspace
  directory. Existing `ENABLE` and `FORCE ROW LEVEL SECURITY` on `workspaces`
  are required and are not silently changed by the bootstrap.
- The role has no database password. Provision an approved authentication
  method out of band, such as client certificates. Do not add it to any group
  role or grant it to another role.
- `default_transaction_read_only=on` is defense in depth. It is not a
  substitute for checking effective ACLs or starting an explicit read-only
  transaction.

## Manual bootstrap and validation

After reviewing the SQL, run it once as the database owner against the intended
database. It is transactional: a failed role or policy check rolls back the
whole bootstrap. If `canonical_safe_state_reader` or its policy already exists,
stop and investigate rather than deleting or reusing it. Provision a protected
libpq service file outside the checkout,
owned by the collector user with mode `0600`, using the dedicated reader login
and the approved TLS settings.
Then connect using the named service and run:

```sh
PGSERVICEFILE=/run/release-security/canonical-safe-state.pg_service \
CANONICAL_SAFE_STATE_PGSERVICE=production_reader \
  sh infra/scripts/verify-canonical-safe-state-reader.sh
```

The validator fails unless the connected and session roles are exactly
`canonical_safe_state_reader`, role memberships are absent, and the role owns
no database, schema, relation, function or type. It checks effective `CONNECT`
and `USAGE`, executes bounded reads against all three source tables, denies
effective table-level and column-level writes, database creation or temporary objects, access to other
non-system schemas/relations/sequences/databases, and executable non-trigger
`SECURITY DEFINER` functions. The workspace RLS policy must match the reviewed
contract without an applicable restrictive policy; the flag tables must not
have RLS that could silently hide rows. It wraps checks in a `REPEATABLE READ
READ ONLY` transaction and rolls it back. Existing `PUBLIC` grants may cause
this strict check to fail; a DBA must review those grants and their impact on
other users before changing them. Do not weaken the verifier to get a pass.

The disposable adversarial tests exercise source-column `UPDATE` and
unrelated-relation column `SELECT` grants against both PostgreSQL 16 and 17,
covering bootstrap refusal and the verifier and collector's effective-ACL
guards. Run them with `sh tests/canonical-safe-state-column-acl.postgres.sh`.

The bootstrap refuses to create the role when `PUBLIC` has the database
`TEMPORARY` privilege. PostgreSQL privileges inherited through `PUBLIC` cannot
be denied to this one role. Do not revoke that shared grant as part of this
runbook; the database owner must assess impacts on all application users and
make any shared ACL change separately. It also refuses when `PUBLIC` can
connect to another connectable database in the cluster, for the same reason.
Until the database owner resolves these shared ACLs, the exact SELECT-only
validator remains closed.

## Evidence boundary

Passing this validator proves only the database role and ACL/RLS contract at
the time of the check. It does not prove that a collector is installed from a
trusted digest, that the connection reaches the intended production cluster,
that every effective flag resolves to `legacy_shadow`, or that evidence is
bound to a release candidate. It does not sign release evidence. Those
independent provenance and candidate-binding steps remain required before this
role can support ordinary-release safe-state evidence. This role can only read
workspace and flag state; it does not prove two shadow cycles of canonical
product consistency. Those cycles require a separately scoped collector with
the complete data and independent source verification described in
`canonical-shadow-cycle-evidence-gap.md`.

## Ordinary release versus cutover

The canonical preflight accepts an ordinary-release assertion only when the
document is tagged `ordinary_release_safe_state` and passes the separate
Ed25519 attestation contract. It binds the same release ID, Git SHA, rendered
candidate manifest hash, release manifest hash, image-set digest and hashed
deployment nonce used by ECS preflight. It also compares the observed
PostgreSQL cluster system-identifier hash, database OID/name hash and approved
endpoint hash against a root-protected source policy, and pins the signing
collector digest. Every workspace must resolve to `legacy_shadow` in one
repeatable-read, read-only snapshot.

The verifier reads these fixed host trust files; missing or unsafe files are a
hard failure:

- `/run/release-security/evidence-trust/canonical-safe-state-source-policy.json`
- `/run/release-security/evidence-trust/canonical-safe-state-collector-sha256`
- `/run/release-security/evidence-trust/canonical-safe-state-public.pem`
- `/run/release-security/evidence-trust/canonical-safe-state-key-id`

The current snapshot script remains review-only and cannot produce that
signed proof. No source-signing key or reviewed cluster policy is provisioned
by this code. Until a protected producer independently verifies the selected
database against that policy and signs its own capture, ordinary full releases
remain blocked. A tagged ordinary proof cannot satisfy an actual cutover: the
existing cutover evidence path still requires two independently collected
shadow cycles and rollback evidence and retains its provenance blocker.
