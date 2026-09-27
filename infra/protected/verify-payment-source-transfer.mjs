import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateSourceReceiptBytes } from './transfer-payment-source-receipt.mjs'

const EVIDENCE_ROOT = '/var/lib/merchant-release-security/payment-evidence'
const HASH = /^[a-f0-9]{64}$/u
const TRANSFER_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.transfer\.json$/u
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function readPrivateRegular(path, uid, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.uid !== BigInt(uid) || (before.mode & 0o777n) !== 0o600n
        || before.size < 2n || before.size > BigInt(limit)) throw new Error('private transfer file owner, mode or size is invalid')
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
        || BigInt(bytes.length) !== before.size) throw new Error('private transfer file changed during verification')
    return bytes
  } finally { closeSync(fd) }
}

function exactRecord(record, copiedName) {
  const keys = ['schema_version', 'source_receipt_sha256', 'copied_receipt_sha256', 'source_path_sha256',
    'source_uid', 'source_mode', 'source_device', 'source_inode', 'transferred_at',
    'copied_filename', 'release_binding_verified', 'final_evidence']
  return record && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key))
    && record.schema_version === 'payment-source-receipt-transfer.v1'
    && HASH.test(record.source_receipt_sha256) && HASH.test(record.copied_receipt_sha256)
    && HASH.test(record.source_path_sha256) && record.source_uid === 100
    && record.source_mode === '0600' && /^[1-9][0-9]*$/u.test(record.source_device)
    && /^[1-9][0-9]*$/u.test(record.source_inode)
    && typeof record.transferred_at === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.transferred_at)
    && Number.isFinite(Date.parse(record.transferred_at))
    && record.copied_filename === copiedName
    && record.release_binding_verified === false && record.final_evidence === false
}

/** Independently checks copied bytes, not gateway origin or release provenance. */
export function verifyPaymentSourceTransfer({ recordPath, evidenceRoot = EVIDENCE_ROOT, readerUid = process.getuid() }) {
  if (!Number.isSafeInteger(readerUid) || readerUid <= 0 || readerUid === 100
      || !isAbsolute(recordPath ?? '') || !isAbsolute(evidenceRoot ?? '')) throw new Error('independent reader and absolute protected paths are required')
  const directory = dirname(recordPath)
  if (directory === evidenceRoot || !directory.startsWith(`${evidenceRoot}/`)
      || realpathSync(directory) !== resolve(directory)) throw new Error('transfer directory is outside the canonical evidence root')
  const dirStat = lstatSync(directory)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== readerUid
      || (dirStat.mode & 0o777) !== 0o700) throw new Error('transfer directory owner or mode is invalid')
  const match = TRANSFER_NAME.exec(basename(recordPath))
  if (!match) throw new Error('transfer record filename is invalid')
  const copiedName = `${match[1]}.source.json`
  const recordBytes = readPrivateRegular(recordPath, readerUid, 4_096)
  let record
  try { record = JSON.parse(recordBytes.toString('utf8')) } catch { throw new Error('transfer record JSON is invalid') }
  if (!recordBytes.equals(Buffer.from(`${JSON.stringify(record)}\n`)) || !exactRecord(record, copiedName))
    throw new Error('transfer record is not the exact review-only transfer contract')
  const copiedBytes = readPrivateRegular(join(directory, copiedName), readerUid, 65_536)
  let receipt
  try { receipt = JSON.parse(copiedBytes.toString('utf8')) } catch { throw new Error('copied gateway receipt JSON is invalid') }
  if (!validateSourceReceiptBytes(copiedBytes, `${receipt.request_id}.json`))
    throw new Error('copied bytes do not match the gateway receipt contract')
  if (record.source_receipt_sha256 !== digest(copiedBytes)
      || record.copied_receipt_sha256 !== digest(copiedBytes))
    throw new Error('copied receipt SHA-256 differs from the transfer record')
  return { schema_version: 'payment-source-transfer-review.v1', status: 'pass', review_only: true,
    copied_bytes_consistent: true, source_origin_verified: false, release_binding_verified: false,
    provider_and_ledger_reconciled: false, final_evidence: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.getuid() === 0 || process.getuid() === 100) throw new Error('run as the independent evidence reader, not root or gateway')
    const result = verifyPaymentSourceTransfer({ recordPath: process.argv[2] })
    process.stderr.write('REVIEW_ONLY: copied bytes match transfer metadata; gateway origin, release binding and payment facts remain unverified.\n')
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`payment source transfer review refused: ${error.message}\n`)
    process.exitCode = 1
  }
}
