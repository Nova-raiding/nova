// Contract for a future protected host controller. This module only verifies
// two externally signed snapshots and independently supplied observations.
// It never opens a production path or transitions a durable journal itself.
import { createHash } from 'node:crypto'
import { reviewBridge255Phase } from './ecs-bridge-255-review.mjs'

const TRANSITIONS = Object.freeze({
  captured_254: 'fenced_254',
  fenced_254: 'migrating_255',
  migrating_255: 'verified_255',
  verified_255: 'candidate_cutover',
  candidate_cutover: 'accepted_255',
  accepted_255: null,
})
const HOST_CONTRACT = Object.freeze({
  protected_entrypoint: '/usr/local/libexec/merchant/ecs-bridge-255-transition',
  production_lock: '/var/lib/merchant-release-security/production-deploy.lock',
  nonce_ledger: '/var/lib/merchant-release-security/production-nonces.sqlite3',
  nonce_namespace: 'merchant-production-deploy',
  nonce_operation: 'bridge-255',
  journal_root: '/var/lib/merchant-release-security/bridge-255',
  trust_root: '/run/release-security/evidence-trust',
})
const OBSERVATIONS = Object.freeze({
  captured_254: ['public release four-field identity', 'exact old demo Docker inspect and Compose labels',
    'gateway 80/443 bindings and upstream', '254 full migration history through runtime and Ops roles',
    'frozen candidate and 255 recovery image/Compose/env digests'],
  fenced_254: ['ingress and callbacks fenced at gateway', 'zero in-flight requests, worker cycles, leases and unresolved provider calls',
    'exact old API/replica/worker IDs stopped', 'signed backup restored on isolated pinned PG17',
    'unchanged 254 runtime and Ops migration history'],
  migrating_255: ['same production lock and one-use nonce owner receipt', 'fence and stopped old workloads re-observed',
    'migration executor restricted to frozen 255 SQL', 'runtime and Ops history at exact 254 or 255 prefix'],
  verified_255: ['runtime and Ops full 1–255 history and checksum', 'old 254 workloads remain fenced',
    'pinned 255 recovery API/replica/all workers and gateway healthy', 'merchant/Ops business canary'],
  candidate_cutover: ['candidate image/Compose/env/identity and gateway upstream re-observed',
    'candidate API/replica/all workers healthy on 255', 'old 254 workload still fenced', 'signed 255 forward recovery target ready'],
  accepted_255: ['public candidate releasez and readyz', 'merchant/Ops and model relay canary',
    'local stdio ChatGPT host evidence', 'database remains 255', 'signed durable journal terminal state'],
})
const requireValue = (ok, message) => { if (!ok) throw new Error(`BRIDGE_255_STATE_${message}`) }
const signedJournalDigest = journal => createHash('sha256')
  .update(JSON.stringify(Object.fromEntries(Object.entries(journal).sort(([a], [b]) => a.localeCompare(b)))))
  .digest('hex')

/**
 * The future host entrypoint must collect observations under the same held
 * flock, read protected trust material, verify the nonce ledger, then call
 * this review before atomically writing its next signed journal. A passing
 * review is still not a permission for that entrypoint to mutate production.
 */
export function reviewBridge255Transition({ plan, capture, previous, next, publicKeyPem,
  previousObservation, nextObservation, now = new Date() }) {
  requireValue(previous && next && Object.hasOwn(TRANSITIONS, previous.phase)
    && TRANSITIONS[previous.phase] === next.phase, 'PHASE_ORDER_INVALID')
  const prior = reviewBridge255Phase({ plan, capture, journal: previous,
    publicKeyPem, observation: previousObservation, now })
  const following = reviewBridge255Phase({ plan, capture, journal: next,
    publicKeyPem, observation: nextObservation, now })
  requireValue(previous.created_at < next.created_at
    && previous.expires_at === next.expires_at, 'JOURNAL_CHRONOLOGY_INVALID')
  requireValue(next.previous_journal_sha256 === signedJournalDigest(previous),
    'JOURNAL_CHAIN_INVALID')
  requireValue(prior.plan_sha256 === following.plan_sha256
    && previous.attempt_id === next.attempt_id
    && previous.nonce_sha256 === next.nonce_sha256,
  'ATTEMPT_BINDING_INVALID')
  // A transition from a post-migration state cannot regress the database to
  // 254. The signed per-phase reviewer checks the complete role-visible chain.
  requireValue(nextObservation.database.version >= previousObservation.database.version,
    'DATABASE_DOWNGRADE_INVALID')
  return Object.freeze({ schema_version: 'ecs-bridge-255-transition-review/1', status: 'review_only',
    from: previous.phase, to: next.phase, plan_sha256: prior.plan_sha256,
    previous_signed_journal_sha256: signedJournalDigest(previous),
    next_signed_journal_sha256: signedJournalDigest(next),
    host_contract: HOST_CONTRACT, required_observations: OBSERVATIONS[next.phase],
    production_authorized: false, deployable: false,
    blockers: [...new Set([...prior.blockers, ...following.blockers,
      'NO_PROTECTED_ATOMIC_JOURNAL_CAS', 'NO_REHEARSED_FORWARD_RECOVERY_PATH'])],
  })
}

export const BRIDGE_255_HOST_CONTRACT = HOST_CONTRACT
export const BRIDGE_255_REQUIRED_OBSERVATIONS = OBSERVATIONS
