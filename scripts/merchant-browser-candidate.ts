import { randomBytes } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, createConnection } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Environment = Record<string, string | undefined>
const activeChildren = new Set<ChildProcess>()
const candidateServices = ['api', 'ui', 'ops-ui', 'postgres', 'redis', 'migrate']
export const CANDIDATE_POSTGRES_IMAGE = 'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
const toolingEnvironmentKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'CI', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'MERCHANT_E2E_LOGIN', 'MERCHANT_E2E_PASSWORD'] as const

export function isolatedCandidateEnvironment(source: Environment): Environment {
  if (source.BROWSER_ENV_FILE) throw new Error('candidate mode refuses BROWSER_ENV_FILE and business environment files')
  const env: Environment = {}
  for (const key of toolingEnvironmentKeys) if (source[key] !== undefined) env[key] = source[key]
  return { ...env, BROWSER_STACK_MODE: 'candidate', NODE_ENV: 'test',
    PERSISTENCE_MODE: 'postgres', CONNECTOR_FIXTURE_MODE: 'true', PAYMENT_MODE: 'fixture',
    COMMERCIAL_PAYMENT_PROVIDER: 'manual_transfer', PAYMENT_RECONCILIATION_ENABLED: 'false', PAYMENT_REFUND_ENABLED: 'false',
    MODEL_RELAY_API_KEY: '', VIDEO_MODEL_RELAY_API_KEY: '', PLUGIN_WRITE_ENABLED: 'false',
    MERCHANT_TEST_APPROVED_RATES: 'true', OPS_ALERT_NOTIFICATIONS_ENABLED: 'false',
  }
}
export interface BrowserCandidate {
  mode: 'candidate' | 'external'
  sha: string
  releaseId: string
  merchantUrl: string
  opsUrl: string
  project?: string
  apiImage?: string
  opsImage?: string
  migrationImage?: string
  ports: number[]
  env: Environment
}

export function candidateConfiguration(source: Environment, sha: string, ports: number[], nonce: string): BrowserCandidate {
  const mode = source.BROWSER_STACK_MODE ?? 'candidate'
  if (mode !== 'candidate' && mode !== 'external') throw new Error('BROWSER_STACK_MODE must be candidate or external')
  const expectedSha = mode === 'external' ? source.BROWSER_EXPECTED_RELEASE_GIT_SHA : sha
  if (!expectedSha || !/^[0-9a-f]{40}$/u.test(expectedSha)) throw new Error('a full BROWSER_EXPECTED_RELEASE_GIT_SHA is required')
  if (mode === 'external') {
    const releaseId = source.BROWSER_EXPECTED_RELEASE_ID
    if (!releaseId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(releaseId)) throw new Error('BROWSER_EXPECTED_RELEASE_ID is required in external mode')
    if (!source.MERCHANT_STUDIO_URL || !source.OPS_BASE_URL) throw new Error('external mode requires explicit MERCHANT_STUDIO_URL and OPS_BASE_URL')
    for (const url of [source.MERCHANT_STUDIO_URL, source.OPS_BASE_URL]) {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('browser URLs must be HTTP(S) without credentials')
    }
    return { mode, sha: expectedSha, releaseId, merchantUrl: source.MERCHANT_STUDIO_URL, opsUrl: source.OPS_BASE_URL, ports: [], env: { ...source } }
  }
  if (source.MERCHANT_STUDIO_URL || source.OPS_BASE_URL || source.OPS_CONSOLE_URL) throw new Error('custom browser URLs require explicit BROWSER_STACK_MODE=external')
  if (ports.length !== 5 || new Set(ports).size !== 5 || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535 || [18081, 18082, 8787, 54329, 63799].includes(port))) throw new Error('candidate requires five distinct isolated ports, never the documented tunnel ports')
  if (!/^[a-f0-9]{12}$/u.test(nonce)) throw new Error('candidate nonce must be 12 lowercase hex characters')
  const key = `${sha.slice(0, 12)}-${nonce}`
  const project = `merchant-browser-${key}`
  const releaseId = `browser-${key}`
  const apiImage = `merchant-browser-api:${key}`
  const opsImage = `merchant-browser-ops-ui:${key}`
  const migrationImage = `merchant-browser-migrate:${key}`
  const [ui, ops, api, postgres, redis] = ports
  const merchantUrl = `http://127.0.0.1:${ui}/`
  const opsUrl = `http://127.0.0.1:${ops}/`
  return { mode, sha, releaseId, project, apiImage, opsImage, migrationImage, merchantUrl, opsUrl, ports, env: {
    ...isolatedCandidateEnvironment(source), COMPOSE_PROJECT_NAME: project, LOCAL_API_IMAGE: apiImage, LOCAL_OPS_UI_IMAGE: opsImage,
    BROWSER_MIGRATION_IMAGE: migrationImage,
    LOCAL_UI_PORT: String(ui), LOCAL_OPS_UI_PORT: String(ops), LOCAL_API_PORT: String(api),
    LOCAL_POSTGRES_PORT: String(postgres), LOCAL_REDIS_PORT: String(redis),
    MERCHANT_STUDIO_URL: merchantUrl, OPS_BASE_URL: opsUrl,
    RELEASE_ID: releaseId, RELEASE_GIT_SHA: sha,
  } }
}

