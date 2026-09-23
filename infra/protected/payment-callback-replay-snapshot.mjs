import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = value => createHash('sha256').update(String(value)).digest('hex')
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{3,160}$/u.test(value)

function privateDirectory(directory) {
  if (!isAbsolute(directory) || realpathSync(directory) !== resolve(directory)) throw new Error('protected output directory must be absolute and canonical')
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error('protected output directory must be owned by this uid and mode 0700')
}

function readPrivateBytes(path) {
  if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) throw new Error('protected input path must be absolute and canonical')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > 65_536) throw new Error('protected input must be a private regular file under 64 KiB')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
const readPrivateJson = path => JSON.parse(readPrivateBytes(path).toString('utf8'))

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

export function validateBinding(binding) {
  if (!binding || !identifier(binding.release_id) || !/^[A-Za-z0-9_-]{22,128}$/u.test(binding.deployment_nonce ?? '') || !identifier(binding.order_id) || !identifier(binding.workspace_id) || !identifier(binding.provider_trade_id) || !Number.isSafeInteger(binding.amount_fen) || binding.amount_fen <= 0) throw new Error('invalid fixed payment replay binding')
  return binding
}

export function validateNativeReceipt(receipt, binding) {
  if (receipt?.schema_version !== 'payment-gateway-source-receipt.v1' || receipt.source !== 'alipay_native_notify' || receipt.provider_signature_verified !== true || receipt.api_callback_status < 200 || receipt.api_callback_status >= 300 || receipt.callback_path !== '/v1/billing/callback/alipay' || receipt.state !== 'paid' || receipt.raw_body_stored !== false || receipt.final_evidence !== false || !hex64(receipt.native_signature_sha256) || !hex64(receipt.native_signed_fields_sha256) || receipt.order_id_sha256 !== sha256(binding.order_id) || receipt.workspace_id_sha256 !== sha256(binding.workspace_id) || receipt.provider_trade_id_sha256 !== sha256(binding.provider_trade_id) || receipt.amount_fen !== binding.amount_fen || !identifier(receipt.request_id) || !Number.isFinite(Date.parse(receipt.observed_at))) throw new Error('native callback receipt does not match fixed wallet order and verified payment')
  return receipt
}

export async function readScopedSnapshot(client, binding) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const guard = (await client.query(`SELECT current_user AS role_name, current_setting('transaction_read_only') AS read_only, current_setting('row_security') AS row_security,
      r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS role_membership,
      has_table_privilege(current_user, 'billing_orders', 'INSERT') OR has_table_privilege(current_user, 'billing_orders', 'UPDATE') OR has_table_privilege(current_user, 'billing_orders', 'DELETE') OR has_table_privilege(current_user, 'billing_orders', 'TRUNCATE') OR
      has_table_privilege(current_user, 'billing_transactions', 'INSERT') OR has_table_privilege(current_user, 'billing_transactions', 'UPDATE') OR has_table_privilege(current_user, 'billing_transactions', 'DELETE') OR has_table_privilege(current_user, 'billing_transactions', 'TRUNCATE') AS can_mutate,
      (SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid IN ('billing_orders'::regclass, 'billing_transactions'::regclass)) AS forced_rls
      FROM pg_roles r WHERE r.rolname = current_user`)).rows[0]
    if (!guard || guard.role_name !== 'payment_evidence_reader' || guard.read_only !== 'on' || guard.row_security !== 'on' || guard.rolsuper || guard.rolbypassrls || guard.rolcreaterole || guard.rolcreatedb || guard.rolreplication || guard.role_membership || guard.can_mutate || guard.forced_rls !== true) throw new Error('dedicated read-only RLS evidence role is not verified')
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [binding.workspace_id])
    const order = (await client.query('SELECT id, workspace_id, state, payment_mode, channel, amount_fen, provider_trade_id FROM billing_orders WHERE workspace_id=$1 AND id=$2', [binding.workspace_id, binding.order_id])).rows
    const transactions = (await client.query("SELECT id, workspace_id, order_id, type, amount_fen FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='recharge' ORDER BY id LIMIT 2", [binding.workspace_id, binding.order_id])).rows
    if (order.length !== 1 || order[0].workspace_id !== binding.workspace_id || order[0].id !== binding.order_id || order[0].state !== 'paid' || order[0].payment_mode !== 'provider' || order[0].channel !== 'alipay' || Number(order[0].amount_fen) !== binding.amount_fen || order[0].provider_trade_id !== binding.provider_trade_id) throw new Error('production order does not match fixed paid provider facts')
    if (transactions.length !== 1 || transactions[0].workspace_id !== binding.workspace_id || transactions[0].order_id !== binding.order_id || transactions[0].type !== 'recharge' || Number(transactions[0].amount_fen) !== binding.amount_fen) throw new Error('production recharge ledger must contain exactly one matching row')
    const output = { observed_at: new Date().toISOString(), transaction_count: transactions.length, transaction_id_sha256: sha256(transactions[0].id), transaction_amount_fen: Number(transactions[0].amount_fen), order_state: order[0].state, order_payment_mode: order[0].payment_mode }
    await client.query('COMMIT')
    return output
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
}

