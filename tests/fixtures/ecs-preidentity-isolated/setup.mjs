import crypto from 'node:crypto'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const sha = value => value.repeat(64), image = value => `sha256:${sha(value)}`
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
for (const path of ['/usr/local/libexec/merchant', '/run/release-security/evidence-trust', '/var/lib/merchant-release-security', '/state']) fs.mkdirSync(path, { recursive: true, mode: 0o700 })
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
fs.writeFileSync('/var/lib/merchant-release-security/production-capability-private.pem', privateKey, { mode: 0o600 })
fs.writeFileSync('/run/release-security/evidence-trust/production-evidence-public.pem', publicKey, { mode: 0o600 })
fs.writeFileSync('/run/release-security/evidence-trust/production-evidence-key-id', 'isolated-test-key\n', { mode: 0o600 })
const rows = Array.from({ length: 219 }, (_, index) => [index + 1, `m${index + 1}`, crypto.createHash('sha256').update(`m${index + 1}`).digest('hex')])
const history = crypto.createHash('sha256').update(canonical(rows)).digest('hex')
const plan = { schema_version: '1', kind: 'ecs-compose-rollback-capsule', database: { strategy: 'forward_only', schema_downgrade: false, target_migration_tail: 233, allowed_prefix_sha256: { 219: history, 233: sha('9') } }, target: { release_id: 'release-48', git_sha: 'd'.repeat(40), manifest_sha256: sha('e'), image_set_digest: image('f'), compose_sha256: sha('6'), env_sha256: sha('7'), image_digests_sha256: sha('8'), services: ['api', 'worker-sync'] } }
fs.writeFileSync('/state/plan.json', JSON.stringify(plan), { mode: 0o600 })
const bridgeRows = Array.from({ length: 242 }, (_, index) => [index + 1, `m${index + 1}`, crypto.createHash('sha256').update(`m${index + 1}`).digest('hex')])
const bridgeHistory = crypto.createHash('sha256').update(canonical(bridgeRows)).digest('hex')
const bridgeCompose = `services:\n  api:\n    image: old-api@sha256:${sha('1')}\n  worker-sync:\n    image: old-worker@sha256:${sha('3')}\n`
const bridgeCandidateCompose = `services:\n  api:\n    image: new-api@sha256:${sha('c')}\n  worker-sync:\n    image: new-worker@sha256:${sha('d')}\n`
const bridgeEnv = 'BRIDGE_TEST=old\n'
const oldDigests = JSON.stringify({ api: `old-api@sha256:${sha('1')}`, 'worker-sync': `old-worker@sha256:${sha('3')}` })
fs.writeFileSync('/state/bridge-compose.yml', bridgeCompose, { mode: 0o600 })
fs.writeFileSync('/state/bridge-candidate-compose.yml', bridgeCandidateCompose, { mode: 0o600 })
fs.writeFileSync('/state/bridge-env', bridgeEnv, { mode: 0o600 })
fs.writeFileSync('/state/bridge-old-digests.json', oldDigests, { mode: 0o600 })
fs.writeFileSync('/state/bridge-candidate.json', JSON.stringify({ api: `new-api@sha256:${sha('c')}`, 'worker-sync': `new-worker@sha256:${sha('d')}` }), { mode: 0o600 })
fs.writeFileSync('/state/bridge-plan.json', JSON.stringify({ ...plan, database: { ...plan.database, live_migration_version: 242, target_migration_tail: 242, allowed_prefix_sha256: { 242: bridgeHistory } }, target: { ...plan.target, compose_sha256: crypto.createHash('sha256').update(bridgeCompose).digest('hex'), env_sha256: crypto.createHash('sha256').update(bridgeEnv).digest('hex'), image_digests_sha256: crypto.createHash('sha256').update(oldDigests).digest('hex') } }), { mode: 0o600 })
fs.writeFileSync('/state/map.json', JSON.stringify([{ service: 'api', container: 'legacy-api' }, { service: 'worker-sync', container: 'legacy-worker' }]), { mode: 0o600 })
fs.writeFileSync('/state/candidate.json', JSON.stringify({ api: `node@sha256:${sha('c')}` }), { mode: 0o600 })
fs.writeFileSync('/state/lock', '', { mode: 0o600 })
const ledger = new DatabaseSync('/var/lib/merchant-release-security/production-nonces.sqlite3')
ledger.exec('CREATE TABLE consumed_nonces(namespace TEXT,nonce TEXT,release_id TEXT,image_digest TEXT,manifest_sha256 TEXT,release_git_sha TEXT)')
ledger.prepare('INSERT INTO consumed_nonces VALUES(?,?,?,?,?,?)').run('merchant-production-deploy', 'nonce_abcdefghijklmnopqr', 'release-a9', image('c'), sha('b'), 'a'.repeat(40))
ledger.close()
fs.chmodSync('/var/lib/merchant-release-security/production-nonces.sqlite3', 0o600)