export function assertProbeIdentity(value: unknown, candidate: BrowserCandidate, kind: 'api' | 'ui', surface?: string): void {
  const object = value as { data?: { release?: { release_git_sha?: string; release_id?: string } }; release_git_sha?: string; release_id?: string; surface?: string }
  const identity = kind === 'api' ? object?.data?.release : object
  if (identity?.release_git_sha !== candidate.sha || identity?.release_id !== candidate.releaseId || (kind === 'ui' && object?.surface !== surface)) throw new Error(`${surface ?? 'API'} candidate identity mismatch: expected ${candidate.sha}/${candidate.releaseId}`)
}

export function assertLocalDockerEndpoint(endpoint: string): void {
  if (!endpoint.startsWith('unix://') && !endpoint.startsWith('npipe://')) throw new Error('browser candidate refuses remote Docker endpoints; 101 must never be a QA target')
}

export function assertCandidateGitState(dirtyTracked: boolean, mergeInProgress: boolean, untrackedSource: boolean): void {
  if (dirtyTracked || mergeInProgress || untrackedSource) throw new Error('candidate requires a clean tracked worktree, no MERGE_HEAD and no uncommitted source files; owner must freeze a commit before browser QA')
}

async function allocatePorts(): Promise<number[]> {
  const servers = Array.from({ length: 5 }, () => createServer())
  try {
    await Promise.all(servers.map(server => new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })))
    return servers.map(server => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('port allocation failed'); return address.port })
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(accept => server.close(() => accept()))))
  }
}

async function portOccupied(port: number): Promise<boolean> {
  return new Promise(accept => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (occupied: boolean) => { socket.destroy(); accept(occupied) }
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(500, () => finish(false))
  })
}

export async function assertUnoccupiedPorts(ports: number[]): Promise<void> {
  for (const port of ports) if (await portOccupied(port)) throw new Error(`candidate port ${port} is already occupied; refusing to reuse any listener`)
}

export function assertContainerOwnership(inspected: { Config: { Labels: Record<string, string>; Image: string } }, candidate: BrowserCandidate, service: string): void {
  if (inspected.Config.Labels['com.docker.compose.project'] !== candidate.project || inspected.Config.Labels['com.docker.compose.service'] !== service) throw new Error(`candidate service ${service} has incorrect Compose ownership labels`)
  const expectedImage = service === 'api' ? candidate.apiImage : service === 'ops-ui' ? candidate.opsImage : service === 'migrate' ? candidate.migrationImage : service === 'postgres' ? CANDIDATE_POSTGRES_IMAGE : undefined
  if (expectedImage && inspected.Config.Image !== expectedImage) throw new Error(`candidate service ${service} has incorrect image tag`)
}

