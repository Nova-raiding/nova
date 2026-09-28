// Isolated 254→255 restore core. The host adapter is deliberately absent:
// only a separately installed, digest-pinned root controller may supply
// Docker/PG operations and signing material. No live database operation exists.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { reviewBridge255BackupSource, reviewBridge255HostHandoff } from './ecs-bridge-255-host-handoff.mjs'

const HEX = /^[a-f0-9]{64}$/u
const fail = reason => { throw new Error(`BRIDGE_255_RESTORE_${reason}`) }
const check = (ok, reason) => { if (!ok) fail(reason) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).filter(key => key !== 'signature_base64').sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const historyHash = rows => sha(rows.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))

function verifyRows(rows, expected, version, prefixHash) {
  check(Array.isArray(rows) && rows.length === version && expected.length === version,
    `PREFIX_${version}_LENGTH_INVALID`)
  for (let index = 0; index < version; index++) {
    const row = rows[index], pinned = expected[index]
    check(row && Object.keys(row).sort().join(',') === 'checksum,name,version'
      && row.version === index + 1 && row.name === pinned.name
      && row.checksum === pinned.checksum && HEX.test(row.checksum ?? ''),
    `PREFIX_${version}_ROW_INVALID`)
  }
  check(historyHash(rows) === prefixHash, `PREFIX_${version}_HASH_INVALID`)
}

function verifyExpectedRows(rows, plan, migration255) {
  check(Array.isArray(rows) && rows.length === 255, 'EXPECTED_HISTORY_LENGTH_INVALID')
  for (let index = 0; index < 255; index++) {
    const row = rows[index]
    check(row && Object.keys(row).sort().join(',') === 'checksum,name,version'
      && row.version === index + 1 && /^[a-z0-9][a-z0-9_]*$/u.test(row.name ?? '')
      && HEX.test(row.checksum ?? ''), 'EXPECTED_HISTORY_ROW_INVALID')
  }
  check(historyHash(rows.slice(0, 254)) === plan.database.prefix_254_sha256
    && historyHash(rows) === plan.database.prefix_255_sha256,
  'EXPECTED_HISTORY_PLAN_MISMATCH')
  check(Buffer.isBuffer(migration255?.sql) && migration255.sql.length > 0
    && migration255.sql.length <= 4 * 1024 * 1024
    && migration255.version === 255 && migration255.name === rows[254].name
    && sha(migration255.sql) === rows[254].checksum,
  'MIGRATION_255_ASSET_MISMATCH')
}

function verifyIsolation(state, plan, sourceId) {
  check(state && Object.keys(state).sort().join(',') === [
    'container_id', 'database_id_sha256', 'image_id', 'network_id', 'network_internal',
    'published_ports', 'volume_name', 'volume_preserved', 'source_mounted',
  ].sort().join(',')
    && HEX.test(state.container_id ?? '') && HEX.test(state.network_id ?? '')
    && state.image_id === plan.pg17_image_ref && HEX.test(state.database_id_sha256 ?? '')
    && state.database_id_sha256 !== sourceId
    && state.network_internal === true && Array.isArray(state.published_ports)
    && state.published_ports.length === 0 && state.source_mounted === false
    && state.volume_preserved === true
    && /^merchant_restore_data_[A-Za-z0-9_-]{12,64}$/u.test(state.volume_name ?? ''),
  'ISOLATION_INVALID')
}

/**
 * Restores a signed 254 dump only on a new isolated PG17 network/volume,
 * applies exactly the pinned 255 SQL, and signs the complete history result.
 * A failure quarantines the attempt and preserves its volume for diagnosis.
 */
