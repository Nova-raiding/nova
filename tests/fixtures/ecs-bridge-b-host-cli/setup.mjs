import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const sha = value => createHash('sha256').update(value).digest('hex')
const hash = letter => letter.repeat(64)
const image = letter => `sha256:${hash(letter)}`
const root = '/var/lib/merchant-release-security'
const trust = '/run/release-security/evidence-trust'
const bin = '/usr/local/libexec/merchant'
for (const path of [root, trust, bin, '/state']) mkdirSync(path, { recursive: true, mode: 0o700 })
for (const path of [root, trust, bin, '/state']) chmodSync(path, path === root || path === '/state' ? 0o700 : 0o755)
// Preserve controller behavior but expose the caught stack for fixture diagnosis.
const controllerPath = `${bin}/ecs-bridge-b-transition`
let controllerBytes = readFileSync(controllerPath, 'utf8')
const verifyNeedle = "  assert(document?.schema_version === 'ecs-bridge-b-transition/2' && verifyDocument(document, publicPem), 'Bridge B journal signature is invalid')"
if (!controllerBytes.includes(verifyNeedle)) throw new Error('fixture diagnostic could not locate the journal verifier')
controllerBytes = controllerBytes
  .replace(verifyNeedle, "  process.stderr.write('VERIFY ' + document.phase + ' sha=' + sha256(Buffer.from(canonical(document))) + ' pub=' + sha256(Buffer.from(publicPem)) + ' expires=' + document.expires_at + ' now=' + new Date().toISOString() + ' sig=' + document.signature_base64 + ' valid=' + verifyDocument(document, publicPem) + '\\n')\n" + verifyNeedle)
  .replace('error.message}', 'error.stack}')
const snap = label => `process.stderr.write('SNAP ${label} sig=' + journal.signature_base64 + ' sha=' + sha256(Buffer.from(canonical(journal))) + '\\n');\n  `
for (const [needle, label] of [
  ["  assert(path === journalPath(journal.attempt_id), 'Bridge B journal path does not match signed attempt')", 'post-read'],
  ["  assertUnchangedBeforeInstall(journal, get('--service-map'), project)", 'post-inventory'],
  ["  databaseIs242(before, journal, 'pre-mutation check')", 'post-database'],
  ["  const candidate = { release_id: journal.bridge.release_id", 'pre-candidate'],
  ["  const imageIds = resolveImageIds(config.document, journal.bridge_artifacts.services)", 'post-images'],
]) {
  if (!controllerBytes.includes(needle)) throw new Error(`fixture diagnostic could not locate install point: ${label}`)
  controllerBytes = controllerBytes.replace(needle, snap(label) + needle)
}
writeFileSync(controllerPath, controllerBytes)
const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const privatePath = `${root}/production-capability-private.pem`
const publicPath = `${trust}/production-evidence-public.pem`
writeFileSync(privatePath, keys.privateKey, { mode: 0o600 })
writeFileSync(publicPath, keys.publicKey, { mode: 0o600 })
writeFileSync(`${trust}/production-evidence-key-id`, 'isolated-fixture\n', { mode: 0o600 })
writeFileSync(`${trust}/production-bridge-b-transition-sha256`, sha(readFileSync(controllerPath)) + '\n', { mode: 0o600 })
writeFileSync(`${trust}/production-evidence-nonce-consumer-sha256`, sha(readFileSync('/usr/local/libexec/merchant/consume-production-evidence-nonce')) + '\n', { mode: 0o600 })
const journalDir = `${root}/bridge-b`
mkdirSync(journalDir, { mode: 0o700 }); chmodSync(journalDir, 0o700)
const db = new DatabaseSync(`${root}/production-nonces.sqlite3`)
db.exec('CREATE TABLE consumed_nonces(namespace TEXT NOT NULL, nonce TEXT NOT NULL, release_id TEXT NOT NULL, image_digest TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, release_git_sha TEXT NOT NULL, PRIMARY KEY(namespace, nonce))')
db.close(); chmodSync(`${root}/production-nonces.sqlite3`, 0o600)

