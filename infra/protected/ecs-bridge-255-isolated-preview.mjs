// Signed isolated PG17 preview evidence. Its source can be the current 254
// public release; it never labels that release as a 254/255 runtime bridge.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { reviewDemo254BackupForPreview } from './ecs-bridge-255-host-handoff.mjs'

const HEX = /^[a-f0-9]{64}$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const ATTEMPT = /^[A-Za-z0-9_-]{16,128}$/u
const fail = reason => { throw new Error(`BRIDGE_255_PREVIEW_${reason}`) }
const check = (ok, reason) => { if (!ok) fail(reason) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).filter(key => key !== 'signature_base64').sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const historyHash = rows => sha(rows.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))
const rows255 = (source, sql) => [...source.candidate_migrations,
  { version: 255, name: 'scoped_brand_settings', checksum: sha(sql) }]

function verifyPlanShape(plan, now) {
  const keys = ['schema_version', 'purpose', 'attempt_id', 'source_release_id', 'source_git_sha',
    'source_plan_sha256', 'backup_sha256', 'attestation_sha256', 'capture_manifest_sha256',
    'prefix_254_sha256', 'prefix_255_sha256', 'migration_255_sql_sha256',
    'pg17_image_id', 'created_at', 'expires_at', 'production_deploy_authorized',
    'key_id', 'signature_base64']
  check(plan && Object.keys(plan).sort().join(',') === keys.sort().join(',')
    && plan.schema_version === 'ecs-bridge-255-isolated-preview-plan/1'
    && plan.purpose === 'isolated_preview' && plan.production_deploy_authorized === false
    && ATTEMPT.test(plan.attempt_id ?? '')
    && /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(plan.source_release_id ?? '')
    && /^[a-f0-9]{40}$/u.test(plan.source_git_sha ?? '')
    && ['source_plan_sha256', 'backup_sha256', 'attestation_sha256',
      'capture_manifest_sha256', 'prefix_254_sha256', 'prefix_255_sha256',
      'migration_255_sql_sha256'].every(key => HEX.test(plan[key] ?? ''))
    && IMAGE.test(plan.pg17_image_id ?? '')
    && typeof plan.key_id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(plan.key_id)
    && Number.isFinite(Date.parse(plan.created_at))
    && Number.isFinite(Date.parse(plan.expires_at))
    && plan.created_at === new Date(plan.created_at).toISOString()
    && plan.expires_at === new Date(plan.expires_at).toISOString()
    && Date.parse(plan.created_at) <= now.getTime() + 300_000
    && Date.parse(plan.expires_at) > now.getTime()
    && Date.parse(plan.expires_at) <= Date.parse(plan.created_at) + 86_400_000,
  'PLAN_SHAPE_OR_TIME_INVALID')
}

export function createSignedBridge255PreviewPlan({ attemptId, signedSourcePlan, manifest,
  attestation, backupPath, migration255Sql, pg17ImageId, publicPem, privatePem,
  keyId, now = new Date() }) {
  const source = reviewDemo254BackupForPreview({ signedSourcePlan, manifest, attestation,
    backupPath, publicPem, keyId, now })
  check(ATTEMPT.test(attemptId ?? '') && IMAGE.test(pg17ImageId ?? '')
    && Buffer.isBuffer(migration255Sql) && migration255Sql.length > 0
    && migration255Sql.length <= 4 * 1024 * 1024
    && Array.isArray(source.candidate_migrations)
    && source.candidate_migrations.length === 254,
  'PREVIEW_INPUT_INVALID')
  const privateKey = createPrivateKey(privatePem), publicKey = createPublicKey(publicPem)
  check(privateKey.asymmetricKeyType === 'ed25519' && publicKey.asymmetricKeyType === 'ed25519'
    && createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
      .equals(publicKey.export({ type: 'spki', format: 'der' })), 'KEY_PAIR_MISMATCH')
  const expires = Math.min(now.getTime() + 86_400_000, Date.parse(attestation.expires_at))
  check(expires > now.getTime(), 'BACKUP_EXPIRED')
  const plan = { schema_version: 'ecs-bridge-255-isolated-preview-plan/1',
    purpose: 'isolated_preview', attempt_id: attemptId,
    source_release_id: source.release_id, source_git_sha: source.git_sha,
    source_plan_sha256: sha(canonical(signedSourcePlan)),
    backup_sha256: attestation.backup_sha256,
    attestation_sha256: sha(JSON.stringify(attestation)),
    capture_manifest_sha256: sha(JSON.stringify(manifest)),
    prefix_254_sha256: source.history_sha256,
    prefix_255_sha256: historyHash(rows255(source, migration255Sql)),
    migration_255_sql_sha256: sha(migration255Sql), pg17_image_id: pg17ImageId,
    created_at: now.toISOString(), expires_at: new Date(expires).toISOString(),
    production_deploy_authorized: false, key_id: keyId }
  const signed = { ...plan,
    signature_base64: sign(null, Buffer.from(canonical(plan)), privateKey).toString('base64') }
  verifySignedBridge255PreviewPlan(signed, publicPem, keyId, now)
  return signed
}

