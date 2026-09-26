import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = value => createHash('sha256').update(String(value)).digest('hex')
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{3,160}$/u.test(value)

function privateDirectory(directory) {
  if (!isAbsolute(directory) || realpathSync(directory) !== resolve(directory)) throw new Error('protected directory must be absolute and canonical')
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error('protected directory must be owned by this uid and mode 0700')
}

function readPrivateDocument(path) {
  if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) throw new Error('protected input path must be absolute and canonical')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > 65_536) throw new Error('protected input must be a private regular file under 64 KiB')
    const bytes = readFileSync(fd)
    return { value: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') }
  } finally { closeSync(fd) }
}
const readPrivateJson = path => readPrivateDocument(path).value

function writePrivateJson(directory, value) {
  privateDirectory(directory)
  const path = join(directory, `${randomUUID()}.json`)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(dir) } finally { closeSync(dir) }
  return path
}

export function validateRefundBinding(binding) {
  if (!binding || !identifier(binding.release_id) || !/^[A-Za-z0-9_-]{22,128}$/u.test(binding.deployment_nonce ?? '') || !identifier(binding.order_id) || !identifier(binding.workspace_id) || !identifier(binding.provider_trade_id) || !identifier(binding.refund_request_id) || !identifier(binding.reservation_key) || !Number.isSafeInteger(binding.amount_fen) || binding.amount_fen <= 0 || !new RegExp(`^recharge-refund:${binding.order_id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:[1-9][0-9]*$`, 'u').test(binding.reservation_key)) throw new Error('invalid fixed refund binding')
  return binding
}

export function validateRefundSourceReceipt(receipt, binding, phase) {
  const operation = phase === 'before' ? 'refund' : phase === 'after' ? 'refund_query' : null
  if (!operation || receipt?.schema_version !== 'payment-gateway-operation-source-receipt.v1' || receipt.source !== 'alipay_verified_response' || receipt.operation !== operation || receipt.provider_response_signature_verified !== true || receipt.raw_body_stored !== false || receipt.final_evidence !== false || receipt.order_id_sha256 !== sha256(binding.order_id) || receipt.workspace_id_sha256 !== sha256(binding.workspace_id) || receipt.provider_trade_id_sha256 !== sha256(binding.provider_trade_id) || receipt.refund_request_id_sha256 !== sha256(binding.refund_request_id) || !hex64(receipt.provider_response_reference_sha256) || receipt.amount_fen !== binding.amount_fen || !identifier(receipt.request_id) || !Number.isFinite(Date.parse(receipt.observed_at))) throw new Error('verified refund source receipt does not match fixed order and refund')
  if (phase === 'before' && !['processing', 'completed'].includes(receipt.outcome)) throw new Error('refund submission receipt is not accepted')
  if (phase === 'after' && (receipt.outcome !== 'succeeded' || receipt.provider_native_status !== 'REFUND_SUCCESS' || receipt.ledger_state_observed !== false || !hex64(receipt.signed_response_sha256))) throw new Error('final refund query receipt is not verified native success')
  return receipt
}

