# Payment evidence reader: review-only bootstrap

`infra/protected/payment-evidence-reader-bootstrap.sql` creates the dedicated
`payment_evidence_reader` login and grants SELECT on only the ledger columns
used by the callback replay and refund snapshots. It changes role and ACL
metadata; it does not query or change payment rows, run a payment/refund, or
produce signed release evidence. Review and run it as the database owner only
after validating the exact production database and the two existing FORCE RLS
policies. It refuses an existing role rather than altering it silently.

The role is created with `PASSWORD NULL`. Provision its login through a
separate protected credential process. Do not place a password, DSN or service
file in Git, logs or chat. PostgreSQL grants `TEMPORARY` through `PUBLIC` by
default. A single role cannot revoke that inherited privilege. The bootstrap
therefore refuses while the current database has PUBLIC TEMP; the database
owner must assess the effect of any shared ACL change on every current client.
It also refuses PUBLIC relation/column access that would defeat isolation.

After a separately reviewed installation, configure a 0600 libpq service file
owned by the verifier UID, set `PGSERVICEFILE` and the simple service name in
`PAYMENT_EVIDENCE_PGSERVICE`, then run
`sh infra/scripts/verify-payment-evidence-reader.sh` as that UID. The verifier
authenticates as the dedicated role, starts a read-only transaction, checks
role membership/ownership, database/schema/table/column/sequence/function
privileges, both exact workspace RLS policies, and executes bounded SELECTs
under a synthetic workspace setting. It emits only a verdict, never ledger
rows. An `ok` verdict is a role/ACL check; the six-stage payment gate remains
NO-GO until independently sourced provider receipts, release provenance,
authorized payment/refund and final attestation are complete.

For a synthetic isolated PG17 check, run
`sh tests/run-payment-evidence-reader-container.sh`. It creates and removes
only its own temporary PostgreSQL container and confirms rejection of broad
table SELECT, an extra SELECT policy, and column UPDATE. No 101 database or
payment service is touched.
