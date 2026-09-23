import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

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
  // A symlink in any parent component can move the protected sink outside the
  // host path checked by preflight. Realpath equality rejects every such alias.
  if (realpathSync(directory) !== resolve(directory)) throw new Error('payment receipt directory path must be canonical and contain no symlinks')
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
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  // A durable file payload alone does not guarantee the new directory entry
  // survives a crash. Sync the directory after the O_EXCL create as well.
  const directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
  return receipt
}

/**
 * Source facts from the live gateway. These are deliberately NOT final release
 * evidence: checkout has no provider settlement, and a refund submission must
 * still be checked against the provider and the durable billing ledger.
 */
export function captureGatewayOperationReceipt(input) {
  if (!input.directory) return null
  if (!['checkout', 'provider_query', 'refund', 'refund_query'].includes(input.operation)) throw new Error('unsupported gateway receipt operation')
  if (!input.orderId || !input.workspaceId || !Number.isSafeInteger(input.amountFen) || input.amountFen <= 0) throw new Error('gateway receipt identity or amount is invalid')
  if (input.operation === 'checkout') {
    if (!input.signedCheckoutParams || input.outcome !== 'created' || input.providerTradeId) throw new Error('checkout receipt requires signed checkout parameters only')
  } else if (!input.providerResponseSignatureVerified || !input.providerTradeId || !input.providerResponseReference) {
    throw new Error('provider receipt requires a verified response and provider identifiers')
  }
  if (input.operation === 'provider_query' && input.outcome !== 'paid') throw new Error('provider query receipt requires a paid result')
  if (input.operation === 'refund' && !['completed', 'processing'].includes(input.outcome)) throw new Error('refund receipt requires a real provider submission state')
  if (input.operation === 'refund_query') {
    if (!input.refundRequestId) throw new Error('refund query receipt requires a refund request id')
    if (input.providerNativeStatus !== 'REFUND_SUCCESS' || input.outcome !== 'succeeded') throw new Error('refund query receipt requires native success')
    if (!/^[a-f0-9]{64}$/u.test(input.signedResponseSha256 ?? '')) throw new Error('refund query receipt requires a verified signed response SHA-256')
  }
  const receipt = {
    schema_version: 'payment-gateway-operation-source-receipt.v1',
    source: input.operation === 'checkout' ? 'alipay_signed_checkout' : 'alipay_verified_response',
    operation: input.operation,
    observed_at: new Date().toISOString(),
    request_id: randomUUID(),
    order_id_sha256: hash(input.orderId),
    workspace_id_sha256: hash(input.workspaceId),
    ...(input.providerTradeId ? { provider_trade_id_sha256: hash(input.providerTradeId) } : {}),
    ...(input.providerResponseReference ? { provider_response_reference_sha256: hash(input.providerResponseReference) } : {}),
    ...(input.refundRequestId ? { refund_request_id_sha256: hash(input.refundRequestId) } : {}),
    ...(input.signedCheckoutParams ? { signed_checkout_params_sha256: hash(input.signedCheckoutParams) } : {}),
    ...(input.operation === 'refund_query' ? { signed_response_sha256: input.signedResponseSha256, provider_native_status: input.providerNativeStatus, ledger_state_observed: false } : {}),
    amount_fen: input.amountFen,
    outcome: input.outcome,
    provider_response_signature_verified: input.operation === 'checkout' ? false : true,
    raw_body_stored: false,
    final_evidence: false,
  }
  // Reuse the same exclusive, fsynced and uid-private sink as native callbacks.
  const directory = input.directory
  if (!isAbsolute(directory)) throw new Error('payment receipt directory must be absolute')
  if (realpathSync(directory) !== resolve(directory)) throw new Error('payment receipt directory path must be canonical and contain no symlinks')
  const directoryStat = lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0 || directoryStat.uid !== process.getuid()) throw new Error('payment receipt directory must be a private directory owned by the gateway uid')
  const path = join(directory, `${receipt.request_id}.json`)
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const payload = Buffer.from(`${JSON.stringify(receipt)}\n`)
    let offset = 0
    while (offset < payload.length) offset += writeSync(descriptor, payload, offset, payload.length - offset)
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  const directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
  return receipt
}