const oldIdentity = { release_id: 'old-release-242', release_git_sha: 'a'.repeat(40), manifest_sha256: hash('b'), image_set_digest: image('c') }
const bridgeIdentity = { release_id: 'bridge-release-242', release_git_sha: 'd'.repeat(40), manifest_sha256: hash('e'), image_set_digest: image('f') }
for (const [name, identity] of [['old', oldIdentity], ['bridge', bridgeIdentity]]) writeFileSync(`/state/${name}-identity.json`, JSON.stringify(identity))
function compose(identity, digest) {
  const environment = { RELEASE_ID: identity.release_id, RELEASE_GIT_SHA: identity.release_git_sha, RELEASE_MANIFEST_SHA256: identity.manifest_sha256, RELEASE_IMAGE_SET_DIGEST: identity.image_set_digest, RUN_MIGRATIONS_ON_STARTUP: 'false' }
  return { services: {
    api: { image: `registry.invalid/api@${digest}`, environment, depends_on: {} },
    'api-replica': { image: `registry.invalid/api@${digest}`, environment: { ...environment }, depends_on: {} },
  } }
}
for (const [name, identity, digest] of [['old', oldIdentity, image('1')], ['bridge', bridgeIdentity, image('2')]]) {
  writeFileSync(`/state/${name}-compose.json`, `${JSON.stringify(compose(identity, digest))}\n`, { mode: 0o600 })
  writeFileSync(`/state/${name}-env`, `RELEASE_ID=${identity.release_id}\n`, { mode: 0o600 })
  writeFileSync(`/state/${name}-digests.json`, `${JSON.stringify({ api: digest })}\n`, { mode: 0o600 })
}
const history = Array.from({ length: 242 }, (_, index) => [index + 1, `migration_${String(index + 1).padStart(3, '0')}`, hash('1')])
writeFileSync('/state/history.json', JSON.stringify(history))
const allowedPrefix = sha(JSON.stringify(history))
const oldCompose = readFileSync('/state/old-compose.json'), oldEnv = readFileSync('/state/old-env'), oldDigests = readFileSync('/state/old-digests.json')
const now = Date.now()
const plan = { schema_version: '1', kind: 'ecs-compose-rollback-capsule', created_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 86_000_000).toISOString(), database: { strategy: 'forward_only', schema_downgrade: false, live_migration_version: 242, target_migration_tail: 242, allowed_prefix_sha256: { 242: allowedPrefix } }, volumes: { preserve: true }, target: { release_id: oldIdentity.release_id, git_sha: oldIdentity.release_git_sha, manifest_sha256: oldIdentity.manifest_sha256, image_set_digest: oldIdentity.image_set_digest, compose_sha256: sha(oldCompose), env_sha256: sha(oldEnv), image_digests_sha256: sha(oldDigests), services: ['api', 'api-replica'] } }
writeFileSync('/state/recovery-plan.json', `${JSON.stringify(plan)}\n`, { mode: 0o600 })
writeFileSync('/state/service-map.json', '[{"service":"api","container":"merchant-api-1"},{"service":"api-replica","container":"merchant-api-replica-1"}]\n', { mode: 0o600 })
writeFileSync('/state/runtime.json', JSON.stringify({ runtime: 'old', apiId: 'a'.repeat(64), replicaId: 'c'.repeat(64) }))
writeFileSync('/state/lock', '')
chmodSync('/state/lock', 0o600)
for (const [name, source] of [['docker','docker.mjs'],['psql','psql.mjs'],['curl','curl.mjs']]) {
  copyFileSync(`/tests/fixtures/ecs-bridge-b-host-cli/${source}`, `/usr/bin/${name}`); chmodSync(`/usr/bin/${name}`, 0o755)
}
console.log(`fixture ready; migration_history_sha256=${allowedPrefix}`)
