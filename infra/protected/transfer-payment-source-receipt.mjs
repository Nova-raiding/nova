import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SECURITY_ROOT = '/var/lib/merchant-release-security'
const EVIDENCE_ROOT = '/var/lib/merchant-release-security/payment-evidence'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const HASH = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CALLBACK_PATHS = new Set(['/v1/billing/callback/alipay', '/v1/subscriptions/callback/alipay', '/v1/commercial/callback/alipay'])

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key))
}
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value))
}
function hashField(value) { return typeof value === 'string' && HASH.test(value) }
function validCommon(receipt) {
  return UUID.test(receipt.request_id ?? '') && timestamp(receipt.observed_at)
    && hashField(receipt.order_id_sha256) && hashField(receipt.workspace_id_sha256)
    && Number.isSafeInteger(receipt.amount_fen) && receipt.amount_fen > 0
    && receipt.raw_body_stored === false && receipt.final_evidence === false
}

/** Accept only the exact producer contract; unknown data is never copied. */
export function validateSourceReceipt(receipt, filename) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || `${receipt.request_id}.json` !== filename || !validCommon(receipt)) return false
  if (receipt.schema_version === 'payment-gateway-source-receipt.v1') {
    const fields = ['schema_version', 'source', 'observed_at', 'request_id', 'callback_path', 'provider_signature_verified', 'api_callback_status', 'order_id_sha256', 'provider_trade_id_sha256', 'workspace_id_sha256', 'native_signature_sha256', 'native_signed_fields_sha256', 'amount_fen', 'state', 'raw_body_stored', 'final_evidence']
    return exactKeys(receipt, fields)
      && receipt.source === 'alipay_native_notify' && CALLBACK_PATHS.has(receipt.callback_path)
      && receipt.provider_signature_verified === true && Number.isSafeInteger(receipt.api_callback_status) && receipt.api_callback_status >= 200 && receipt.api_callback_status < 300
      && hashField(receipt.provider_trade_id_sha256) && hashField(receipt.native_signature_sha256) && hashField(receipt.native_signed_fields_sha256)
      && ['paid', 'closed', 'pending'].includes(receipt.state)
  }
  if (receipt.schema_version !== 'payment-gateway-operation-source-receipt.v1') return false
  const base = ['schema_version', 'source', 'operation', 'observed_at', 'request_id', 'order_id_sha256', 'workspace_id_sha256', 'amount_fen', 'outcome', 'provider_response_signature_verified', 'raw_body_stored', 'final_evidence']
  const operation = receipt.operation
  if (operation === 'checkout') {
    return exactKeys(receipt, [...base, 'signed_checkout_params_sha256']) && receipt.source === 'alipay_signed_checkout'
      && receipt.provider_response_signature_verified === false && receipt.outcome === 'created' && hashField(receipt.signed_checkout_params_sha256)
  }
  if (operation === 'provider_query') {
    return exactKeys(receipt, [...base, 'provider_trade_id_sha256', 'provider_response_reference_sha256']) && receipt.source === 'alipay_verified_response'
      && receipt.provider_response_signature_verified === true && receipt.outcome === 'paid'
      && hashField(receipt.provider_trade_id_sha256) && hashField(receipt.provider_response_reference_sha256)
  }
  if (operation === 'refund') {
    return exactKeys(receipt, [...base, 'provider_trade_id_sha256', 'provider_response_reference_sha256', 'refund_request_id_sha256']) && receipt.source === 'alipay_verified_response'
      && receipt.provider_response_signature_verified === true && ['completed', 'processing'].includes(receipt.outcome)
      && hashField(receipt.provider_trade_id_sha256) && hashField(receipt.provider_response_reference_sha256) && hashField(receipt.refund_request_id_sha256)
  }
  if (operation === 'refund_query') {
    return exactKeys(receipt, [...base, 'provider_trade_id_sha256', 'provider_response_reference_sha256', 'refund_request_id_sha256', 'signed_response_sha256', 'provider_native_status', 'ledger_state_observed'])
      && receipt.source === 'alipay_verified_response' && receipt.provider_response_signature_verified === true && receipt.outcome === 'succeeded'
      && hashField(receipt.provider_trade_id_sha256) && hashField(receipt.provider_response_reference_sha256) && hashField(receipt.refund_request_id_sha256)
      && hashField(receipt.signed_response_sha256) && receipt.provider_native_status === 'REFUND_SUCCESS' && receipt.ledger_state_observed === false
  }
  return false
}
export function validateSourceReceiptBytes(bytes, filename) {
  let receipt
  try { receipt = JSON.parse(bytes.toString('utf8')) } catch { return false }
  // The producer emits canonical JSON plus one LF. Besides enforcing its wire
  // format, this rejects duplicate JSON keys that JSON.parse would collapse
  // before the strict property allowlist could inspect them.
  if (!Buffer.isBuffer(bytes) || !bytes.equals(Buffer.from(`${JSON.stringify(receipt)}\n`))) return false
  return validateSourceReceipt(receipt, filename)
}