export function candidateComposeArgs(candidate: BrowserCandidate): string[] {
  if (candidate.mode !== 'candidate' || !candidate.project) throw new Error('external mode must never render or start candidate Compose')
  return ['compose', '-p', candidate.project, '-f', 'infra/local/docker-compose.yml', '-f', 'infra/local/docker-compose.browser-candidate.yml', '--env-file', '/dev/null']
}

export function assertCandidateComposeRender(rendered: { services?: Record<string, { image?: string; volumes?: Array<{ type?: string }> }> }, candidate: BrowserCandidate): void {
  for (const service of candidateServices) {
    const config = rendered.services?.[service]
    if (!config) throw new Error(`candidate Compose is missing ${service}`)
    if (config.volumes?.some(volume => volume.type !== 'volume')) throw new Error(`candidate ${service} refuses host bind or unclassified mounts`)
  }
  const postgres = rendered.services?.postgres
  const migrate = rendered.services?.migrate
  if (!postgres || !migrate || postgres.image !== CANDIDATE_POSTGRES_IMAGE || migrate.image !== candidate.migrationImage || migrate.volumes?.length) throw new Error('candidate requires pinned PG17 and built migration artifacts without runtime mounts')
}

export function assertContainerHealthy(inspected: { State?: { Running?: boolean; Health?: { Status?: string } } }, service: string): void {
  if (!inspected.State?.Running || inspected.State.Health?.Status !== 'healthy') throw new Error(`candidate service ${service} is not running and healthy`)
}

export function assertMigrationCompleted(inspected: { Config: { Labels: Record<string, string>; Image: string }; State?: { Running?: boolean; ExitCode?: number; Status?: string } }, candidate: BrowserCandidate): void {
  assertContainerOwnership(inspected, candidate, 'migrate')
  if (inspected.State?.Running || inspected.State?.Status !== 'exited' || inspected.State?.ExitCode !== 0) throw new Error('candidate built migration artifacts did not complete successfully')
}

async function command(binary: string, args: string[], env: Environment): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(binary, args, { env, stdio: 'inherit', detached: process.platform !== 'win32' })
    activeChildren.add(child)
    child.once('error', reject)
    child.once('exit', code => { activeChildren.delete(child); code === 0 ? accept() : reject(new Error(`${binary} exited with ${code}`)) })
  })
}

export async function verifyBrowserIdentity(candidate: BrowserCandidate, signal?: AbortSignal): Promise<void> {
  // The local browser candidate is fronted by the UI proxy and exposes the
  // API probe below `/api/releasez`; the deployed ECS gateway exposes the
  // canonical release probe at the public root `/releasez`. Keep the two
  // paths explicit so external production QA does not parse the UI index as
  // JSON and fail before any browser interaction starts.
  const releaseUrl = (base: string) => candidate.mode === 'external'
    ? new URL('/releasez', base).href
    : new URL('api/releasez', base).href
  const buildMetaUrl = (base: string, surface: 'merchant-ui' | 'ops-ui') => candidate.mode === 'external' && surface === 'ops-ui'
    ? new URL('/ops/build-meta.json', base).href
    : new URL('build-meta.json', base).href
  const probes: Array<[string, 'api' | 'ui', string?]> = [
    [releaseUrl(candidate.merchantUrl), 'api'],
    [releaseUrl(candidate.opsUrl), 'api'],
    [buildMetaUrl(candidate.merchantUrl, 'merchant-ui'), 'ui', 'merchant-ui'],
    [buildMetaUrl(candidate.opsUrl, 'ops-ui'), 'ui', 'ops-ui'],
  ]
  if (candidate.mode === 'candidate') probes.push([`http://127.0.0.1:${candidate.env.LOCAL_API_PORT}/releasez`, 'api'])
  for (const [url, kind, surface] of probes) {
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000), cache: 'no-store' })
    if (!response.ok) throw new Error(`candidate probe failed: ${url} (${response.status})`)
    assertProbeIdentity(await response.json(), candidate, kind, surface)
  }
}

