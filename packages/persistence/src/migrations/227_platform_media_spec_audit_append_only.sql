-- 227_platform_media_spec_audit_append_only: close the row-level mutation path
-- left open on the platform media specification approval audit chain.
--
-- 226 installed a statement-level `BEFORE TRUNCATE` guard on this table but
-- deliberately stopped there: it was written for six tables whose only shared
-- defect was the TRUNCATE path, and only two of the six had a legitimate
-- UPDATE flow that a row-level guard would have frozen. This table was not one
-- of them, so the guard was left strictly narrower than the ledger contract it
-- claims to enforce.
--
-- The result is that `platform_media_spec_audit` is the only table in the
-- evidence family that still accepts row-level mutation. The table owner can
-- rewrite a recorded approval (`UPDATE ... SET after_json=..., reason=...`) or
-- erase it (`DELETE`), and `merchant_ops` — the role that writes the chain —
-- holds INSERT and SELECT only, so it cannot repair the tampering afterwards.
-- An approval audit chain that the owner can edit line by line is not an audit
-- chain; the whole point of the `idempotency_key` + `before_json`/`after_json`
-- rows is that a past decision is a fact, and a fact is not editable.
--
-- Verified before writing this: the application only ever INSERTs into this
-- table. The single writer is `PostgresPlatformMediaSpecRepository.audit`, an
-- unconditional `INSERT INTO platform_media_spec_audit (...) VALUES (...)`;
-- `replay` and `listAudit` are `SELECT`s. No UPDATE, DELETE, UPSERT
-- (`ON CONFLICT`) or MERGE against it exists anywhere in the repository, in
-- `apps/worker`, or in the ops surface. The foreign key on `spec_id` is
-- `ON DELETE RESTRICT`, not `CASCADE`, and no table references this one at all,
-- so no parent-row delete can cascade into it. No retention, cleanup or
-- maintenance path targets it. Freezing UPDATE and DELETE therefore cannot
-- obstruct a single legitimate write.
--
-- Scope note: this migration adds ONLY the row-level trigger. The
-- statement-level `BEFORE TRUNCATE` guard that normally accompanies it in this
-- family (132/134/136/224/225) already exists on this table — 226 created
-- `platform_media_spec_audit_no_truncate` — so re-declaring it here would be a
-- second source of truth for a contract that is already enforced. 226 is
-- guaranteed to run first because the runner applies versions in ascending
-- order. The `REVOKE UPDATE, DELETE, TRUNCATE` below is the belt-and-braces
-- half of the 132 pattern: `merchant_ops` today holds neither UPDATE nor
-- DELETE, so it is a no-op that only stops a later grant from reopening the
-- path this trigger closes. It never grants anything back.
--
-- The rejecting function is per-table rather than shared, matching 132
-- (`reject_rule_audit_mutation`), 136 and 219
-- (`reject_public_platform_rule_audit_mutation`): its 55000 message names the
-- audit chain that refused the write, which is the diagnostic an operator
-- needs. `reject_append_only_ledger_truncate` from 225 is not reused because
-- its message says "rejects TRUNCATE" and would misreport a row mutation.

CREATE OR REPLACE FUNCTION reject_platform_media_spec_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform media specification audit is append-only'
    USING ERRCODE = '55000',
          HINT = 'Corrections are new rows; recorded approval evidence is never rewritten or deleted.';
END;
$$;

DROP TRIGGER IF EXISTS platform_media_spec_audit_append_only ON platform_media_spec_audit;
CREATE TRIGGER platform_media_spec_audit_append_only
BEFORE UPDATE OR DELETE ON platform_media_spec_audit
FOR EACH ROW EXECUTE FUNCTION reject_platform_media_spec_audit_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON platform_media_spec_audit FROM PUBLIC;
DO $platform_media_spec_audit_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON platform_media_spec_audit FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    -- INSERT and SELECT are untouched: merchant_ops is the legitimate writer
    -- and reader of this chain.
    REVOKE UPDATE, DELETE, TRUNCATE ON platform_media_spec_audit FROM merchant_ops;
  END IF;
END
$platform_media_spec_audit_acl$;