function canonicalPrivateDirectory(path, uid) {
  if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) throw new Error('directory must be absolute and canonical')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new Error('directory ownership or mode is invalid')
}

function writeOwnedFile(directory, filename, bytes, uid, gid) {
  const path = join(directory, filename)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    fchownSync(fd, uid, gid)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(path)
    throw error
  }
  closeSync(fd)
  return path
}

function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** A host-root, read-only transfer of one gateway receipt; never final release evidence. */
export function transferPaymentSourceReceipt({ sourcePath, outputDirectory, readerUid, expectedSourceUid = 100, sourceRoot, outputRoot = EVIDENCE_ROOT }) {
  if (!Number.isSafeInteger(readerUid) || readerUid <= 0 || readerUid === expectedSourceUid) throw new Error('independent evidence reader uid is required')
  if (process.getuid() !== 0 && expectedSourceUid === 100) throw new Error('protected transfer requires host root')
  if (!isAbsolute(sourcePath) || !isAbsolute(outputDirectory) || !isAbsolute(sourceRoot ?? '') || !sourceRoot.startsWith(`${SECURITY_ROOT}/`) || dirname(sourcePath) !== sourceRoot || (outputDirectory !== outputRoot && !outputDirectory.startsWith(`${outputRoot}/`))) throw new Error('source or destination is outside the protected payment roots')
  if (!/^[a-f0-9-]{36}\.json$/u.test(basename(sourcePath))) throw new Error('gateway receipt filename is invalid')
  canonicalPrivateDirectory(sourceRoot, expectedSourceUid)
  canonicalPrivateDirectory(outputDirectory, readerUid)
  const fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes
  let stat
  try {
    stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.uid !== BigInt(expectedSourceUid) || (stat.mode & 0o777n) !== 0o600n || stat.size < 2n || stat.size > 65_536n) throw new Error('gateway receipt owner, mode or size is invalid')
    bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs || BigInt(bytes.length) !== stat.size) throw new Error('gateway receipt changed during transfer')
  } finally { closeSync(fd) }
  if (!validateSourceReceiptBytes(bytes, basename(sourcePath))) throw new Error('source is not a gateway receipt or violates the exact receipt schema')
  const destination = lstatSync(outputDirectory)
  const id = randomUUID()
  const record = {
    schema_version: 'payment-source-receipt-transfer.v1',
    source_receipt_sha256: sha256(bytes),
    copied_receipt_sha256: sha256(bytes),
    source_path_sha256: sha256(Buffer.from(sourcePath)),
    source_uid: Number(stat.uid),
    source_mode: '0600',
    source_device: String(stat.dev),
    source_inode: String(stat.ino),
    transferred_at: new Date().toISOString(),
    copied_filename: `${id}.source.json`,
    release_binding_verified: false,
    final_evidence: false,
  }
  let receiptPath
  let recordPath
  try {
    receiptPath = writeOwnedFile(outputDirectory, `${id}.source.json`, bytes, readerUid, destination.gid)
    recordPath = writeOwnedFile(outputDirectory, `${id}.transfer.json`, Buffer.from(`${JSON.stringify(record)}\n`), readerUid, destination.gid)
    syncDirectory(outputDirectory)
  } catch (error) {
    if (recordPath) unlinkSync(recordPath)
    if (receiptPath) unlinkSync(receiptPath)
    try { syncDirectory(outputDirectory) } catch { /* original failure remains authoritative */ }
    throw error
  }
  return { receiptPath, recordPath, sourceReceiptSha256: record.source_receipt_sha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [sourcePath, outputDirectory, readerUid] = process.argv.slice(2)
    const result = transferPaymentSourceReceipt({ sourcePath, outputDirectory, readerUid: Number(readerUid), sourceRoot: process.env.PAYMENT_PROTECTED_RECEIPT_HOST_DIR })
    process.stderr.write('REVIEW_ONLY: source bytes transferred; deployment identity and provider/ledger reconciliation remain unverified.\n')
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`payment source receipt transfer refused: ${error.message}\n`)
    process.exitCode = 1
  }
}