export function validateReplayPair(before, after, binding) {
  const identity = { release_id: binding.release_id, deployment_nonce: binding.deployment_nonce, order_id_sha256: sha256(binding.order_id), workspace_id_sha256: sha256(binding.workspace_id), provider_trade_id_sha256: sha256(binding.provider_trade_id), amount_fen: binding.amount_fen }
  for (const snapshot of [before, after]) {
    for (const [key, value] of Object.entries(identity)) if (snapshot?.[key] !== value) throw new Error(`callback replay binding mismatch: ${key}`)
    if (snapshot?.transaction_count !== 1 || !hex64(snapshot?.transaction_id_sha256) || snapshot.transaction_amount_fen !== binding.amount_fen || snapshot.order_state !== 'paid' || snapshot.order_payment_mode !== 'provider' || !hex64(snapshot.native_signature_sha256) || !hex64(snapshot.native_signed_fields_sha256) || !identifier(snapshot.native_request_id) || !Number.isFinite(Date.parse(snapshot.observed_at)) || !Number.isFinite(Date.parse(snapshot.native_observed_at)) || Date.parse(snapshot.native_observed_at) > Date.parse(snapshot.observed_at)) throw new Error('callback replay snapshot is incomplete')
  }
  if (before.transaction_id_sha256 !== after.transaction_id_sha256 || before.transaction_amount_fen !== after.transaction_amount_fen || before.native_signature_sha256 !== after.native_signature_sha256 || before.native_signed_fields_sha256 !== after.native_signed_fields_sha256 || before.native_request_id === after.native_request_id || Date.parse(after.native_observed_at) <= Date.parse(before.observed_at) || Date.parse(after.observed_at) <= Date.parse(after.native_observed_at)) throw new Error('callback replay did not prove unchanged ledger after the same native callback')
  return true
}

export async function produceSnapshot({ phase, bindingPath, nativeReceiptPath, beforePath, outputDirectory, databaseUrl }) {
  if (!['before', 'after'].includes(phase) || !databaseUrl || !outputDirectory) throw new Error('phase, protected output and read-only database URL are required')
  privateDirectory(outputDirectory)
  const binding = validateBinding(readPrivateJson(bindingPath))
  const native = validateNativeReceipt(readPrivateJson(nativeReceiptPath), binding)
  const { Client } = await import('pg')
  const client = new Client({ connectionString: databaseUrl, application_name: 'payment-callback-replay-evidence' })
  await client.connect()
  let ledger
  try { ledger = await readScopedSnapshot(client, binding) } finally { await client.end() }
  const snapshot = {
    schema_version: 'payment-callback-replay-db-snapshot.v1', phase, source: 'production_postgres_read_only',
    release_id: binding.release_id, deployment_nonce: binding.deployment_nonce,
    order_id_sha256: sha256(binding.order_id), workspace_id_sha256: sha256(binding.workspace_id), provider_trade_id_sha256: sha256(binding.provider_trade_id), amount_fen: binding.amount_fen,
    native_request_id: native.request_id, native_observed_at: native.observed_at, native_signature_sha256: native.native_signature_sha256, native_signed_fields_sha256: native.native_signed_fields_sha256,
    ...ledger, production_origin_verified: false, final_evidence: false,
  }
  if (phase === 'after') {
    if (!beforePath) throw new Error('after phase requires protected before snapshot')
    const before = readPrivateJson(beforePath)
    if (before.schema_version !== snapshot.schema_version || before.phase !== 'before') throw new Error('before snapshot is invalid')
    validateReplayPair(before, snapshot, binding)
    snapshot.replay_db_unchanged = true
    snapshot.outcome = 'candidate_idempotent_not_final_evidence'
    snapshot.before_snapshot_sha256 = createHash('sha256').update(readPrivateBytes(beforePath)).digest('hex')
  }
  return writePrivateJson(outputDirectory, snapshot)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [phase, bindingPath, nativeReceiptPath, outputDirectory, beforePath] = process.argv.slice(2)
  produceSnapshot({ phase, bindingPath, nativeReceiptPath, outputDirectory, beforePath, databaseUrl: process.env.PAYMENT_EVIDENCE_READONLY_DATABASE_URL })
    .then(path => { process.stdout.write(`${path}\n`) })
    .catch(error => { process.stderr.write(`payment callback replay snapshot refused: ${error.message}\n`); process.exitCode = 1 })
}