export async function ensureBrowserCandidate(candidate: BrowserCandidate, onStartup?: () => void, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (candidate.mode === 'external') { await verifyBrowserIdentity(candidate, signal); return }
  const dockerContext = execFileSync('docker', ['context', 'show'], { env: candidate.env, encoding: 'utf8' }).trim()
  const dockerEndpoint = JSON.parse(execFileSync('docker', ['context', 'inspect', dockerContext, '--format', '{{json .Endpoints.docker.Host}}'], { env: candidate.env, encoding: 'utf8' }).trim()) as string
  assertLocalDockerEndpoint(dockerEndpoint)
  if (candidate.env.DOCKER_HOST) assertLocalDockerEndpoint(candidate.env.DOCKER_HOST)
  // Pin the checked local context for startup, inspection and exact-ID cleanup.
  candidate.env.DOCKER_CONTEXT = dockerContext
  await assertUnoccupiedPorts(candidate.ports)
  const args = candidateComposeArgs(candidate)
  const rendered = JSON.parse(execFileSync('docker', [...args, 'config', '--format', 'json'], { env: candidate.env, encoding: 'utf8' }))
  assertCandidateComposeRender(rendered, candidate)
  signal?.throwIfAborted()
  onStartup?.()
  await command('docker', [...args, 'up', '-d', '--build', '--force-recreate', '--wait', '--wait-timeout', '180', 'api', 'ui', 'ops-ui'], candidate.env)
  for (const service of ['api', 'ui', 'ops-ui', 'postgres', 'redis']) {
    const id = execFileSync('docker', [...args, 'ps', '-q', service], { env: candidate.env, encoding: 'utf8' }).trim()
    if (!id || id.includes('\n')) throw new Error(`candidate service ${service} must resolve to exactly one container`)
    const inspected = JSON.parse(execFileSync('docker', ['inspect', id], { env: candidate.env, encoding: 'utf8' }))[0] as { Config: { Labels: Record<string, string>; Image: string }; State: { Running: boolean; Health?: { Status: string } } }
    assertContainerOwnership(inspected, candidate, service)
    assertContainerHealthy(inspected, service)
  }
  const migrationId = execFileSync('docker', [...args, 'ps', '-a', '-q', 'migrate'], { env: candidate.env, encoding: 'utf8' }).trim()
  if (!migrationId || migrationId.includes('\n')) throw new Error('candidate must resolve exactly one migration container')
  assertMigrationCompleted(JSON.parse(execFileSync('docker', ['inspect', migrationId], { env: candidate.env, encoding: 'utf8' }))[0], candidate)
  let lastError: unknown
  for (let attempt = 0; attempt < 30; attempt += 1) {
    signal?.throwIfAborted()
    try {
      await verifyBrowserIdentity(candidate, signal)
      const healthResponse = await fetch(`http://127.0.0.1:${candidate.env.LOCAL_API_PORT}/healthz`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000) })
      const health = await healthResponse.json() as { data?: { status?: string; persistence?: { mode?: string; ready?: boolean }; redis?: { ready?: boolean } } }
      if (!healthResponse.ok || health.data?.status !== 'ok' || health.data.persistence?.mode !== 'postgres' || !health.data.persistence.ready || !health.data.redis?.ready) throw new Error('candidate API health is unavailable or durable dependencies are not ready')
      console.log(`Verified healthy browser candidate ${candidate.sha}/${candidate.releaseId}: ${candidate.merchantUrl} ${candidate.opsUrl}`); return
    } catch (error) { lastError = error }
    await new Promise(accept => setTimeout(accept, 1_000))
  }
  throw lastError
}

export interface CleanupDocker {
  list(project: string, env: Environment): Promise<string[]>
  inspect(id: string, env: Environment): Promise<{ Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean } }>
  stop(id: string, env: Environment): Promise<void>
}
const cleanupDocker: CleanupDocker = {
  async list(project, env) { return execFileSync('docker', ['ps', '-a', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '-q'], { env, encoding: 'utf8' }).trim().split('\n').filter(Boolean) },
  async inspect(id, env) { return JSON.parse(execFileSync('docker', ['inspect', id], { env, encoding: 'utf8' }))[0] },
  async stop(id, env) { await new Promise<void>((accept, reject) => { const child = spawn('docker', ['stop', '--time', '10', id], { env, stdio: 'ignore' }); child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error('exact candidate container stop failed'))) }) },
}