export function verifySignedBridge255PreviewPlan(plan, publicPem, keyId, now = new Date()) {
  verifyPlanShape(plan, now)
  check(plan.key_id === keyId, 'PLAN_KEY_ID_INVALID')
  let valid = false
  try {
    const key = createPublicKey(publicPem), bytes = Buffer.from(plan.signature_base64, 'base64')
    valid = key.asymmetricKeyType === 'ed25519' && bytes.length === 64
      && bytes.toString('base64') === plan.signature_base64
      && verify(null, Buffer.from(canonical(plan)), key, bytes)
  } catch { /* reject invalid signing material */ }
  check(valid, 'PLAN_SIGNATURE_INVALID')
  return Object.freeze({ plan_sha256: sha(canonical(plan)), production_deploy_authorized: false })
}

/** Only the isolated Docker ports are available to this operation. */
export async function runSignedBridge255Preview({ plan, signedSourcePlan, manifest,
  attestation, backupPath, migration255Sql, publicPem, privatePem, keyId,
  now = () => new Date() }, isolation) {
  check(isolation && ['create', 'inspect', 'restoreDump', 'readHistory', 'applyOnly255',
    'quarantineAttempt'].every(name => typeof isolation[name] === 'function'), 'HOST_PORTS_MISSING')
  const started = now()
  verifySignedBridge255PreviewPlan(plan, publicPem, keyId, started)
  const source = reviewDemo254BackupForPreview({ signedSourcePlan, manifest, attestation,
    backupPath, publicPem, keyId, now: started })
  const rows = rows255(source, migration255Sql)
  check(plan.source_release_id === source.release_id && plan.source_git_sha === source.git_sha
    && plan.source_plan_sha256 === sha(canonical(signedSourcePlan))
    && plan.backup_sha256 === attestation.backup_sha256
    && plan.attestation_sha256 === sha(JSON.stringify(attestation))
    && plan.capture_manifest_sha256 === sha(JSON.stringify(manifest))
    && plan.prefix_254_sha256 === source.history_sha256
    && plan.prefix_255_sha256 === historyHash(rows)
    && plan.migration_255_sql_sha256 === sha(migration255Sql), 'PLAN_SOURCE_DRIFT')
  const privateKey = createPrivateKey(privatePem)
  check(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    .equals(createPublicKey(publicPem).export({ type: 'spki', format: 'der' })),
  'SIGNING_KEY_MISMATCH')
  let attempted = false
  try {
    attempted = true
    await isolation.create({ attemptId: plan.attempt_id, imageRef: plan.pg17_image_id,
      preserveVolume: true, internalNetwork: true, publishPorts: false })
    const observe = async () => {
      const state = await isolation.inspect(plan.attempt_id)
      check(state?.image_id === plan.pg17_image_id
        && state.network_internal === true && state.source_mounted === false
        && Array.isArray(state.published_ports) && state.published_ports.length === 0
        && state.volume_preserved === true && HEX.test(state.container_id ?? '')
        && HEX.test(state.network_id ?? '') && HEX.test(state.database_id_sha256 ?? '')
        && state.database_id_sha256 !== source.source_database_id_sha256,
      'ISOLATION_LOST')
      return state
    }
    await observe()
    await isolation.restoreDump({ attemptId: plan.attempt_id, backupPath,
      backupSha256: source.backup_sha256, readOnlySource: true })
    await observe()
    check(historyHash(await isolation.readHistory(plan.attempt_id)) === plan.prefix_254_sha256,
      'RESTORED_254_HISTORY_INVALID')
    await isolation.applyOnly255({ attemptId: plan.attempt_id, sql: migration255Sql,
      name: 'scoped_brand_settings', sqlSha256: plan.migration_255_sql_sha256,
      expectedBefore: plan.prefix_254_sha256 })
    const state = await observe()
    check(historyHash(await isolation.readHistory(plan.attempt_id)) === plan.prefix_255_sha256,
      'MIGRATED_255_HISTORY_INVALID')
    const finished = now()
    check(finished instanceof Date && finished.getTime() >= started.getTime()
      && finished.getTime() < Date.parse(plan.expires_at), 'PREVIEW_EXPIRED')
    reviewDemo254BackupForPreview({ signedSourcePlan, manifest, attestation,
      backupPath, publicPem, keyId, now: finished })
    const report = { schema_version: 'ecs-bridge-255-isolated-preview-result/1',
      status: 'pass', simulated: false, purpose: 'isolated_preview',
      plan_sha256: sha(canonical(plan)), attempt_id: plan.attempt_id,
      backup_sha256: plan.backup_sha256,
      restored_prefix_254_sha256: plan.prefix_254_sha256,
      migrated_prefix_255_sha256: plan.prefix_255_sha256,
      pg17_image_id: state.image_id, network_id: state.network_id,
      container_id: state.container_id, volume_name: state.volume_name,
      target_database_id_sha256: state.database_id_sha256,
      captured_at: finished.toISOString(), production_deploy_authorized: false,
      key_id: keyId }
    return { ...report,
      signature_base64: sign(null, Buffer.from(canonical(report)), privateKey).toString('base64') }
  } catch (error) {
    if (attempted) {
      try { await isolation.quarantineAttempt({ attemptId: plan.attempt_id,
        preserveVolume: true, keepInternal: true }) }
      catch (quarantineError) { throw new AggregateError([error, quarantineError],
        'isolated preview failed and quarantine requires incident recovery') }
    }
    throw error
  }
}
