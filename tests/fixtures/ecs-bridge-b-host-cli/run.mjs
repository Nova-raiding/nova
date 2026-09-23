import assert from 'node:assert/strict'
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { verifyBridgeBJournal } from '/infra/protected/ecs-bridge-b-transition.mjs'
import { DatabaseSync } from 'node:sqlite'

const attempt = 'attempt_BridgeB_abcdefghijkl'
const nonce = 'nonce_BridgeB_abcdefghijklmnopqrstuvwxyz'
const statePath = id => `/var/lib/merchant-release-security/bridge-b/${id}.json`
const helper = '/usr/local/libexec/merchant/ecs-bridge-b-transition'
const sha = value => createHash('sha256').update(value).digest('hex')
function args(command, id = attempt, changes = {}) {
  const values = {
    '--state': statePath(id), '--lock-path': '/state/lock', '--compose-project': 'merchant-production', '--production-api-base-url': 'https://yxsona.com',
    '--attempt-id': id, '--deployment-nonce': nonce, '--service-map': '/state/service-map.json',
    '--bridge-release-id': 'bridge-release-242', '--bridge-git-sha': 'd'.repeat(40), '--bridge-manifest-sha256': 'e'.repeat(64), '--bridge-image-set-digest': `sha256:${'f'.repeat(64)}`,
    '--bridge-compose': '/state/bridge-compose.json', '--bridge-env': '/state/bridge-env', '--bridge-image-digests': '/state/bridge-digests.json',
    '--recovery-plan': '/state/recovery-plan.json', '--recovery-compose': '/state/old-compose.json', '--recovery-env': '/state/old-env', '--recovery-image-digests': '/state/old-digests.json', '--wait-timeout': '30',
    ...changes,
  }
  return [command, ...Object.entries(values).filter(([key]) => ({ capture: ['--state','--lock-path','--compose-project','--production-api-base-url','--attempt-id','--deployment-nonce','--service-map','--bridge-release-id','--bridge-git-sha','--bridge-manifest-sha256','--bridge-image-set-digest','--bridge-compose','--bridge-env','--bridge-image-digests','--recovery-plan','--recovery-compose','--recovery-env','--recovery-image-digests'], install: ['--state','--lock-path','--compose-project','--production-api-base-url','--deployment-nonce','--service-map','--bridge-compose','--bridge-env','--bridge-image-digests','--recovery-plan','--recovery-compose','--recovery-env','--recovery-image-digests','--wait-timeout'], recover: ['--state','--lock-path','--compose-project','--production-api-base-url','--deployment-nonce','--recovery-plan','--recovery-compose','--recovery-env','--recovery-image-digests','--wait-timeout'] }[command]).includes(key)).flatMap(([key,value]) => [key,value])]
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
function run(command, id = attempt, changes = {}, lockFd = '/state/lock') {
  const argv = args(command, id, changes).map(quote).join(' ')
  const runtimeUrl = changes.__runtimeUrl ?? 'postgres://merchant_app:secret@db/merchant?sslmode=require'
  const opsUrl = changes.__opsUrl ?? 'postgres://merchant_ops:secret@db/merchant_ops?sslmode=require'
  const script = `exec 9>${quote(lockFd)}; /usr/bin/flock -n 9 || exit $?; export DATABASE_URL=${quote(runtimeUrl)} OPS_DATABASE_URL=${quote(opsUrl)}; exec /usr/local/bin/node ${quote(helper)} ${argv}`
  return spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
}
function pass(command, id = attempt, changes = {}) {
  const result = run(command, id, changes)
  let state = ''
  try { state = `\njournal=${readFileSync(statePath(id), 'utf8')}` } catch {}
  const ledger = new DatabaseSync('/var/lib/merchant-release-security/production-nonces.sqlite3').prepare('select count(*) as n from consumed_nonces').get().n
  const log = path => { try { return readFileSync(path, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return '(no calls recorded)' ; throw error } }
  const calls = `\nledger=${ledger}\ndocker=${log('/state/docker-calls.jsonl')}\npsql=${log('/state/psql-calls.jsonl')}`
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}\n${result.stdout}${state}${calls}`)
  return result.stdout
}
function reject(command, expected, id = attempt, changes = {}, lockFd = '/state/lock') {
  const result = run(command, id, changes, lockFd)
  assert.notEqual(result.status, 0, `${command} unexpectedly succeeded`)
  assert.match(result.stderr, expected)
  return result
}
function journal(id = attempt) { return JSON.parse(readFileSync(statePath(id), 'utf8')) }
function dbHistorySha() { return sha(JSON.stringify(JSON.parse(readFileSync('/state/history.json', 'utf8')))) }
function dockerCalls() { const value = (() => { try { return readFileSync('/state/docker-calls.jsonl','utf8') } catch (error) { if (error?.code === 'ENOENT') return '' ; throw error } })(); return value.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }

// Supplying the runtime credential for both pools must not masquerade as
// independent merchant_app/merchant_ops migration evidence.
const sameRoleAttempt = 'attempt_same_db_role_abcdefgh'
const sameRoleUrl = 'postgres://merchant_app:secret@db/merchant?sslmode=require'
const sameRole = reject('capture', /database URL must authenticate as merchant_ops/u, sameRoleAttempt, { __runtimeUrl: sameRoleUrl, __opsUrl: sameRoleUrl })
assert.equal(existsSync(statePath(sameRoleAttempt)), false)
assert.match(sameRole.stderr, /database URL must authenticate as merchant_ops/u)
const insecureUrlAttempt = 'attempt_insecure_db_url_abcdefgh'
const insecureUrl = reject('capture', /database URL must require TLS/u, insecureUrlAttempt, { __runtimeUrl: 'postgres://merchant_app:secret@db/merchant' })
assert.equal(existsSync(statePath(insecureUrlAttempt)), false)
assert.match(insecureUrl.stderr, /database URL must require TLS/u)

assert.match(pass('capture'), /signed baseline captured at migration 242/u)
const captured = journal()
assert.equal(verifyBridgeBJournal(captured, readFileSync('/run/release-security/evidence-trust/production-evidence-public.pem','utf8')), true, 'captured journal signature should verify in fixture process')
assert.equal(captured.phase, 'captured')
assert.equal(captured.database_before.migration_version, 242)
assert.equal(captured.database_before.migration_history_sha256, dbHistorySha())
assert.equal(captured.bridge.release_id, 'bridge-release-242')
assert.equal(captured.bridge.manifest_sha256, 'e'.repeat(64))
assert.deepEqual(captured.baseline.services.map(item => item.service), ['api', 'api-replica'])
assert.deepEqual(captured.baseline.inventory.map(item => item.name), ['merchant-api-1', 'merchant-api-replica-1'])
assert.deepEqual(captured.baseline.inventory.map(item => item.compose_service), ['api', 'api-replica'])

// A genuinely signed legacy v1 journal has no compose_service baseline field.
// It must be rejected during journal verification before recovery can mutate.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
const legacyJournalAttempt = 'attempt_legacy_v1_abcdefgh'
const legacyJournal = { ...captured, schema_version: 'ecs-bridge-b-transition/1' }
legacyJournal.signature_base64 = sign(null, Buffer.from(canonical(legacyJournal)), createPrivateKey(readFileSync('/var/lib/merchant-release-security/production-capability-private.pem'))).toString('base64')
writeFileSync(statePath(legacyJournalAttempt), `${JSON.stringify(legacyJournal)}\n`, { mode: 0o400 })
const dockerBeforeLegacyJournal = dockerCalls().length
const psqlBeforeLegacyJournal = readFileSync('/state/psql-calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).length
reject('recover', /Bridge B journal signature is invalid/u, legacyJournalAttempt)
assert.equal(dockerCalls().length, dockerBeforeLegacyJournal)
assert.equal(readFileSync('/state/psql-calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).length, psqlBeforeLegacyJournal)

// The name and project can remain plausible while the Compose service label
// proves the reviewed API mapping is stale. Capture must fail before signing.
const wrongServiceAttempt = 'attempt_wrong_service_abcdefgh'
const nonceLedgerBeforeWrongService = new DatabaseSync('/var/lib/merchant-release-security/production-nonces.sqlite3')
const nonceCountBeforeWrongService = nonceLedgerBeforeWrongService.prepare('SELECT count(*) AS count FROM consumed_nonces').get().count
nonceLedgerBeforeWrongService.close()
const consumerCallsBeforeWrongService = existsSync('/state/nonce-calls.jsonl') ? readFileSync('/state/nonce-calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).length : 0
writeFileSync('/state/wrong-service-label', 'yes\n')
const wrongService = reject('capture', /Compose service label does not match the reviewed service map: api/u, wrongServiceAttempt)
assert.equal(existsSync(statePath(wrongServiceAttempt)), false)
const nonceLedgerAfterWrongService = new DatabaseSync('/var/lib/merchant-release-security/production-nonces.sqlite3')
assert.equal(nonceLedgerAfterWrongService.prepare('SELECT count(*) AS count FROM consumed_nonces').get().count, nonceCountBeforeWrongService)
nonceLedgerAfterWrongService.close()
const consumerCallsAfterWrongService = existsSync('/state/nonce-calls.jsonl') ? readFileSync('/state/nonce-calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).length : 0
assert.equal(consumerCallsAfterWrongService, consumerCallsBeforeWrongService)
rmSync('/state/wrong-service-label')

// Every running API/worker service must be in the reviewed map; a valid api
// entry alone cannot leave the replica on the previous release.
const completeServiceMap = readFileSync('/state/service-map.json', 'utf8')
writeFileSync('/state/service-map.json', '[{"service":"api","container":"merchant-api-1"}]\n')
const omittedReplicaAttempt = 'attempt_omitted_replica_abcdefgh'
const omittedReplica = reject('capture', /service map omits running Bridge B runtime service: api-replica/u, omittedReplicaAttempt)
assert.match(omittedReplica.stderr, /service map omits running Bridge B runtime service: api-replica/u)
writeFileSync('/state/service-map.json', completeServiceMap)

// A mislabeled replica must also fail when the reviewed map still includes it.
const badReplicaLabelAttempt = 'attempt_bad_replica_label_abcdefgh'
writeFileSync('/state/replica-service-label-wrong', 'yes\n')
const badReplicaLabel = reject('capture', /baseline container Compose service label does not match the reviewed service map: api-replica/u, badReplicaLabelAttempt)
assert.equal(existsSync(statePath(badReplicaLabelAttempt)), false)
assert.match(badReplicaLabel.stderr, /baseline container Compose service label does not match the reviewed service map: api-replica/u)
rmSync('/state/replica-service-label-wrong')

// Even if both the map and recovery capsule omit a runtime service, the
// rendered frozen Compose is the independent source of the expected set.
const omittedComposeReplicaAttempt = 'attempt_omitted_compose_replica_abcd'
const originalPlan = readFileSync('/state/recovery-plan.json', 'utf8')
writeFileSync('/state/service-map.json', '[{"service":"api","container":"merchant-api-1"}]\n')
const incompletePlan = JSON.parse(originalPlan)
incompletePlan.target.services = ['api']
writeFileSync('/state/recovery-plan.json', `${JSON.stringify(incompletePlan)}\n`)
const omittedComposeReplica = reject('capture', /frozen old-runtime Compose runtime services must match the signed service list/u, omittedComposeReplicaAttempt)
assert.equal(existsSync(statePath(omittedComposeReplicaAttempt)), false)
assert.match(omittedComposeReplica.stderr, /frozen old-runtime Compose runtime services must match the signed service list/u)
writeFileSync('/state/service-map.json', completeServiceMap)
writeFileSync('/state/recovery-plan.json', originalPlan)

// Every selected migration-capable API process must explicitly disable
// startup migrations. Capture rejects a replica with the setting missing or
// enabled before consuming the shared nonce or issuing Compose up.
for (const [label, value] of [['missing', undefined], ['enabled', 'true']]) {
  const invalidComposePath = `/state/bridge-replica-${label}.json`
  const invalidDigestPath = `/state/bridge-replica-${label}-digests.json`
  const invalidCompose = JSON.parse(readFileSync('/state/bridge-compose.json', 'utf8'))
  if (value === undefined) delete invalidCompose.services['api-replica'].environment.RUN_MIGRATIONS_ON_STARTUP
  else invalidCompose.services['api-replica'].environment.RUN_MIGRATIONS_ON_STARTUP = value
  writeFileSync(invalidComposePath, JSON.stringify(invalidCompose), { mode: 0o600 })
  writeFileSync(invalidDigestPath, readFileSync('/state/bridge-digests.json'), { mode: 0o600 })
  const invalidAttempt = `attempt_replica_${label}_abcdefghijkl`
  const ledger = new DatabaseSync('/var/lib/merchant-release-security/production-nonces.sqlite3')
  const nonceCountBefore = ledger.prepare('SELECT count(*) AS count FROM consumed_nonces').get().count
  ledger.close()
  const composeUpCountBefore = dockerCalls().filter(call => call[0] === 'compose' && call.includes('up')).length
  const invalid = reject('capture', /api-replica must explicitly disable startup migrations/u, invalidAttempt, {
    '--bridge-compose': invalidComposePath, '--bridge-image-digests': invalidDigestPath,
  })
  assert.match(invalid.stderr, /api-replica must explicitly disable startup migrations/u)
  assert.equal(existsSync(statePath(invalidAttempt)), false)
  const afterLedger = new DatabaseSync('/var/lib/merchant-release-security/production-nonces.sqlite3')
  assert.equal(afterLedger.prepare('SELECT count(*) AS count FROM consumed_nonces').get().count, nonceCountBefore)
  afterLedger.close()
  assert.equal(dockerCalls().filter(call => call[0] === 'compose' && call.includes('up')).length, composeUpCountBefore)
}

// FD 9 must name the canonical protected lock inode. No psql/Docker calls may happen first.
const dockerBeforeLockMismatch = dockerCalls().length
const psqlBeforeLockMismatch = readFileSync('/state/psql-calls.jsonl','utf8').trim().split('\n').length
reject('install', /FD 9 does not match/u, attempt, {}, '/state/wrong-lock')
assert.equal(dockerCalls().length, dockerBeforeLockMismatch)
assert.equal(readFileSync('/state/psql-calls.jsonl','utf8').trim().split('\n').length, psqlBeforeLockMismatch)

// Wrong nonce is rejected before any nonce consumption or Docker mutation.
const badNonce = reject('install', /nonce mismatch/u, attempt, { '--deployment-nonce': 'nonce_wrong_abcdefghijklmnopqrstuvwxyz' })
assert.match(badNonce.stderr, /deployment nonce mismatch/u)
assert.equal(journal().phase, 'captured')

// A nonce consumed by the ordinary deployment operation cannot be reclaimed
// by Bridge B even when every release identity field is identical. Omitted
// operation flags retain the historical deployment consumer behavior.
const deploymentOwnedNonce = 'nonce_deploymentOwned_abcdefghijklmnopqrstuvwxyz'
const bridgeIdentity = JSON.parse(readFileSync('/state/bridge-identity.json', 'utf8'))
const nonceConsumer = '/usr/local/libexec/merchant/consume-production-evidence-nonce'
const deploymentConsume = spawnSync('/usr/local/bin/node', [nonceConsumer, 'consume', '--namespace', 'merchant-production-deploy', '--nonce', deploymentOwnedNonce, '--release-id', bridgeIdentity.release_id, '--image-digest', bridgeIdentity.image_set_digest, '--manifest-sha256', bridgeIdentity.manifest_sha256, '--release-git-sha', bridgeIdentity.release_git_sha], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
assert.equal(deploymentConsume.status, 0, `legacy deployment nonce consumer invocation failed: status=${deploymentConsume.status} signal=${deploymentConsume.signal} error=${deploymentConsume.error?.message} stderr=${deploymentConsume.stderr}`)
const deploymentOwnerAttempt = 'attempt_deployment_owner_abcdefgh'
assert.match(pass('capture', deploymentOwnerAttempt, { '--deployment-nonce': deploymentOwnedNonce }), /signed baseline captured/u)
const callsBeforeOwnerReject = dockerCalls().filter(call => call[0] === 'compose' && call.includes('up')).length
const consumerCallsBeforeOwnerReject = readFileSync('/state/nonce-calls.jsonl', 'utf8').trim().split('\n').length
const ownerReject = reject('install', /different operation or attempt/u, deploymentOwnerAttempt, { '--deployment-nonce': deploymentOwnedNonce })
assert.match(ownerReject.stderr, /different operation or attempt/u)
assert.equal(journal(deploymentOwnerAttempt).phase, 'captured')
assert.equal(dockerCalls().filter(call => call[0] === 'compose' && call.includes('up')).length, callsBeforeOwnerReject)
assert.equal(readFileSync('/state/nonce-calls.jsonl', 'utf8').trim().split('\n').length, consumerCallsBeforeOwnerReject)

// Simulate process loss after the shared one-use ledger commits but before
// the signed journal phase update. Same-attempt retry must resume without
// consuming the nonce twice or issuing a runtime mutation on the failed call.
writeFileSync('/state/fail-nonce-after-commit', 'yes\n')
const dockerBeforeInterruptedInstall = dockerCalls().length
const interrupted = reject('install', /shared one-use production nonce consumer rejected/u)
assert.match(interrupted.stderr, /simulated process loss after nonce ledger commit/u)
assert.equal(journal().phase, 'captured')
assert.equal(dockerCalls().length > dockerBeforeInterruptedInstall && dockerCalls().slice(dockerBeforeInterruptedInstall).some(call => call[0] === 'compose' && call.includes('up')), false, 'interrupted nonce commit must not start Docker Compose mutation')
rmSync('/state/fail-nonce-after-commit')
assert.match(pass('install'), /runtime verified; database remains at migration 242/u)
assert.equal(journal().phase, 'bridge_runtime_verified')
assert.equal(JSON.parse(readFileSync('/state/runtime.json','utf8')).runtime, 'bridge')
const callsAfterInstall = dockerCalls()
assert(callsAfterInstall.some(call => call.includes('up')))
assert(!callsAfterInstall.some(call => call.includes('migrate')))
const psqlLog = readFileSync('/state/psql-calls.jsonl','utf8')
assert(!psqlLog.includes('migrate'))
assert.equal(journal().database_before.migration_history_sha256, dbHistorySha())

// A distinct attempt reuses the accepted nonce: the actual SQLite consumer must reject it.
const runtime = JSON.parse(readFileSync('/state/runtime.json','utf8'))
writeFileSync('/state/runtime.json', JSON.stringify({ ...runtime, runtime: 'old', apiId: 'a'.repeat(64), replicaId: 'c'.repeat(64) }))
const replayAttempt = 'attempt_BridgeB_replay_abcdefgh'
assert.match(pass('capture', replayAttempt), /signed baseline captured/u)
const callsBeforeReplay = dockerCalls().length
const replay = reject('install', /different operation or attempt/u, replayAttempt)
assert.equal(journal(replayAttempt).phase, 'captured')
const replayDockerCalls = dockerCalls().slice(callsBeforeReplay)
assert.equal(replayDockerCalls.some(call => call[0] === 'compose' && call.includes('up')), false, `nonce attempt replay must be rejected before Docker Compose mutation: ${JSON.stringify(replayDockerCalls)}`)
assert(!replay.stderr.includes('nonce consumer'), 'same-release replay must be rejected by the attempt binding before the consumer is invoked')

// Reinstall only to continue the happy path, then verify recovery restores exact old identity and DB prefix.
// The first successful install already consumed this nonce, so create a fresh isolated nonce and capture.
const recoverNonce = 'nonce_BridgeB_recovery_abcdefghijklmnopqrstuvwxyz'
const recoveryAttempt = 'attempt_BridgeB_recovery_abcdefgh'
// Restore the simulated Bridge B runtime after the replay test's baseline reset;
// recovery authorization must observe the exact captured candidate identity.
writeFileSync('/state/runtime.json', JSON.stringify({ ...runtime, runtime: 'bridge', apiId: 'b'.repeat(64), replicaId: 'd'.repeat(64) }))
assert.match(pass('recover'), /recovery verified at migration 242/u)
assert.equal(journal().phase, 'recovery_verified')
assert.equal(JSON.parse(readFileSync('/state/runtime.json','utf8')).runtime, 'old')
assert.equal(journal().database_before.migration_history_sha256, dbHistorySha())
assert.equal(readFileSync('/state/psql-calls.jsonl','utf8').trim().split('\n').length > 0, true)

// A crash after api-replica switches but while api remains on its exact
// captured old container must allow mutation-started recovery at 242.
const partialAttempt = 'attempt_partial_recovery_abcdefgh'
const partialNonce = 'nonce_partialBridgeB_abcdefghijklmnopqrstuvwxyz'
assert.match(pass('capture', partialAttempt, { '--deployment-nonce': partialNonce }), /signed baseline captured/u)
writeFileSync('/state/fail-compose-up-partial', 'yes\n')
const partialInstall = reject('install', /runtime-only Compose up failed/u, partialAttempt, { '--deployment-nonce': partialNonce })
assert.match(partialInstall.stderr, /runtime-only Compose up failed/u)
assert.equal(journal(partialAttempt).phase, 'bridge_runtime_mutation_started')
const mixed = JSON.parse(readFileSync('/state/runtime.json', 'utf8'))
assert.equal(mixed.runtime, 'mixed')
assert.equal(mixed.apiRuntime, 'old')
assert.equal(mixed.replicaRuntime, 'bridge')
rmSync('/state/fail-compose-up-partial')
assert.match(pass('recover', partialAttempt, { '--deployment-nonce': partialNonce }), /recovery verified at migration 242/u)
assert.equal(journal(partialAttempt).phase, 'recovery_verified')
assert.equal(JSON.parse(readFileSync('/state/runtime.json', 'utf8')).runtime, 'old')
assert.equal(journal(partialAttempt).database_before.migration_history_sha256, dbHistorySha())

// A legacy database with consumed_nonces but no operation-owner table may
// continue to accept unused nonces (proven by the first install above), but
// Bridge B must not claim an already-consumed legacy nonce.
const legacyLedger = new DatabaseSync('/var/lib/merchant-release-security/production-nonces.sqlite3')
legacyLedger.exec('DROP TABLE nonce_owners')
legacyLedger.close()
const legacyAttempt = 'attempt_legacy_nonce_abcdefghijk'
assert.match(pass('capture', legacyAttempt), /signed baseline captured/u)
const legacyConsumerCalls = readFileSync('/state/nonce-calls.jsonl', 'utf8').trim().split('\n').length
const legacyComposeUps = dockerCalls().filter(call => call[0] === 'compose' && call.includes('up')).length
const legacyReject = reject('install', /legacy consumed nonce has no operation owner/u, legacyAttempt)
assert.match(legacyReject.stderr, /legacy consumed nonce has no operation owner/u)
assert.equal(journal(legacyAttempt).phase, 'captured')
assert.equal(readFileSync('/state/nonce-calls.jsonl', 'utf8').trim().split('\n').length, legacyConsumerCalls)
assert.equal(dockerCalls().filter(call => call[0] === 'compose' && call.includes('up')).length, legacyComposeUps)
console.log('PASS: fixed-path host CLI capture/install/recover; FD9 mismatch; nonce mismatch/replay; signed release and Docker inventory; migration 242 history unchanged; migrate never invoked')
