/**
 * Invariant: a settled storage-quota reservation row can only be released by
 * the deletion of the physical object it describes, for the bytes that object
 * really occupies - and a row that cannot name its object is repaired, never
 * guessed at.
 *
 * This is the invariant the branch failed four times: the write side derived the
 * ledger key from the upload request, the delete side derived it back out of the
 * stored object key, and migration 231 derived it a third time in SQL. Whenever
 * the three disagreed - a body named `*.merchant-meta.json`, a file name that
 * still needed canonicalizing, a legacy row neither side could name - the
 * reservation detached from its object: `used_bytes` fell for an object that was
 * still stored (a sibling's row released through a `LIKE 'asset:<id>/%'` prefix
 * scan), or it never fell for an object that was deleted, and the workspace was
 * left reporting STORAGE_QUOTA_EXCEEDED while holding nothing.
 *
 * The chokepoint is `reservationKeyFor`/`parseReservationKey`/`objectKeyIdentity`
 * in packages/storage/src/reservation-key.ts: one forward derivation, one
 * reverse derivation, and `safeFileName` in packages/storage/src/object-storage.ts
 * as the only file-name normalizer. The release path in
 * storage-quota-repository.ts keeps an exact fallback for the bare legacy key
 * only, and it verifies the row's asset id.
 *
 * The evidence is the real PostgreSQL suite the repository ships with
 * (packages/persistence/src/migration-232-release.postgres.test.ts): it drives
 * `PostgresStorageQuotaRepository` as the tenant role against a scratch database
 * built from the real migration chain, so each mutation below has to be caught
 * by the SQL and the key derivation that ship, not by a stand-in.
 */
import type { InvariantMutation } from './registry.js'

const EVIDENCE = 'packages/persistence/src/migration-232-release.postgres.test.ts'
const DATABASE_REQUIREMENT = 'PERSISTENCE_RELEASE_DATABASE_URL'
const CHOKEPOINT = 'packages/storage/src/reservation-key.ts'

