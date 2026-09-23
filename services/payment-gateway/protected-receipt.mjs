import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fdatasyncSync, lstatSync, openSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const hash = value => createHash('sha256').update(String(value)).digest('hex')

/**
 * Capture only facts observed at the verified native Alipay callback boundary.
 * This is a source receipt, not signed release evidence. The final attester must
 * reconcile it with the provider and durable order/ledger state before signing.
 */
export function captureVerifiedNotifyReceipt(input) {
  const directory = input.directory
  if (!directory) return null
  if (!isAbsolute(directory)) throw new Error('payment receipt directory must be absolute')
  const directoryStat = lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0 || directoryStat.uid !== process.getuid()) {
    throw new Error('payment receipt directory must be a private directory owned by the gateway uid')
  }
  if (input.providerSignatureVerified !== true || input.apiCallbackStatus < 200 || input.apiCallbackStatus >= 300) {
    throw new Error('payment receipt requires verified provider signature and accepted API callback')
  }
  if (!Number.isSafeInteger(input.amountFen) || input.amountFen <= 0) throw new Error('payment receipt amount is invalid')
  const requestId = randomUUID()
  const receipt = {
    schema_version: 'payment-gateway-source-receipt.v1',
    source: 'alipay_native_notify',
    observed_at: new Date().toISOString(),
    request_id: requestId,
    callback_path: input.callbackPath,
    provider_signature_verified: true,
    api_callback_status: input.apiCallbackStatus,
    order_id_sha256: hash(input.orderId),
    provider_trade_id_sha256: hash(input.providerTradeId),
    workspace_id_sha256: hash(input.workspaceId),
    native_signature_sha256: hash(input.nativeSignature),
    native_signed_fields_sha256: hash(input.nativeSignedFields),
    amount_fen: input.amountFen,
    state: input.state,
    raw_body_stored: false,
    final_evidence: false,
  }
  const path = join(directory, `${requestId}.json`)
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const payload = Buffer.from(`${JSON.stringify(receipt)}\n`)
    let offset = 0
    while (offset < payload.length) offset += writeSync(descriptor, payload, offset, payload.length - offset)
    fdatasyncSync(descriptor)
  } finally { closeSync(descriptor) }
  return receipt
}
