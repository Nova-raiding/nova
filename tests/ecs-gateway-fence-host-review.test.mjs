import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { reviewGatewayFenceCrash, reviewGatewayFenceHostInstall } from '../infra/protected/ecs-gateway-fence-host-review.mjs'

const sha = x => createHash('sha256').update(x).digest('hex')
const id = 'a'.repeat(64), image = `sha256:${'b'.repeat(64)}`
const source = 'exact running nginx config'
const manifest = () => ({ schema_version: 'ecs-gateway-fence-host-review/1', mode: 'review_only',
  production_mutation_enabled: false, lock_path: '/var/lock/merchant/ecs-compose-mutation.lock',
  journal_dir: '/var/lib/merchant-release-security/gateway-fence',
  controller_path: '/usr/local/libexec/merchant/gateway-fence',
  watchdog_path: '/usr/local/libexec/merchant/gateway-fence-watchdog',
  controller_sha256: 'c'.repeat(64), watchdog_sha256: 'd'.repeat(64) })
const capsule = () => ({ gateway_id: id, image_id: image, config_sha256: sha(source),
  effective_config_sha256: 'e'.repeat(64), network_id: 'f'.repeat(64) })
const callbacks = () => ({ gateway_id: id, exact_paths: ['/v1/billing/callback/alipay'] })
const regular = (mode, digest) => ({ uid: 0, mode, type: 'file', symlink: false, nlink: 1,
  ...(digest ? { sha256: digest } : {}) })
const host = () => ({
  verifySigned: () => true,
  observeLock: () => ({ ...regular(0o600), path: '/var/lock/merchant/ecs-compose-mutation.lock',
    dev: 1, ino: 2, fd9_dev: 1, fd9_ino: 2, flock_owner_pid: 123, invocation_pid: 123 }),
  observeInstalledPaths: () => ({ controller: regular(0o500, 'c'.repeat(64)),
    watchdog: regular(0o500, 'd'.repeat(64)),
    journal_dir: { uid: 0, mode: 0o700, type: 'directory', symlink: false } }),
  observeGateway: () => ({ id, image_id: image, running: true, host_ports: [80, 443],
    compose_project: 'merchant-demo-85575f9c', compose_service: 'pilot-gateway', network_id: 'f'.repeat(64) }),
  readGatewayConfig: () => source,
  observeEffectiveNginx: () => ({ sha256: 'e'.repeat(64), real_ip_disabled: true, healthcheck_exact: true }),
  observeWatchdog: () => ({ installed: true, root_owned: true, interval_seconds: 5,
    exec_sha256: 'd'.repeat(64), production_mutation_enabled: false }),
})

test('complete isolated host evidence is reviewable but cannot install or mutate', () => {
  assert.deepEqual(reviewGatewayFenceHostInstall({ manifest: manifest(), capsule: capsule(),
    callbacks: callbacks() }, host()), { review_only_ready: true, installation_allowed: false,
    production_mutation_allowed: false, reasons: [] })
})

test('missing signature, lock ownership, and watchdog fail closed', () => {
  const h = host()
  h.verifySigned = () => false
  h.observeLock = () => ({ ...host().observeLock(), fd9_ino: 9 })
  h.observeWatchdog = () => ({ installed: false })
  const result = reviewGatewayFenceHostInstall({ manifest: manifest(), capsule: capsule(),
    callbacks: callbacks() }, h)
  assert.ok(result.reasons.includes('CAPSULE_UNVERIFIED'))
  assert.ok(result.reasons.includes('PROTECTED_LOCK_NOT_HELD'))
  assert.ok(result.reasons.includes('WATCHDOG_NOT_INSTALLED'))
  assert.equal(result.production_mutation_allowed, false)
})

const journal = () => ({ schema_version: 'ecs-gateway-fence-journal/1', phase: 'fenced',
  gateway_id: id, baseline_sha256: '1'.repeat(64), fenced_sha256: '2'.repeat(64),
  capsule_sha256: '3'.repeat(64), callback_policy_sha256: '4'.repeat(64) })
const observation = () => ({ gateway_id: id, running: true, host_ports: [80, 443],
  config_sha256: '2'.repeat(64), db_prefix: 242, old_runtime_intact: true,
  callbacks_reached_api: true })

test('pre-mutation crash recommends guarded rollback but never authorizes it', () => {
  assert.deepEqual(reviewGatewayFenceCrash(journal(), observation(), () => true), {
    recommendation: 'restore_baseline_under_lock_then_probe', production_mutation_allowed: false, reasons: [] })
})

test('post-migration crash keeps ingress fenced for forward recovery', () => {
  const j = journal(); j.phase = 'bridge_mutation_started'
  assert.equal(reviewGatewayFenceCrash(j, observation(), () => true).recommendation,
    'keep_fenced_for_forward_recovery')
  const o = observation(); o.db_prefix = 243
  assert.equal(reviewGatewayFenceCrash(journal(), o, () => true).recommendation,
    'keep_fenced_for_forward_recovery')
  o.config_sha256 = '1'.repeat(64)
  assert.ok(reviewGatewayFenceCrash(journal(), o, () => true).reasons.includes('INGRESS_OPEN_DURING_MUTATION'))
})

test('unsigned, drifted, or incomplete recovery evidence holds and pages', () => {
  assert.equal(reviewGatewayFenceCrash(journal(), observation(), () => false).recommendation, 'hold_and_page')
  const o = observation(); o.config_sha256 = '9'.repeat(64)
  assert.ok(reviewGatewayFenceCrash(journal(), o, () => true).reasons.includes('CONFIG_STATE_UNKNOWN'))
  const q = observation(); q.old_runtime_intact = false
  assert.ok(reviewGatewayFenceCrash(journal(), q, () => true).reasons.includes('BASELINE_RESTORE_PRECONDITIONS_MISSING'))
  const j = journal(); j.phase = 'captured'
  assert.ok(reviewGatewayFenceCrash(j, observation(), () => true).reasons.includes('JOURNAL_CONFIG_PHASE_MISMATCH'))
})