export const mutations: readonly InvariantMutation[] = [
  {
    id: 'storage-quota-no-unauthenticated-prefix-release',
    chokepointSymbol: 'releaseAfterPhysicalDeletion',
    invariant: 'A release that misses the exact per-object key may only fall back to the asset-scoped legacy key, and only when the matched row carries the asset id of the object that was deleted.',
    chokepoint: 'packages/persistence/src/storage-quota-repository.ts',
    file: 'packages/persistence/src/storage-quota-repository.ts',
    find: 'AND reservation_key=$2 AND asset_id=$3',
    replace: "AND (reservation_key=$2 OR reservation_key LIKE $2 || '/%')",
    evidence: EVIDENCE,
    overRejection: {
      find: 'AND reservation_key=$2 AND asset_id=$3',
      replace: 'AND reservation_key=$2 AND asset_id=$3 AND false',
      why: 'a release that never matches is the mirror of one that matches a sibling: the ledger keeps charging for an object that is gone, and the deletion evidence has to fail here as well',
    },
    evidenceFailsWith: 'does not release a sibling object reservation for an object it does not describe',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: "'asset:'\\s*\\|\\|",
          sample: "target_key := 'asset:' || legacy.asset_id || '/' || file_name",
          allow: [
            'packages/storage/src/reservation-key.ts',
            'packages/persistence/src/storage-quota-repository.ts',
            'packages/persistence/src/migrations/231_storage_quota_per_object_reservation_keys.sql',
            'packages/persistence/src/migrations/232_storage_quota_unnameable_reservation_keys.sql',
          ],
          why: 'the key is derived in one place; a hand-built `asset:<id>/<name>` anywhere else is the second derivation that detached reservations from their objects',
        },
      ],
    },
    requires: DATABASE_REQUIREMENT,
    rationale: 'The exact-match-plus-ownership condition is the whole guard. Replacing it with the prefix scan reinstates the defect the audit reproduced: deleting asset_Z/ghost.txt, which has no row of its own, released the settled sibling row asset_Z/keep.txt (used_bytes 100 -> 0) while keep.txt was still stored, so the workspace could store past its limit and the live object lost its ledger row for good.',
  },
  {
    id: 'storage-quota-single-reservation-key-derivation',
    chokepointSymbol: 'reservationKeyFor',
    invariant: 'The ledger key written for an object and the ledger key derived from that object\'s stored key are produced by one implementation over one file-name normalizer, so they cannot disagree.',
    chokepoint: CHOKEPOINT,
    file: CHOKEPOINT,
    find: 'safeFileName(input.fileName)',
    replace: "input.fileName.trim().normalize('NFKC').replace(/[^\\p{L}\\p{N}._-]/gu, '_').replace(/^\\.+/u, '_').slice(0, 160)",
    evidence: EVIDENCE,
    overRejection: {
      find: 'safeFileName(input.fileName)',
      replace: "''",
      why: 'a key that names no file is the mirror of a key that names the wrong one: every reservation would be unreachable by its own deletion, and the evidence has to fail in this direction too',
    },
    evidenceFailsWith: 'binds the ledger row to the object the storage layer actually wrote',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: '\\[\\^\\\\p\\{L\\}\\\\p\\{N\\}\\._-\\]',
          sample: "const normalized = trimmed.normalize('NFKC').toLowerCase().replace(/[^\\p{L}\\p{N}._-]/gu, '_')",
          allow: ['packages/storage/src/object-storage.ts'],
          why: '`safeFileName` is the only file-name normalizer the ledger and the object store share; a second copy of the normalization chain is how `canonicalStorageFileName` disagreed with the name the object store wrote',
        },
      ],
    },
    requires: DATABASE_REQUIREMENT,
    rationale: 'This is the second hand-written derivation coming back: the copy normalizes like `safeFileName` but forgets to lowercase, so an upload named `Quarterly Report 2026.PNG` is reserved under `asset:<id>/Quarterly_Report_2026.PNG` while the object store (and therefore the delete side) names it `quarterly_report_2026.png`. The reservation is then unreachable by the deletion that should repay it and the bytes stay charged forever. `canonicalStorageFileName` was exactly this copy.',
  },
  {
    id: 'storage-quota-metadata-suffix-never-strands-a-reservation',
    chokepointSymbol: 'objectKeyIdentity',
    invariant: 'A reservation is released whenever the object it was reserved for is deleted, including when that object body is named with the metadata suffix the cloud adapter reserves.',
    chokepoint: CHOKEPOINT,
    file: CHOKEPOINT,
    find: "  if (parts.some(part => part === '.' || part === '..')) return undefined",
    replace: "  if (fileName.endsWith('.merchant-meta.json')) return undefined\n  if (parts.some(part => part === '.' || part === '..')) return undefined",
    evidence: EVIDENCE,
    overRejection: {
      find: '  if (parts.some(part => part === \'.\' || part === \'..\')) return undefined',
      replace: '  return undefined',
      why: 'an object key that names no object at all is the mirror of one that names the wrong object: no deletion ever releases its reservation, so the evidence must fail here too',
    },
    evidenceFailsWith: 'releases the object whose stored name ends in the cloud metadata suffix',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: "merchant-meta\\.json",
          sample: "if (fileName.endsWith('.merchant-meta.json')) return undefined",
          allow: ['packages/storage/src/object-storage.ts', 'packages/storage/src/reservation-key.ts'],
          why: 'the metadata suffix is handled in the storage layer only; a second place deciding that such a key names no object is the special case that stranded a settled reservation forever',
        },
      ],
    },
    requires: DATABASE_REQUIREMENT,
    rationale: 'Both storage adapters reserve only the *metadata* key `<body>.merchant-meta.json`, and both explicitly support a body uploaded under that suffix. The delete side used to skip any key with that suffix, so `asset.upload` of `config.merchant-meta.json` whose snapshot write failed deleted the object in compensation but never released the settled bytes - a silent, unalerted, permanent over-count.',
  },
  {
    id: 'storage-quota-legacy-row-attributed-only-from-one-object',
    chokepointSymbol: 'file_name_count',
    invariant: 'A legacy reservation row is rebuilt into a per-object key only when the workspace\'s durable records name exactly one object for the asset; two candidate objects are never resolved by picking one.',
    chokepoint: 'packages/persistence/src/migrations/232_storage_quota_unnameable_reservation_keys.sql',
    file: 'packages/persistence/src/migrations/232_storage_quota_unnameable_reservation_keys.sql',
    find: 'IF file_name_count <> 1 THEN',
    replace: 'IF file_name_count < 1 THEN',
    evidence: EVIDENCE,
    overRejection: {
      find: 'IF file_name_count <> 1 THEN',
      replace: 'IF file_name_count >= 0 THEN',
      why: 'a rebuild that never attributes a row is the mirror of one that guesses between two objects: the migration silently does nothing even for the unambiguous case, and the evidence must fail here as well',
    },
    evidenceFailsWith: 'names a legacy row from the durable object references migration 231 could not read, and never guesses between two objects',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: "split_part\\([^\\n]*'/', 4\\)",
          sample: "SELECT count(DISTINCT split_part(candidate.object_key, '/', 4))",
          allow: ['packages/persistence/src/migrations/232_storage_quota_unnameable_reservation_keys.sql', 'packages/persistence/src/migrations/231_storage_quota_per_object_reservation_keys.sql'],
          why: 'the durable object key is decoded into its asset and file-name segments in one place; a second decoder is a second answer to "which object does this key name", which is what migrations 231 and 232 disagreed about',
        },
      ],
    },
    requires: DATABASE_REQUIREMENT,
    rationale: 'The `<> 1` guard is what keeps the rebuild from guessing. With `< 1` the migration renames a bare row of an asset whose durable records name two distinct objects, attributing it to `min(file name)`; the evidence case seeds exactly that state (two upload events, one asset) and requires the row to stay bare, because crediting or re-pointing it could repay bytes whose object is still on disk - the same class of error as the prefix fallback.',
  },
  {
    id: 'storage-quota-rebuild-reads-past-force-rls',
    chokepointSymbol: 'object_storage_orphans',
    invariant: 'The migration that rebuilds legacy rows reads the durable tables it is given, even when it runs as the table owner those tables FORCE ROW LEVEL SECURITY for.',
    chokepoint: 'packages/persistence/src/migrations/232_storage_quota_unnameable_reservation_keys.sql',
    file: 'packages/persistence/src/migrations/232_storage_quota_unnameable_reservation_keys.sql',
    find: 'ALTER TABLE outbox_events NO FORCE ROW LEVEL SECURITY;',
    replace: 'ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;',
    evidence: EVIDENCE,
    overRejection: {
      find: 'IF file_name_count <> 1 THEN',
      replace: 'IF file_name_count >= 0 THEN',
      why: 'the mirror of a backfill that reads zero rows is a backfill that never writes any: a migration that refuses to repair the rows it can prove must fail the same evidence',
    },
    evidenceFailsWith: 'names the legacy row under the deployed schema-owner credential, where FORCE RLS applies to the reader',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: 'NO FORCE ROW LEVEL SECURITY;',
          sample: 'ALTER TABLE outbox_events NO FORCE ROW LEVEL SECURITY;',
          allow: [
            'packages/persistence/src/migrations/232_storage_quota_unnameable_reservation_keys.sql',
            'packages/persistence/src/migrations/231_storage_quota_per_object_reservation_keys.sql',
          ],
          why: 'the FORCE suspension and its restoration bracket the one backfill that needs them; the same statement in a second migration is a second place where a schema-owner reader can be locked out of its own rows',
        },
      ],
    },
    requires: DATABASE_REQUIREMENT,
    rationale: 'The deployed migration credential is the schema owner, not a superuser. Without the NO FORCE suspension every read in the backfill returns zero rows and the migration silently does nothing - green in a superuser test, broken in production. The evidence runs migration 232 as a non-superuser owner and requires the rename to happen, plus the FORCE flags to be restored afterwards.',
  },
]
