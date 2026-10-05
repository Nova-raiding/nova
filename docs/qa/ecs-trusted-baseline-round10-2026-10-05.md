# ECS trusted-baseline recheck — 2026-10-05 round 10

Read-only inspection of host `101` found that the deployed source archive
`merchant-demo-release-85575f9c.tar` has SHA-256
`sha256:c152329446f0aede4d464a1aa00cf202a9fcb039d7547caa1751bf5e06da2eff`,
matching the installed release identity's `source_sha256`.

This does not establish an approved semantic baseline for the candidate:

- the host identity is `release-85575f9c` / Git `85575f9c257c5186116e16fc0bde58d25c25f8ed`;
- the available candidate manifest is for `ecs-3dc76c93b536` / Git `3dc76c93b53652190f03454b305c86931e5f72ae`, not the host identity;
- no signed manifest and owner attestation binding the 23 protected-path decisions to the current candidate were found.

The source archive is useful for classification and remains read-only evidence. It cannot be promoted to an approved trusted baseline.