export async function readRefundLedgerSnapshot(client, binding, phase) {
  if (!['before', 'after'].includes(phase)) throw new Error('invalid refund snapshot phase')
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const guard = (await client.query(`SELECT current_user AS role_name, current_setting('transaction_read_only') AS read_only, current_setting('row_security') AS row_security,
      r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS role_membership,
      has_table_privilege(current_user, 'billing_orders', 'INSERT') OR has_table_privilege(current_user, 'billing_orders', 'UPDATE') OR has_table_privilege(current_user, 'billing_orders', 'DELETE') OR has_table_privilege(current_user, 'billing_orders', 'TRUNCATE') OR
      has_table_privilege(current_user, 'billing_transactions', 'INSERT') OR has_table_privilege(current_user, 'billing_transactions', 'UPDATE') OR has_table_privilege(current_user, 'billing_transactions', 'DELETE') OR has_table_privilege(current_user, 'billing_transactions', 'TRUNCATE') AS can_mutate,
      (SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner <> r.oid AND
        (SELECT count(*) = 1 AND bool_and(
          p.polname = c.relname || '_workspace_isolation' AND p.polpermissive
          AND p.polcmd = '*' AND p.polroles = ARRAY[0]::oid[]
          AND pg_get_expr(p.polqual, p.polrelid) = '(workspace_id = current_setting(''app.workspace_id''::text, true))'
        ) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polcmd IN ('r', '*')
          AND (0 = ANY(p.polroles) OR r.oid = ANY(p.polroles)))
      ) FROM pg_class c WHERE c.oid IN ('billing_orders'::regclass, 'billing_transactions'::regclass)) AS forced_rls
      FROM pg_roles r WHERE r.rolname = current_user`)).rows[0]
    if (!guard || guard.role_name !== 'payment_evidence_reader' || guard.read_only !== 'on' || guard.row_security !== 'on' || guard.rolsuper || guard.rolbypassrls || guard.rolcreaterole || guard.rolcreatedb || guard.rolreplication || guard.role_membership || guard.can_mutate || guard.forced_rls !== true) throw new Error('dedicated read-only RLS evidence role is not verified')
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [binding.workspace_id])
    const orders = (await client.query('SELECT id,workspace_id,state,payment_mode,channel,amount_fen,provider_trade_id FROM billing_orders WHERE workspace_id=$1 AND id=$2 LIMIT 2', [binding.workspace_id, binding.order_id])).rows
    const recharge = (await client.query("SELECT id,workspace_id,order_id,type,amount_fen FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='recharge' LIMIT 2", [binding.workspace_id, binding.order_id])).rows
    const reservation = (await client.query("SELECT id,workspace_id,order_id,type,amount_fen FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='debit' LIMIT 2", [binding.workspace_id, binding.reservation_key])).rows
    const releases = (await client.query("SELECT id FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='refund' LIMIT 2", [binding.workspace_id, `release:${binding.reservation_key}`])).rows
    const order = orders[0]
    if (orders.length !== 1 || order.workspace_id !== binding.workspace_id || order.id !== binding.order_id || order.state !== (phase === 'before' ? 'paid' : 'closed') || order.payment_mode !== 'provider' || order.channel !== 'alipay' || Number(order.amount_fen) !== binding.amount_fen || order.provider_trade_id !== binding.provider_trade_id) throw new Error('refund order does not match the fixed provider facts and expected phase')
    if (recharge.length !== 1 || recharge[0].workspace_id !== binding.workspace_id || recharge[0].order_id !== binding.order_id || recharge[0].type !== 'recharge' || Number(recharge[0].amount_fen) !== binding.amount_fen) throw new Error('refund order has no unique matching recharge credit')
    if (reservation.length !== 1 || reservation[0].workspace_id !== binding.workspace_id || reservation[0].order_id !== binding.reservation_key || reservation[0].type !== 'debit' || Number(reservation[0].amount_fen) !== binding.amount_fen || releases.length !== 0) throw new Error('refund reservation is missing, duplicated or released')
    const result = { observed_at: new Date().toISOString(), order_state: order.state, recharge_transaction_sha256: sha256(recharge[0].id), reservation_transaction_sha256: sha256(reservation[0].id), amount_fen: binding.amount_fen, release_count: releases.length }
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
}

