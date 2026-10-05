# Candidate owner-attestation template

This template is intentionally unresolved. Do not place it in the candidate
bundle or mark it approved until an authenticated owner has reviewed each row.

The attestation must bind all of the following exact identities:

```json
{
  "candidate_git_sha": "59eb1e8db78005a2f9be1b8a808507422ffc82b8",
  "candidate_source_sha256": "sha256:88b5c0c69629678e1364b2fe7e13fd9e144d5eebfe48b9ec0083ff233fa26fd1",
  "candidate_sync_plan_sha256": "sha256:5998d907f0f75ab4e20b8305e8dfa8d090c8097317d915bb36bf66053b3d96d6",
  "trusted_remote_revision": "<verified 101 revision>",
  "trusted_remote_manifest_sha256": "<verified manifest sha256>",
  "owner_identity": "<authenticated owner identity>",
  "owner_attestation": "<signature or authenticated attestation reference>",
  "attested_at": "<RFC3339 timestamp>",
  "files": [
    {
      "path": "<one of the 240 review_required paths>",
      "decision": "PRESERVE_REMOTE",
      "rationale": "<why this semantic choice is safe>",
      "checks": ["<tests or review checks run>"]
    }
  ]
}
```

Allowed decisions are `PRESERVE_REMOTE`, `TAKE_CANDIDATE`, and
`MANUAL_MERGE`. Every review-required path and all 23 protected paths need a
decision bound to the exact candidate and trusted baseline. A template or
unsigned local note cannot satisfy the release gate.
