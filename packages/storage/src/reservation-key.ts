/**
 * The single definition of a storage-quota reservation key.
 *
 * A reservation is bound to exactly one physical object: the object the storage
 * layer writes at `<zone>/<workspaceId>/<assetId>/<canonical file name>`. Its
 * ledger key is `asset:<assetId>/<canonical file name>`, and the ledger totals
 * only ever fall for the object a released row was reserved for.
 *
 * That property held only as long as the write side (which derives the key from
 * the upload request) and the delete side (which derives it back out of the
 * stored object key) computed the same string. They were three hand-written
 * expressions — `canonicalStorageFileName`, `assetReservationKeyForDeletedObject`
 * in apps/api/src/server.ts and migration 231's SQL — and they drifted:
 *
 *   * `canonicalStorageFileName` was a copy of `safeFileName`; the delete side
 *     additionally dropped any key ending in `.merchant-meta.json`, so a body
 *     legitimately uploaded under that name could never release its ledger row;
 *   * a release that missed the exact key fell back to a `LIKE 'asset:<id>/%'`
 *     prefix scan with no identity check, which released whichever *sibling*
 *     object's row happened to match while that object was still stored.
 *
 * So: `reservationKeyFor` and `parseReservationKey`/`objectKeyIdentity` are the
 * only implementations of the forward and the reverse derivation, they live
 * here, they share `safeFileName` (./object-storage.ts) as the only file-name
 * normalizer, and every caller — the API's upload and compensation paths, the
 * Postgres ledger repository, the migrations — calls them instead of restating
 * the shape.
 */
import { ObjectStorageError, safeFileName } from './object-storage.js'

/** `asset:<assetId>/<canonical file name>` — the shape of every per-object key. */
const RESERVATION_KEY_PREFIX = 'asset:'

export interface ReservationIdentity {
  assetId: string
  /** The canonical file name, i.e. `safeFileName`'s output. */
  fileName: string
}

function requireAssetId(assetId: string): string {
  const value = typeof assetId === 'string' ? assetId.trim() : ''
  // `/` would let one asset id spill into the file-name segment, and the unit
  // separator keeps ids comparable with the urlsafe forms the storage layer
  // accepts (`requireId` in ./object-storage.ts).
  if (!value || value.includes('/')) throw new ObjectStorageError('OBJECT_SCOPE_INVALID', '素材标识无效', 400)
  return value
}

/**
 * The ledger key for the object an upload is about to write.
 *
 * The file name is canonicalized here, by the same function that names the
 * stored object, so the key cannot name a file the object store does not have.
 */
export function reservationKeyFor(input: ReservationIdentity): string {
  const assetId = requireAssetId(input.assetId)
  return `${RESERVATION_KEY_PREFIX}${assetId}/${safeFileName(input.fileName)}`
}

/**
 * The object a per-object reservation key describes, or `undefined` when the
 * key is not per-object (e.g. the bare legacy `asset:<assetId>`).
 *
 * Deliberately strict: a key that does not round-trip through
 * `reservationKeyFor` is not treated as naming an object, because releasing on
 * a partial match is what released live sibling rows.
 */
export function parseReservationKey(key: string): ReservationIdentity | undefined {
  if (typeof key !== 'string' || !key.startsWith(RESERVATION_KEY_PREFIX)) return undefined
  const remainder = key.slice(RESERVATION_KEY_PREFIX.length)
  const separator = remainder.indexOf('/')
  if (separator <= 0 || separator === remainder.length - 1) return undefined
  const assetId = remainder.slice(0, separator)
  const fileName = remainder.slice(separator + 1)
  if (fileName.includes('/')) return undefined
  if (!assetId || assetId !== assetId.trim()) return undefined
  return { assetId, fileName }
}

/**
 * The object identity a stored object key names.
 *
 * `undefined` means "this key names no object this build can derive a ledger key
 * for" — a foreign workspace, a zone that is not a writable zone, a traversal
 * segment, or a file-name segment that is not the canonical name the storage
 * layer writes. Callers must treat it as "no release", never as "guess".
 */
export function objectKeyIdentity(objectKey: string, workspaceId: string): ReservationIdentity | undefined {
  if (typeof objectKey !== 'string' || !objectKey.trim() || objectKey.startsWith('/') || objectKey.includes('\\') || /[\u0000-\u001f\u007f\r\n]/u.test(objectKey)) return undefined
  const parts = objectKey.split('/')
  if (parts.length < 4) return undefined
  const [zone, workspace, assetId] = parts
  const fileName = parts.slice(3).join('/')
  if (zone !== 'quarantine' && zone !== 'clean') return undefined
  if (workspace !== workspaceId) return undefined
  if (!assetId?.trim() || !fileName.trim()) return undefined
  if (parts.some(part => part === '.' || part === '..')) return undefined
  try {
    // Round-trip: the stored key's last segment must be the canonical name, so
    // that a reservation key derived from it is exactly the key the write side
    // would have produced.
    if (safeFileName(fileName) !== fileName) return undefined
  } catch {
    return undefined
  }
  return { assetId, fileName }
}

/** Convenience for callers that already hold an object key. */
export function reservationKeyForObjectKey(objectKey: string, workspaceId: string): string | undefined {
  const identity = objectKeyIdentity(objectKey, workspaceId)
  return identity ? reservationKeyFor(identity) : undefined
}

/**
 * Whether a reservation key and a physical-deletion receipt describe the same
 * object. `true` also covers the keys this build cannot parse (a non-per-object
 * key such as a legacy bare row), where the receipt carries no claim to compare.
 */
export function deletionMatchesReservation(input: { workspaceId: string; reservationKey: string; objectKey: string }): boolean {
  const reserved = parseReservationKey(input.reservationKey)
  if (!reserved) return true
  const deleted = objectKeyIdentity(input.objectKey, input.workspaceId)
  if (!deleted) return false
  return reserved.assetId === deleted.assetId && reserved.fileName === deleted.fileName
}
