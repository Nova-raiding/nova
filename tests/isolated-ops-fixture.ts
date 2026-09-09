import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { PostgresAuthorizationRepository } from '../packages/persistence/src/authorization-repository.js'
import { loadMigrations, MigrationRunner, type Migration } from '../packages/persistence/src/migration.js'

export const ISOLATED_POSTGRES_IMAGE = 'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
const PURPOSE = 'isolated-ops-oidc-acceptance'
const LABEL_PREFIX = 'merchant.fixture'
type ContainerKind = 'postgres' | 'redis'
type OwnedContainer = { id: string; name: string; runId: string; kind: ContainerKind; image: string }
type ContainerInspection = {
  id: string; name: string; image: string; labels: Record<string, string> | null
  autoRemove: boolean; running: boolean; mounts: { Type: string; Destination: string }[]
  tmpfs: Record<string, string> | null; ports: Record<string, { HostIp: string; HostPort: string }[] | null>
}
export interface IsolatedContainerEvidence extends OwnedContainer {
  hostPort: number
  autoRemove: true
  labels: Record<string, string>
  dataStorage: 'tmpfs'
}
export interface IsolatedFixtureDisposal {
  stopped: string[]
  leftRunning: { id: string; reason: string }[]
}
export interface IsolatedOpsFixture {
  runId: string
  databaseUrl: string
  /** Only for the isolated PostgreSQL test runner; never pass to API/UI or evidence. */
  adminDatabaseUrl: string
  opsDatabaseUrl: string
  redisUrl: string
  workspaceId: string
  subjectIdentityId: string
  workspaceActorSubject: string
  approverId: string
  issuer: string
  actorSubject: string
  containerEvidence: IsolatedContainerEvidence[]
  dispose(): Promise<IsolatedFixtureDisposal>
}

export function assertIsolatedMigrationChain(migrations: readonly Pick<Migration, 'version'>[], expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1
    || migrations.length !== expectedVersion
    || migrations.some((migration, index) => migration.version !== index + 1)) {
    throw new Error('ISOLATED_FIXTURE_MIGRATION_CHAIN_MISMATCH')
  }
}

// No process.env spread, Docker context, credential config, provider, or model
// settings are inherited. Only generated fixture secrets may be added.
export function isolatedFixtureSpawnEnvironment(secrets: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allowed = new Set(['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD', 'FIXTURE_REDIS_PASSWORD', 'REDISCLI_AUTH'])
  if (Object.keys(secrets).some(key => !allowed.has(key))) throw new Error('ISOLATED_FIXTURE_ENV_NOT_ALLOWED')
  return { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8', ...secrets }
}

export function isolatedContainerRunArgs(input: { runId: string; kind: ContainerKind; image: string }): { name: string; args: string[] } {
  if (!/^[a-f0-9-]{36}$/u.test(input.runId) || !/^[a-z0-9/:._-]+@sha256:[a-f0-9]{64}$/u.test(input.image)) throw new Error('ISOLATED_FIXTURE_IDENTITY_INVALID')
  const name = `merchant-ops-fixture-${input.kind}-${input.runId}`
  const dataPath = input.kind === 'postgres' ? '/var/lib/postgresql/data' : '/data'
  const port = input.kind === 'postgres' ? 5432 : 6379
  const args = ['run', '--detach', '--rm', '--pull=never', '--name', name,
    '--label', `${LABEL_PREFIX}.purpose=${PURPOSE}`, '--label', `${LABEL_PREFIX}.run-id=${input.runId}`, '--label', `${LABEL_PREFIX}.kind=${input.kind}`,
    '--publish', `127.0.0.1::${port}`, '--tmpfs', `${dataPath}:rw,nosuid,size=${input.kind === 'postgres' ? '512m' : '64m'}`,
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '128']
  if (input.kind === 'postgres') args.push('--env', 'POSTGRES_USER', '--env', 'POSTGRES_DB', '--env', 'POSTGRES_PASSWORD', input.image)
  else args.push('--env', 'FIXTURE_REDIS_PASSWORD', input.image, 'sh', '-c', 'exec redis-server --save "" --appendonly no --requirepass "$FIXTURE_REDIS_PASSWORD"')
  return { name, args }
}

export function verifyIsolatedContainer(actual: ContainerInspection, expected: OwnedContainer): IsolatedContainerEvidence {
  const labels = actual.labels
  const dataPath = expected.kind === 'postgres' ? '/var/lib/postgresql/data' : '/data'
  const bindings = actual.ports?.[expected.kind === 'postgres' ? '5432/tcp' : '6379/tcp']
  const port = bindings?.[0]?.HostPort ?? ''
  if (!/^[a-f0-9]{64}$/u.test(expected.id) || actual.id !== expected.id || actual.name !== `/${expected.name}` || actual.image !== expected.image
    || labels?.[`${LABEL_PREFIX}.purpose`] !== PURPOSE || labels?.[`${LABEL_PREFIX}.run-id`] !== expected.runId || labels?.[`${LABEL_PREFIX}.kind`] !== expected.kind
    || actual.autoRemove !== true || actual.running !== true
    || !actual.tmpfs || !Object.hasOwn(actual.tmpfs, dataPath)
    || !Array.isArray(actual.mounts) || actual.mounts.some(mount => mount.Type !== 'tmpfs')
    || bindings?.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1' || !/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535
    || Object.entries(actual.ports).some(([key, value]) => key !== (expected.kind === 'postgres' ? '5432/tcp' : '6379/tcp') && value != null)) {
    throw new Error('ISOLATED_FIXTURE_CONTAINER_IDENTITY_MISMATCH')
  }
  return { ...expected, hostPort: Number(port), autoRemove: true, labels: { ...labels }, dataStorage: 'tmpfs' }
}

export async function disposeIsolatedContainers(containers: readonly OwnedContainer[], operations: {
  inspect(container: OwnedContainer): Promise<ContainerInspection>
  stop(container: OwnedContainer): Promise<void>
}): Promise<IsolatedFixtureDisposal> {
  const result: IsolatedFixtureDisposal = { stopped: [], leftRunning: [] }
  for (const container of [...containers].reverse()) {
    try {
      verifyIsolatedContainer(await operations.inspect(container), container)
      await operations.stop(container)
      result.stopped.push(container.id)
    } catch {
      // Never guess from a reused name, label search, partial ID, or failed
      // inspection. A failed proof leaves the resource for explicit review.
      result.leftRunning.push({ id: container.id, reason: 'identity verification or exact-ID stop failed; not retried destructively' })
    }
  }
  return result
}

async function localDockerSocket(): Promise<string> {
  // Discover only known local socket paths, not Docker context/config files.
  const candidates = ['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock'), join(homedir(), '.colima/default/docker.sock'), join(homedir(), '.orbstack/run/docker.sock')]
  const sockets: string[] = []
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isSocket()) sockets.push(candidate) } catch { /* absent local socket */ }
  }
  if (sockets.length !== 1) throw new Error('ISOLATED_FIXTURE_LOCAL_DOCKER_SOCKET_AMBIGUOUS_OR_MISSING')
  return sockets[0]!
}

