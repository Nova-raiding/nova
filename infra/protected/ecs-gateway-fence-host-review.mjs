// Host installer and crash recovery contract. Review-only: no write, reload,
// Docker mutation, systemd install, journal creation, or lock acquisition.
import { createHash } from 'node:crypto'

const SHA = /^[a-f0-9]{64}$/u
const ID = /^[a-f0-9]{64}$/u
const LOCK = '/var/lock/merchant/ecs-compose-mutation.lock'
const PREFIX = '/var/lib/merchant-release-security/gateway-fence'
const fail = (reasons, code, ok) => { if (!ok) reasons.push(code) }
const digest = text => createHash('sha256').update(text).digest('hex')
const protectedObject = (x, mode, type) => x?.uid === 0 && x?.mode === mode
  && x?.type === type && x?.symlink === false && x?.nlink === 1

export function reviewGatewayFenceHostInstall(input, host) {
  const reasons = []
  const { manifest = {}, capsule = {}, callbacks = {} } = input ?? {}
  fail(reasons, 'REVIEW_ONLY_MODE_REQUIRED', manifest.schema_version === 'ecs-gateway-fence-host-review/1'
    && manifest.mode === 'review_only' && manifest.production_mutation_enabled === false)
  fail(reasons, 'PROTECTED_PATHS_INVALID', manifest.lock_path === LOCK
    && manifest.journal_dir === PREFIX && manifest.controller_path === '/usr/local/libexec/merchant/gateway-fence'
    && manifest.watchdog_path === '/usr/local/libexec/merchant/gateway-fence-watchdog')
  fail(reasons, 'CODE_DIGEST_INVALID', SHA.test(manifest.controller_sha256 ?? '')
    && SHA.test(manifest.watchdog_sha256 ?? ''))
  fail(reasons, 'CAPSULE_UNVERIFIED', host?.verifySigned?.('gateway_capsule', capsule) === true
    && host?.verifySigned?.('callback_policy', callbacks) === true)
  fail(reasons, 'CAPSULE_SCOPE_INVALID', ID.test(capsule.gateway_id ?? '')
    && /^sha256:[a-f0-9]{64}$/u.test(capsule.image_id ?? '')
    && SHA.test(capsule.config_sha256 ?? '') && SHA.test(capsule.effective_config_sha256 ?? '')
    && callbacks.gateway_id === capsule.gateway_id
    && Array.isArray(callbacks.exact_paths) && callbacks.exact_paths.length > 0)
  const lock = host?.observeLock?.()
  fail(reasons, 'PROTECTED_LOCK_NOT_HELD', lock?.path === LOCK && protectedObject(lock, 0o600, 'file')
    && lock.fd9_dev === lock.dev && lock.fd9_ino === lock.ino
    && lock.flock_owner_pid === lock.invocation_pid)
  const paths = host?.observeInstalledPaths?.() ?? {}
  fail(reasons, 'INSTALL_PATHS_UNPROTECTED', protectedObject(paths.controller, 0o500, 'file')
    && protectedObject(paths.watchdog, 0o500, 'file')
    && paths.controller?.sha256 === manifest.controller_sha256
    && paths.watchdog?.sha256 === manifest.watchdog_sha256
    && paths.journal_dir?.uid === 0 && paths.journal_dir?.mode === 0o700
    && paths.journal_dir?.type === 'directory' && paths.journal_dir?.symlink === false)
  const runtime = host?.observeGateway?.()
  fail(reasons, 'LIVE_GATEWAY_DRIFT', runtime?.id === capsule.gateway_id
    && runtime?.image_id === capsule.image_id && runtime?.running === true
    && runtime?.host_ports?.join(',') === '80,443'
    && runtime?.compose_project === 'merchant-demo-85575f9c'
    && runtime?.compose_service === 'pilot-gateway'
    && runtime?.network_id === capsule.network_id)
  const config = host?.readGatewayConfig?.()
  fail(reasons, 'LIVE_CONFIG_DRIFT', typeof config === 'string' && digest(config) === capsule.config_sha256)
  const effective = host?.observeEffectiveNginx?.()
  fail(reasons, 'EFFECTIVE_NGINX_UNVERIFIED', effective?.sha256 === capsule.effective_config_sha256
    && effective?.real_ip_disabled === true && effective?.healthcheck_exact === true)
  const watchdog = host?.observeWatchdog?.()
  fail(reasons, 'WATCHDOG_NOT_INSTALLED', watchdog?.installed === true && watchdog?.root_owned === true
    && watchdog?.interval_seconds <= 10 && watchdog?.interval_seconds > 0
    && watchdog?.exec_sha256 === manifest.watchdog_sha256
    && watchdog?.production_mutation_enabled === false)
  return { review_only_ready: reasons.length === 0, installation_allowed: false,
    production_mutation_allowed: false, reasons }
}