export function validateRefundSnapshotPair(before, after, binding) {
  for (const snapshot of [before, after]) {
    if (snapshot?.claimed_release_id !== binding.release_id || snapshot.claimed_deployment_nonce !== binding.deployment_nonce || snapshot.release_binding_verified !== false || snapshot.source_provenance_verified !== false || snapshot.final_evidence !== false || !hex64(snapshot.source_receipt_sha256) || snapshot.order_id_sha256 !== sha256(binding.order_id) || snapshot.workspace_id_sha256 !== sha256(binding.workspace_id) || snapshot.provider_trade_id_sha256 !== sha256(binding.provider_trade_id) || snapshot.refund_request_id_sha256 !== sha256(binding.refund_request_id) || snapshot.reservation_key_sha256 !== sha256(binding.reservation_key) || snapshot.amount_fen !== binding.amount_fen || snapshot.release_count !== 0 || !hex64(snapshot.recharge_transaction_sha256) || !hex64(snapshot.reservation_transaction_sha256) || !identifier(snapshot.source_request_id) || !Number.isFinite(Date.parse(snapshot.observed_at)) || !Number.isFinite(Date.parse(snapshot.source_observed_at))) throw new Error('refund snapshot binding or ledger facts are incomplete')
  }
  if (before.phase !== 'before' || before.order_state !== 'paid' || before.source_operation !== 'refund' || after.phase !== 'after' || after.order_state !== 'closed' || after.source_operation !== 'refund_query' || before.recharge_transaction_sha256 !== after.recharge_transaction_sha256 || before.reservation_transaction_sha256 !== after.reservation_transaction_sha256 || before.source_request_id === after.source_request_id || Date.parse(before.source_observed_at) > Date.parse(before.observed_at) || Date.parse(after.source_observed_at) <= Date.parse(before.observed_at) || Date.parse(after.source_observed_at) > Date.parse(after.observed_at)) throw new Error('refund snapshots do not prove one reserved wallet debit and closed order')
  return true
}

export async function produceRefundSnapshot({ phase, bindingPath, sourceReceiptPath, beforePath, outputDirectory, databaseUrl }) {
  if (!['before', 'after'].includes(phase) || !databaseUrl || !outputDirectory) throw new Error('phase, protected output and read-only database URL are required')
  privateDirectory(outputDirectory)
  const binding = validateRefundBinding(readPrivateJson(bindingPath))
  const sourceDocument = readPrivateDocument(sourceReceiptPath)
  const source = validateRefundSourceReceipt(sourceDocument.value, binding, phase)
  const { Client } = await import('pg')
  const client = new Client({ connectionString: databaseUrl, application_name: 'payment-refund-ledger-evidence' })
  await client.connect()
  let ledger
  try { ledger = await readRefundLedgerSnapshot(client, binding, phase) } finally { await client.end() }
  const snapshot = {
    schema_version: 'payment-refund-ledger-snapshot.v1', phase, source: 'production_postgres_read_only',
    claimed_release_id: binding.release_id, claimed_deployment_nonce: binding.deployment_nonce,
    order_id_sha256: sha256(binding.order_id), workspace_id_sha256: sha256(binding.workspace_id), provider_trade_id_sha256: sha256(binding.provider_trade_id), refund_request_id_sha256: sha256(binding.refund_request_id), reservation_key_sha256: sha256(binding.reservation_key),
    source_request_id: source.request_id, source_observed_at: source.observed_at, source_operation: source.operation, source_receipt_sha256: sourceDocument.sha256,
    ...ledger, production_origin_verified: false, source_provenance_verified: false, release_binding_verified: false, final_evidence: false,
  }
  if (phase === 'after') {
    if (!beforePath) throw new Error('after phase requires protected before snapshot')
    const before = readPrivateJson(beforePath)
    validateRefundSnapshotPair(before, snapshot, binding)
    snapshot.refund_db_transition_observed = true
    snapshot.outcome = 'candidate_refund_ledger_transition_not_final_evidence'
  }
  return writePrivateJson(outputDirectory, snapshot)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [phase, bindingPath, sourceReceiptPath, outputDirectory, beforePath] = process.argv.slice(2)
  produceRefundSnapshot({ phase, bindingPath, sourceReceiptPath, outputDirectory, beforePath, databaseUrl: process.env.PAYMENT_EVIDENCE_READONLY_DATABASE_URL })
    .then(path => { process.stderr.write('REVIEW_ONLY: source ownership transfer and release provenance are unverified; this artifact cannot satisfy the payment release gate.\n'); process.stdout.write(`${path}\n`) })
    .catch(error => { process.stderr.write(`payment refund snapshot refused: ${error.message}\n`); process.exitCode = 1 })
}