export async function cleanupBrowserCandidate(candidate: BrowserCandidate, docker: CleanupDocker = cleanupDocker): Promise<{ stopped: string[]; leftRunning: string[]; failures: string[]; volumesRetained: true }> {
  const evidence = { stopped: [] as string[], leftRunning: [] as string[], failures: [] as string[], volumesRetained: true as const }
  if (candidate.mode !== 'candidate') return evidence
  let ids: string[]
  try { ids = await docker.list(candidate.project!, candidate.env) } catch { evidence.leftRunning.push('unknown: enumeration failed'); evidence.failures.push('candidate container enumeration failed'); return evidence }
  await Promise.all(ids.map(async id => {
    try {
      const inspected = await docker.inspect(id, candidate.env)
      if (!/^[0-9a-f]{64}$/u.test(id) || inspected.Id !== id || inspected.Config.Labels['com.docker.compose.project'] !== candidate.project || !candidateServices.includes(inspected.Config.Labels['com.docker.compose.service'] ?? '')) throw new Error('candidate cleanup refused unverified container ownership')
      if (!inspected.State.Running) return
      await docker.stop(id, candidate.env)
      if ((await docker.inspect(id, candidate.env)).State.Running) { evidence.leftRunning.push(id); evidence.failures.push('candidate container remains running') } else evidence.stopped.push(id)
    } catch { evidence.leftRunning.push(id); evidence.failures.push(`candidate cleanup could not safely stop ${id}`) }
  }))
  return evidence
}

async function main(): Promise<void> {
  const mode = process.env.BROWSER_STACK_MODE ?? 'candidate'
  const sha = mode === 'external' ? '' : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (mode === 'candidate') {
    const buildPaths = ['package.json', 'package-lock.json', 'tsconfig.json', 'apps', 'packages', 'services', 'tests', 'demo', 'scripts', 'infra']
    const dirtyTracked = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim())
    const mergeHead = execFileSync('git', ['rev-parse', '--git-path', 'MERGE_HEAD'], { encoding: 'utf8' }).trim()
    const untrackedSource = Boolean(execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...buildPaths], { encoding: 'utf8' }).trim())
    assertCandidateGitState(dirtyTracked, existsSync(mergeHead), untrackedSource)
  }
  const candidate = candidateConfiguration(process.env, sha, mode === 'candidate' ? await allocatePorts() : [], randomBytes(6).toString('hex'))
  const controller = new AbortController()
  let startupAttempted = false
  const interrupt = (signal: NodeJS.Signals) => {
    controller.abort(new Error(`browser candidate interrupted by ${signal}`))
    process.exitCode = signal === 'SIGINT' ? 130 : 143
    for (const child of activeChildren) {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch { /* already exited */ }
    }
  }
  const onInt = () => interrupt('SIGINT'); const onTerm = () => interrupt('SIGTERM')
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  try {
    await ensureBrowserCandidate(candidate, () => { startupAttempted = true }, controller.signal)
    controller.signal.throwIfAborted()
    if (process.argv.includes('--ensure')) return
    const extraArgs = process.argv.slice(2)
    await command('npm', ['exec', '--', 'playwright', 'test', 'dogfood/chatgpt-all-functions/merchant-all.spec.js', 'dogfood/chatgpt-all-functions/merchant-interactions.spec.js', 'dogfood/chatgpt-all-functions/merchant.spec.js', 'dogfood/chatgpt-all-functions/merchant-data-safety.spec.js', '--workers=1', ...extraArgs], candidate.env)
  } finally {
    if (startupAttempted) {
      const evidence = await cleanupBrowserCandidate(candidate)
      console.log(JSON.stringify({ browserCandidateCleanup: { project: candidate.project, releaseId: candidate.releaseId, ...evidence } }))
      if (evidence.failures.length) process.exitCode = process.exitCode || 1
    }
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = process.exitCode || 1 })
