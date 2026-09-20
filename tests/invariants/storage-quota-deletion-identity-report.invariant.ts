import type { InvariantFragment } from './registry.js'

/**
 * The refusal the reservation-key invariant added, and the reporter it was
 * missing.
 *
 * `assertDeletionIdentity` (packages/persistence/src/storage-quota-repository.ts)
 * refuses to repay a settled reservation when the delete receipt names a
 * different object than the reservation key: honouring the pair would credit
 * bytes whose object is still stored. That guard is right, and this row does not
 * touch it. What it pins is what happens to the refusal at its only production
 * caller (`releaseStorageQuotaAfterConfirmedDeletion`), which deletes the object
 * *first* and used to wrap the release in a bare `catch {}`.
 *
 * On the path that matters there is no earlier failure to preserve: the object
 * has already been deleted, so the settled row is the only record left of bytes
 * that are gone. Swallowing the refusal therefore leaves `used_bytes` inflated
 * permanently, with no alert and no log - reconciliation is a read-only
 * snapshot (see migration 231's header), so nothing repairs it either. The
 * branch traded "credits a live object" for "silently never credits" without
 * adding a single signal.
 *
 * The evidence is
 * `apps/api/src/storage-quota-deletion-identity-report.test.ts`: it drives a real
 * mismatch through the real `assertDeletionIdentity` (the memory ledger the API
 * ships, which calls the same exported guard as the Postgres one) and asserts
 * both that the row stays charged and that an operational alert names it. The
 * `overRejection` mutation is the mirror defect - reporting every release,
 * including the one that was legitimately repaid, which is an alert nobody can
 * act on - and the second case in that file is what catches it.
 */
const RULE_DECLARATION_SITE = 'tests/invariants/storage-quota-deletion-identity-report.invariant.ts'
const EVIDENCE = 'apps/api/src/storage-quota-deletion-identity-report.test.ts'

/**
 * The assertion message the row registers as `evidenceFailsWith`, carried by the
 * alert assertion in both evidence cases: the mutation that removes the report
 * fails the refusal case, the mutation that makes it unconditional fails the
 * repaid case, and both print this sentence.
 */
const SILENT_REFUSAL = 'a refused release must be recorded as an operational alert, not swallowed'

export const mutations: InvariantFragment['mutations'] = [
  {
    id: 'storage-quota-deletion-identity-mismatch-is-reported',
    invariant: 'A storage-quota release the ledger refuses because the delete receipt names a different object than the reservation key is recorded as an operational alert, so the bytes it leaves charged are visible to an operator.',
    chokepoint: 'apps/api/src/server.ts',
    chokepointSymbol: 'releaseStorageQuotaAfterConfirmedDeletion',
    file: 'apps/api/src/server.ts',
    // The shipped line, verbatim: every failure on this path, the identity
    // refusal included, swallowed by one empty catch.
    find: `  } catch (error) {
    // The original failure is preserved for the caller and for reconciliation;
    // the identity refusal is the one that has no other reporter (see the
    // function above), so it is recorded instead of being swallowed with it.
    if (isDeletionIdentityMismatch(error)) await reportStorageQuotaDeletionIdentityMismatch(input)
  }`,
    replace: `  } catch { /* preserve the original failure; reconciliation will surface the reservation */ }`,
    evidence: EVIDENCE,
    overRejection: {
      find: `    if (isDeletionIdentityMismatch(error)) await reportStorageQuotaDeletionIdentityMismatch(input)
  }`,
      replace: `    void error
  }
  await reportStorageQuotaDeletionIdentityMismatch(input)`,
      why: 'Reporting every release - the legitimately repaid one included - is the mirror of reporting none: an alert fires for a row whose bytes are already back, `nextAction` sends an operator to reconcile a correct ledger, and the same alert key then covers the real refusal. The evidence case that releases a matching receipt and requires the alert list to stay empty is what catches it.',
    },
    evidenceFailsWith: SILENT_REFUSAL,
    uniqueness: {
      // The only production caller is the compensation path in this file; the
      // evidence and `server.test.ts` drive it directly.
      callers: ['apps/api/src/server.ts'],
      noSecondImplementation: [
        {
          pattern: 'STORAGE_QUOTA_DELETION_IDENTITY_MISMATCH',
          sample: "throw new Error('STORAGE_QUOTA_DELETION_IDENTITY_MISMATCH')",
          // The refusal itself (the ledger guard) and this reporter are the two
          // production sites; the sample is the declaration of the rule.
          allow: [
            'packages/persistence/src/storage-quota-repository.ts',
            'apps/api/src/server.ts',
            RULE_DECLARATION_SITE,
            EVIDENCE,
          ],
          why: 'the code is refused in exactly one place and reported in exactly one place. A third production file naming it is a second handler for the same refusal, which is how the API and the worker drifted apart on the previous round of this branch.',
        },
      ],
    },
    rationale: 'The mutation is the branch\'s own code, restored: `catch { /* preserve the original failure */ }` around a release whose object has already been deleted. The refusal then charges the workspace forever with no record - a permanent over-count, which is the failure the alert exists to make impossible. The evidence asserts the row really is still charged under the mutation, so the alert cannot be dismissed as noise about a release that happened after all.',
  },
]
