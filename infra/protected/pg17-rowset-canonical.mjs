// Byte-level contract for PG17 rowset observations. This module hashes values
// already read from a database; it does not assert where those values came from.
import { createHash } from 'node:crypto'

const ROW_DOMAIN = Buffer.from('pg17-canonical-rows/1\0', 'utf8')
const POLICY_DOMAIN = Buffer.from('pg17-rls-policy/1\0', 'utf8')
const MAX_RECORD_BYTES = 16 * 1024 * 1024

function frame(hash, value) {
  if (!Buffer.isBuffer(value) || value.length > MAX_RECORD_BYTES) throw new Error('canonical record must be a bounded Buffer')
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(value.length))
  hash.update(length).update(value)
}

export function canonicalRowsDigest(rows) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(rows.length)) throw new Error('rows must be an array')
  const ordered = rows.map(row => {
    if (!Buffer.isBuffer(row) || row.length > MAX_RECORD_BYTES) throw new Error('row must be a bounded Buffer')
    return row
  }).sort(Buffer.compare)
  const hash = createHash('sha256').update(ROW_DOMAIN)
  for (const row of ordered) frame(hash, row)
  return { row_count: ordered.length, canonical_rows_sha256: hash.digest('hex') }
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  throw new Error('RLS policy contains unsupported value')
}

export function rlsPolicyDigest({ enabled, forced, policies }) {
  if (typeof enabled !== 'boolean' || typeof forced !== 'boolean' || !Array.isArray(policies)) throw new Error('RLS policy observation invalid')
  const allowed = ['cmd', 'name', 'permissive', 'qual', 'roles', 'with_check']
  const encoded = policies.map(policy => {
    if (!policy || Object.getPrototypeOf(policy) !== Object.prototype || Object.keys(policy).sort().join(',') !== allowed.join(',')) throw new Error('RLS policy fields invalid')
    if (typeof policy.name !== 'string' || !policy.name || typeof policy.cmd !== 'string' || typeof policy.permissive !== 'boolean' || !Array.isArray(policy.roles) || !policy.roles.every(role => typeof role === 'string') || ![null, 'string'].includes(policy.qual === null ? null : typeof policy.qual) || ![null, 'string'].includes(policy.with_check === null ? null : typeof policy.with_check)) throw new Error('RLS policy values invalid')
    return Buffer.from(canonical({ ...policy, roles: [...policy.roles].sort() }), 'utf8')
  }).sort(Buffer.compare)
  const hash = createHash('sha256').update(POLICY_DOMAIN)
  frame(hash, Buffer.from(canonical({ enabled, forced }), 'utf8'))
  for (const policy of encoded) frame(hash, policy)
  return hash.digest('hex')
}