/**
 * Review a signed durable journal after controller death. The returned action
 * is an incident recommendation, never authorization to mutate production.
 * Once bridge mutation starts, reopening old ingress is categorically unsafe.
 */
export function reviewGatewayFenceCrash(journal, observed, verifySigned) {
  const reasons = []
  fail(reasons, 'JOURNAL_SIGNATURE_INVALID', typeof verifySigned === 'function'
    && verifySigned('fence_journal', journal) === true)
  fail(reasons, 'JOURNAL_INVALID', journal?.schema_version === 'ecs-gateway-fence-journal/1'
    && ['captured', 'write_started', 'fenced', 'bridge_mutation_started', 'recovered'].includes(journal.phase)
    && ID.test(journal.gateway_id ?? '') && SHA.test(journal.baseline_sha256 ?? '')
    && SHA.test(journal.fenced_sha256 ?? '') && journal.baseline_sha256 !== journal.fenced_sha256
    && SHA.test(journal.capsule_sha256 ?? '') && SHA.test(journal.callback_policy_sha256 ?? ''))
  fail(reasons, 'RUNTIME_IDENTITY_DRIFT', observed?.gateway_id === journal?.gateway_id
    && observed?.running === true && observed?.host_ports?.join(',') === '80,443')
  fail(reasons, 'CONFIG_STATE_UNKNOWN', observed?.config_sha256 === journal?.baseline_sha256
    || observed?.config_sha256 === journal?.fenced_sha256)
  fail(reasons, 'DATABASE_PREFIX_UNKNOWN', Number.isSafeInteger(observed?.db_prefix)
    && observed.db_prefix >= 242 && observed.db_prefix <= 254)
  if (journal?.phase === 'captured' || journal?.phase === 'recovered') {
    fail(reasons, 'JOURNAL_CONFIG_PHASE_MISMATCH', observed?.config_sha256 === journal.baseline_sha256)
  }
  if (journal?.phase === 'bridge_mutation_started' || observed?.db_prefix > 242) {
    fail(reasons, 'INGRESS_OPEN_DURING_MUTATION', observed?.config_sha256 === journal.fenced_sha256)
  }
  if (reasons.length) return { recommendation: 'hold_and_page', production_mutation_allowed: false, reasons }
  if (journal.phase === 'bridge_mutation_started' || observed.db_prefix !== 242) {
    return { recommendation: 'keep_fenced_for_forward_recovery', production_mutation_allowed: false, reasons: [] }
  }
  if (observed.config_sha256 === journal.baseline_sha256) {
    return { recommendation: 'baseline_present_verify_service', production_mutation_allowed: false, reasons: [] }
  }
  if (observed.old_runtime_intact !== true || observed.callbacks_reached_api !== true) {
    return { recommendation: 'hold_and_page', production_mutation_allowed: false,
      reasons: ['BASELINE_RESTORE_PRECONDITIONS_MISSING'] }
  }
  return { recommendation: 'restore_baseline_under_lock_then_probe', production_mutation_allowed: false, reasons: [] }
}
