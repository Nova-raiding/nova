# Seven-attachment owner acceptance — 2026-09-15

Command: `OPS_E2E_DELIVERY_SCAN=true npx tsx scripts/verify-customer-delivery-owner.ts`

Final run exited **0**. Desktop browser: **1 passed**. Evidence run:
`artifacts/ops-jit-isolation/2026-09-15T04-27-11.288Z-70252c4c-800c-4e53-bc07-b61a5ae834fe/`.

Owner independently inspected `scan-result.json` and
`owner-revocation-result.json`, and viewed the shot-scraper training screenshot.

- Seven distinct attachments: contract, payment, system integration,
  functional acceptance, training, and two videos.
- All seven persisted registrations, audits, signed scan callbacks and stored
  object bytes/metadata verified; no creative points granted or consumed.
- Real payment-asset lock wait observed. Revocation committed without deadlock;
  the concurrent repository mutation was rejected with SQLSTATE `23514`.
- Completion became null, ordinary edits could not reactivate it, and exactly
  one evidence-invalidation audit was recorded.
- Source fingerprints stayed unchanged during the run. Isolated PostgreSQL,
  Redis and ClamAV stopped normally; shared containers were not touched.
- All 13 shared local services remained healthy after acceptance.

Capture files within that run:

- `delivery-1789446497718/training-confirmed-shot-scraper.png`
- `delivery-1789446497718/video-registration-shot-scraper.png`
- `delivery-1789446497718/training-inline.webm`

Two earlier runs correctly failed closed: the old collector checked only three
attachments; then the owner probe read an absent report field. The fixes collect
all seven current persisted bindings and derive the unique delivery ID from
verified attachment records. The seven-attachment gate was not weakened.

Verification also included 59 targeted regression tests and project typecheck.
This is isolated local runtime acceptance, not production payment or real
ChatGPT host evidence. New contract-URL import functionality and other shared
worktree changes are outside this acceptance claim. Real production config,
runtime credentials and signed release evidence remain required before launch.