export async function produceBridge255Pg17Restore({ plan, signedSourcePlan, manifest, attestation,
  backupPath, expectedRows, migration255, publicPem, privatePem, keyId,
  now = () => new Date() }, isolation) {
  check(isolation && ['create', 'inspect', 'restoreDump', 'readHistory', 'applyOnly255',
    'quarantineAttempt'].every(name => typeof isolation[name] === 'function'), 'HOST_PORTS_MISSING')
  const clock = now()
  check(clock instanceof Date && Number.isFinite(clock.getTime()), 'CLOCK_INVALID')
  reviewBridge255BackupSource({ plan, signedSourcePlan, manifest, attestation,
    backupPath, publicPem, keyId, now: clock })
  verifyExpectedRows(expectedRows, plan, migration255)
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  check(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519'
    && createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
      .equals(publicKey.export({ type: 'spki', format: 'der' })), 'SIGNING_KEY_MISMATCH')
  let attempted = false
  try {
    attempted = true
    await isolation.create({ attemptId: plan.attempt_id, imageRef: plan.pg17_image_ref,
      preserveVolume: true, internalNetwork: true, publishPorts: false })
    let state = await isolation.inspect(plan.attempt_id)
    verifyIsolation(state, plan, attestation.source_database_id_sha256)
    await isolation.restoreDump({ attemptId: plan.attempt_id, backupPath,
      backupSha256: attestation.backup_sha256, readOnlySource: true })
    state = await isolation.inspect(plan.attempt_id)
    verifyIsolation(state, plan, attestation.source_database_id_sha256)
    verifyRows(await isolation.readHistory(plan.attempt_id), expectedRows.slice(0, 254),
      254, plan.database.prefix_254_sha256)
    await isolation.applyOnly255({ attemptId: plan.attempt_id, sql: migration255.sql,
      sqlSha256: sha(migration255.sql), expectedBefore: plan.database.prefix_254_sha256 })
    state = await isolation.inspect(plan.attempt_id)
    verifyIsolation(state, plan, attestation.source_database_id_sha256)
    verifyRows(await isolation.readHistory(plan.attempt_id), expectedRows,
      255, plan.database.prefix_255_sha256)
    const completed = now()
    check(completed instanceof Date && Number.isFinite(completed.getTime())
      && completed.getTime() >= clock.getTime()
      && completed.getTime() < Date.parse(attestation.expires_at), 'CAPTURE_TIME_INVALID')
    const report = { schema_version: 'ecs-bridge-255-pg17-restore/1', status: 'pass',
      simulated: false, attempt_id: plan.attempt_id,
      plan_sha256: reviewBridge255BackupSource({ plan, signedSourcePlan, manifest,
        attestation, backupPath, publicPem, keyId, now: completed }).plan_sha256,
      backup_sha256: attestation.backup_sha256,
      source_database_id_sha256: attestation.source_database_id_sha256,
      source_prefix_254_sha256: plan.database.prefix_254_sha256,
      migrated_prefix_255_sha256: plan.database.prefix_255_sha256,
      restored_prefix_version: 254, migrated_version: 255,
      postgres_image_ref: plan.pg17_image_ref, postgres_image_id: state.image_id,
      container_id: state.container_id,
      network_id: state.network_id, network_internal: true, published_ports: [],
      volume_name: state.volume_name,
      target_database_id_sha256: state.database_id_sha256,
      migration_255_sql_sha256: expectedRows[254].checksum,
      recovery_image_set_digest: plan.recovery_255.identity.image_set_digest,
      captured_at: completed.toISOString(),
      expires_at: new Date(Math.min(completed.getTime() + 86_400_000,
        Date.parse(attestation.expires_at))).toISOString(), key_id: keyId }
    const restore = { ...report,
      signature_base64: sign(null, Buffer.from(canonical(report)), privateKey).toString('base64') }
    reviewBridge255HostHandoff({ plan, signedSourcePlan, manifest, attestation,
      restore, backupPath, publicPem, keyId, now: completed })
    return Object.freeze({ status: 'isolated_restore_signed', restore,
      production_authorized: false, deployable: false })
  } catch (error) {
    if (attempted) {
      try { await isolation.quarantineAttempt({ attemptId: plan.attempt_id,
        preserveVolume: true, keepInternal: true }) }
      catch (quarantineError) { throw new AggregateError([error, quarantineError],
        'isolated restore failed and quarantine requires incident recovery') }
    }
    throw error
  }
}