export async function createIsolatedOpsFixture({ evidenceDir }: { evidenceDir: string }): Promise<IsolatedOpsFixture> {
  const runId = randomUUID()
  const output = resolve(evidenceDir)
  await mkdir(output, { recursive: true, mode: 0o700 })
  const dockerConfig = join(output, `docker-client-${runId}`)
  await mkdir(dockerConfig, { mode: 0o700 })
  const socket = await localDockerSocket()
  const docker = async (args: readonly string[], secrets: Record<string, string> = {}): Promise<string> => new Promise((resolveResult, reject) => {
    execFile('docker', ['--host', `unix://${socket}`, '--config', dockerConfig, ...args], { env: isolatedFixtureSpawnEnvironment(secrets), timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      // Native errors include command arguments and stderr: expose only the
      // action, never generated credentials or daemon configuration details.
      if (error) reject(new Error(`ISOLATED_FIXTURE_DOCKER_${args[0]?.toUpperCase() ?? 'COMMAND'}_FAILED`))
      else resolveResult(stdout.trim())
    })
  })
  const owned: OwnedContainer[] = []
  const evidence: IsolatedContainerEvidence[] = []
  const inspect = async (container: OwnedContainer): Promise<ContainerInspection> => JSON.parse(await docker(['inspect', '--format', '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"autoRemove":{{json .HostConfig.AutoRemove}},"running":{{json .State.Running}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}},"ports":{{json .NetworkSettings.Ports}}}', container.id])) as ContainerInspection
  let disposal: Promise<IsolatedFixtureDisposal> | undefined
  const dispose = () => disposal ??= (async () => {
    const result = await disposeIsolatedContainers(owned, { inspect, stop: async container => { await docker(['stop', '--time', '10', container.id]) } })
    await writeFile(join(output, `fixture-disposal-${runId}.json`), JSON.stringify({ runId, ...result, evidenceRetained: true, externalContainersTouched: false }, null, 2), { mode: 0o600, flag: 'wx' })
    return result
  })()
  let admin: Pool | undefined
  let ops: Pool | undefined
  try {
    const redisDigests: unknown = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', 'redis:7-alpine']))
    const redisDigest = Array.isArray(redisDigests) ? redisDigests.find((value: unknown) => typeof value === 'string' && /^redis@sha256:[a-f0-9]{64}$/u.test(value)) : undefined
    if (typeof redisDigest !== 'string') throw new Error('ISOLATED_FIXTURE_LOCAL_REDIS_DIGEST_MISSING')
    const postgresPassword = randomBytes(32).toString('hex')
    const redisPassword = randomBytes(32).toString('hex')
    for (const kind of ['postgres', 'redis'] as const) {
      const image = kind === 'postgres' ? ISOLATED_POSTGRES_IMAGE : redisDigest
      const plan = isolatedContainerRunArgs({ runId, kind, image })
      const id = await docker(plan.args, kind === 'postgres' ? { POSTGRES_USER: 'merchant', POSTGRES_DB: 'merchant', POSTGRES_PASSWORD: postgresPassword } : { FIXTURE_REDIS_PASSWORD: redisPassword })
      if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('ISOLATED_FIXTURE_CREATED_CONTAINER_ID_INVALID')
      const container = { id, name: plan.name, runId, kind, image }
      owned.push(container)
      evidence.push(verifyIsolatedContainer(await inspect(container), container))
    }
    await writeFile(join(output, `fixture-containers-${runId}.json`), JSON.stringify({ runId, containers: evidence, externalConfigurationRead: false }, null, 2), { mode: 0o600, flag: 'wx' })
    const postgres = evidence.find(container => container.kind === 'postgres')!
    const redis = evidence.find(container => container.kind === 'redis')!
    const adminUrl = new URL(`postgres://127.0.0.1:${postgres.hostPort}/merchant`)
    adminUrl.username = 'merchant'; adminUrl.password = postgresPassword
    admin = new Pool({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 1_000, max: 3 })
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await admin.query('SELECT 1'); ready = true; break } catch { await new Promise(resolveWait => setTimeout(resolveWait, 250)) }
    }
    if (!ready) throw new Error('ISOLATED_FIXTURE_POSTGRES_NOT_READY')
    if (await docker(['exec', '--env', 'REDISCLI_AUTH', redis.id, 'redis-cli', 'ping'], { REDISCLI_AUTH: redisPassword }) !== 'PONG') throw new Error('ISOLATED_FIXTURE_REDIS_NOT_READY')
    const serverVersion = String((await admin.query('SHOW server_version')).rows[0]?.server_version ?? '')
    if (!serverVersion.startsWith('17.')) throw new Error('ISOLATED_FIXTURE_POSTGRES_MAJOR_MISMATCH')
    const roleSql = await readFile(new URL('../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
    await admin.query(roleSql)
    const migrations = await loadMigrations()
    const releaseMetadata = JSON.parse(await readFile(new URL('../release-metadata.json', import.meta.url), 'utf8')) as { expectedMigrationVersion?: unknown }
    const expectedMigrationVersion = Number(releaseMetadata.expectedMigrationVersion)
    assertIsolatedMigrationChain(migrations, expectedMigrationVersion)
    const applied = await new MigrationRunner(admin, migrations).run()
    if (applied.length !== expectedMigrationVersion || (await new MigrationRunner(admin, migrations).run()).length !== 0) throw new Error('ISOLATED_FIXTURE_MIGRATION_APPLY_MISMATCH')
    await admin.query(roleSql)
    const appPassword = randomBytes(32).toString('hex')
    const opsPassword = randomBytes(32).toString('hex')
    // Hex-only generated passwords, never external SQL interpolation.
    await admin.query(`ALTER ROLE merchant_app PASSWORD '${appPassword}'`)
    await admin.query(`ALTER ROLE merchant_ops PASSWORD '${opsPassword}'`)
    const workspaceId = `ws_ops_fixture_${runId.replaceAll('-', '')}`
    const actorIdentityId = randomUUID()
    const subjectIdentityId = randomUUID()
    const approverIdentityId = randomUUID()
    const approverId = `ops-fixture-approver-${runId}`
    const issuer = `http://127.0.0.1/isolated-ops-idp/${runId}`
    const actorSubject = `ops-fixture-actor-${runId}`
    await admin.query('INSERT INTO workspaces (id,status) VALUES ($1,\'active\')', [workspaceId])
    for (const [id, externalSubject, name] of [[actorIdentityId, actorSubject, 'Isolated Ops Actor'], [subjectIdentityId, `ops-fixture-target-${runId}`, 'Isolated Grant Target'], [approverIdentityId, approverId, 'Isolated Approval Fixture']]) {
      await admin.query('INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,$2,$3,$4)', [id, issuer, externalSubject, name])
    }
    await admin.query(
      `INSERT INTO workspace_members (id, workspace_id, external_subject, display_name, role, status, invited_by, identity_id)
       VALUES ($1, $2, $3, $4, 'merchant_admin', 'active', 'isolated-fixture-bootstrap', $5)`,
      [randomUUID(), workspaceId, `ops-fixture-target-${runId}`, 'Isolated Directory Target', subjectIdentityId],
    )
    const appUrl = new URL(adminUrl); appUrl.username = 'merchant_app'; appUrl.password = appPassword
    const opsUrl = new URL(adminUrl); opsUrl.username = 'merchant_ops'; opsUrl.password = opsPassword
    ops = new Pool({ connectionString: opsUrl.toString(), connectionTimeoutMillis: 1_000 })
    const repository = new PostgresAuthorizationRepository(ops)
    await repository.assignPlatformRole({ subjectIdentityId: actorIdentityId, role: 'platform_admin', assignedBy: 'isolated-fixture-bootstrap', reason: 'synthetic desktop acceptance actor', expectedAuthorizationRevision: 0 })
    await repository.assignPlatformRole({ subjectIdentityId: actorIdentityId, role: 'security_admin', assignedBy: 'isolated-fixture-bootstrap', reason: 'synthetic desktop acceptance security actor', expectedAuthorizationRevision: 1 })
    await repository.assignPlatformRole({ subjectIdentityId: approverIdentityId, role: 'security_admin', assignedBy: 'isolated-fixture-bootstrap', reason: 'synthetic independent approval identity', expectedAuthorizationRevision: 0 })
    const roles = await repository.listActivePlatformRoles(actorIdentityId)
    if (roles.length !== 2 || await repository.getAuthorizationRevision(actorIdentityId) !== 2 || await repository.getAuthorizationRevision(subjectIdentityId) !== 0) throw new Error('ISOLATED_FIXTURE_AUTHORITY_SEED_MISMATCH')
    const roleFlags = (await admin.query("SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname IN ('merchant_app','merchant_ops') ORDER BY rolname")).rows
    if (roleFlags.length !== 2 || roleFlags.some(row => row.rolsuper || row.rolbypassrls || row.rolcreatedb || row.rolcreaterole)) throw new Error('ISOLATED_FIXTURE_RUNTIME_ROLE_UNSAFE')
    const app = new Pool({ connectionString: appUrl.toString(), connectionTimeoutMillis: 1_000, max: 1 })
    try {
      if ((await app.query('SELECT current_user AS role')).rows[0]?.role !== 'merchant_app') throw new Error('ISOLATED_FIXTURE_APP_ROLE_CONNECTION_MISMATCH')
      const client = await app.connect()
      try {
        await client.query('BEGIN READ ONLY')
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId])
        if ((await client.query('SELECT id FROM workspaces')).rows[0]?.id !== workspaceId) throw new Error('ISOLATED_FIXTURE_APP_ROLE_WORKSPACE_SCOPE_MISMATCH')
        await client.query('COMMIT')
      } finally { await client.query('ROLLBACK'); client.release() }
    } finally { await app.end() }
    const redisUrl = new URL(`redis://127.0.0.1:${redis.hostPort}/0`); redisUrl.password = redisPassword
    await writeFile(join(output, `fixture-ready-${runId}.json`), JSON.stringify({ runId, containers: evidence, serverVersion, migrationVersions: applied, workspaceId, actorIdentityId, subjectIdentityId, approverIdentityId, approverId, issuer, actorSubject, actorRoles: roles.map(role => role.role), runtimeRoles: roleFlags, commercialModelCalls: 0, fixtureOnly: true }, null, 2), { mode: 0o600, flag: 'wx' })
    await ops.end(); ops = undefined
    await admin.end(); admin = undefined
    return { runId, databaseUrl: appUrl.toString(), adminDatabaseUrl: adminUrl.toString(), opsDatabaseUrl: opsUrl.toString(), redisUrl: redisUrl.toString(), workspaceId, subjectIdentityId, workspaceActorSubject: `ops-fixture-target-${runId}`, approverId, issuer, actorSubject, containerEvidence: evidence, dispose }
  } catch (error) {
    await ops?.end(); ops = undefined
    await admin?.end(); admin = undefined
    const cleanup = await dispose()
    await writeFile(join(output, `fixture-failed-${runId}.json`), JSON.stringify({ runId, error: error instanceof Error && /^ISOLATED_FIXTURE_[A-Z_]+$/u.test(error.message) ? error.message : 'ISOLATED_FIXTURE_SETUP_FAILED', cleanup }, null, 2), { mode: 0o600, flag: 'wx' })
    throw error instanceof Error && /^ISOLATED_FIXTURE_[A-Z_]+$/u.test(error.message) ? error : new Error('ISOLATED_FIXTURE_SETUP_FAILED')
  }
}
