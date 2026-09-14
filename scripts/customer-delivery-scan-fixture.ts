import { execFile } from 'node:child_process'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createClamAvScanner, type ClamAvScanResult } from '../apps/worker/src/clamav-scanner.js'
import { EICAR_SELF_TEST_BYTES } from '../apps/worker/src/scanner-heartbeat.js'
import { assertClamAvExecutionAdmission } from '../packages/workers/src/scanner-heartbeat.js'
import { isolatedFixtureSpawnEnvironment, type IsolatedOpsFixture } from '../tests/isolated-ops-fixture.js'

export const CUSTOMER_DELIVERY_CLAMAV_IMAGE = 'clamav/clamav-debian@sha256:bcfc3d6117a6cfbeb6cd041c00164097916291b870c6183e06def6fed7fb740b'
const PURPOSE = 'isolated-customer-delivery-real-scan'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const ID = /^[a-f0-9]{64}$/u
const DEFINITIONS_MAX_AGE_SECONDS = 86_400
const MINIMUM_DEFINITIONS_VERSION = 28_000
const CLEAN_PROBE = Buffer.from('Merchant isolated real ClamAV readiness probe.\n', 'utf8')
const STARTUP_DIAGNOSTIC_MAX_CHARS = 16_384

export type ScanContainerIdentity = { id: string; name: string; runId: string; image: string }
export type ScanContainerInspection = {
  id: string; name: string; image: string; labels: Record<string, string> | null
  autoRemove: boolean; running: boolean; mounts: { Type: string; Destination: string }[]
  tmpfs: Record<string, string> | null
  ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null
}
export type ScanContainerEvidence = ScanContainerIdentity & { hostPort: number; dataStorage: 'ephemeral-container-layer'; autoRemove: true }
export type ScanDisposal = { stopped: string[]; leftRunning: { id: string; reason: string }[] }
export type ScanStartupState = { running: boolean; status: string; exitCode: number; oomKilled: boolean }
export type ScanStartupDiagnostics = { containerId?: string; state?: ScanStartupState; logs?: string; failures: string[] }
export type ScanReadinessEvidence = {
  observedAt: string; rawVersion: string; engineVersion: string; definitionsVersion: string
  definitionsPublishedAt: string; definitionsAgeSeconds: number; cleanProbe: 'clean'; eicarSignature: 'Eicar-Test-Signature'
}
export type ScanEnvironmentBindings = { fixture: IsolatedOpsFixture; apiBaseUrl: string; apiPort: number }
export type ScanEnvironments = { apiEnvironment: NodeJS.ProcessEnv; workerEnvironment: NodeJS.ProcessEnv }
export interface CustomerDeliveryScanFixture {
  runId: string
  evidenceDir: string
  container: ScanContainerEvidence
  readiness: ScanReadinessEvidence
  /** Contains generated secrets: pass to child processes only; do not serialize. */
  prepareEnvironment(bindings: ScanEnvironmentBindings): ScanEnvironments
  stop(): Promise<ScanDisposal>
}

function fail(code: string): never { throw new Error(`CUSTOMER_DELIVERY_SCAN_${code}`) }

export function customerDeliveryScanTimeout(value = 120_000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) fail('TIMEOUT_INVALID')
  return value
}

export function customerDeliveryScanRunPlan(input: { runId: string; evidenceDir: string }) {
  if (!UUID.test(input.runId) || !isAbsolute(input.evidenceDir) || /[\u0000-\u001f\u007f]/u.test(input.evidenceDir)) fail('IDENTITY_INVALID')
  const name = `merchant-delivery-scan-${input.runId}`
  const cidFile = join(input.evidenceDir, 'container.id')
  // Do not mount /var/lib/clamav: keep genuine definitions in a disposable
  // layer. /init initializes directories/config before executing this command.
  // Update once before loading clamd: running both concurrently loads multiple
  // databases and caused an observed OOM on the isolated acceptance host.
  // No inherited volume, credentials, Docker network or proxy configuration.
  return { name, cidFile, args: ['run', '--detach', '--rm', '--pull=never', '--name', name, '--cidfile', cidFile,
    '--label', `merchant.fixture.purpose=${PURPOSE}`, '--label', `merchant.fixture.run-id=${input.runId}`,
    '--label', 'merchant.fixture.kind=clamav', '--network', 'bridge', '--publish', '127.0.0.1::3310',
    '--tmpfs', '/tmp:rw,nosuid,size=256m', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '256', '--memory', '4g', '--cpus', '2', CUSTOMER_DELIVERY_CLAMAV_IMAGE,
    'sh', '-c', 'freshclam --foreground --stdout && exec clamd --foreground'] }
}

export function verifyCustomerDeliveryScanContainer(actual: ScanContainerInspection, expected: ScanContainerIdentity): ScanContainerEvidence {
  const port = actual.ports?.['3310/tcp']
  if (!UUID.test(expected.runId) || !ID.test(expected.id) || expected.name !== `merchant-delivery-scan-${expected.runId}`
    || expected.image !== CUSTOMER_DELIVERY_CLAMAV_IMAGE || actual.id !== expected.id || actual.name !== `/${expected.name}` || actual.image !== expected.image
    || actual.labels?.['merchant.fixture.purpose'] !== PURPOSE || actual.labels?.['merchant.fixture.run-id'] !== expected.runId
    || actual.labels?.['merchant.fixture.kind'] !== 'clamav' || actual.autoRemove !== true || actual.running !== true
    || !Array.isArray(actual.mounts) || actual.mounts.some(mount => mount.Type !== 'tmpfs' || mount.Destination !== '/tmp')
    || !actual.tmpfs || Object.keys(actual.tmpfs).length !== 1 || !Object.hasOwn(actual.tmpfs, '/tmp')
    || port?.length !== 1 || port[0]?.HostIp !== '127.0.0.1' || !/^\d+$/u.test(port[0]?.HostPort ?? '')
    || Number(port[0]?.HostPort) < 1 || Number(port[0]?.HostPort) > 65_535
    || Object.entries(actual.ports ?? {}).some(([key, value]) => key !== '3310/tcp' && value != null)) fail('CONTAINER_IDENTITY_MISMATCH')
  return { ...expected, hostPort: Number(port[0]!.HostPort), dataStorage: 'ephemeral-container-layer', autoRemove: true }
}

export async function disposeCustomerDeliveryScanContainer(expected: ScanContainerIdentity, operations: {
  inspect(): Promise<ScanContainerInspection>; stop(id: string): Promise<void>
}): Promise<ScanDisposal> {
  try {
    verifyCustomerDeliveryScanContainer(await operations.inspect(), expected)
    await operations.stop(expected.id)
    return { stopped: [expected.id], leftRunning: [] }
  } catch {
    return { stopped: [], leftRunning: [{ id: expected.id, reason: 'Exact-ID ownership/stop unconfirmed; no name, label or broad cleanup fallback was attempted.' }] }
  }
}

export function unidentifiedCustomerDeliveryScanDisposal(creationStarted: boolean): ScanDisposal {
  return { stopped: [], leftRunning: creationStarted ? [{ id: 'unconfirmed', reason: 'Docker creation was attempted without recoverable exact-ID evidence; manual review required, no name-based cleanup attempted.' }] : [] }
}

/** Treat container output as untrusted. Redact before truncation, and never
 * preserve raw URL credentials, query strings, authorization or secret fields. */
export function sanitizeCustomerDeliveryScanLogs(raw: string): string {
  let text = raw.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[redacted-private-key]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu, value => {
      try {
        const url = new URL(value)
        return `${url.protocol}//${url.username || url.password ? '[redacted]@' : ''}${url.host}${url.pathname}${url.search ? '?[redacted]' : ''}${url.hash ? '#[redacted]' : ''}`
      } catch { return '[redacted-url]' }
    })
    .replace(/^.*\b(?:proxy[-_])?authorization["']?\s*[:=].*$/gimu, '[redacted-authorization]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [redacted]')
    .replace(/(["']?[A-Za-z0-9_.-]{0,128}(?:authorization|token|api[-_]?key|password|passwd|secret|credential|signature)[A-Za-z0-9_.-]{0,128}["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;]+)/giu, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted-jwt]')
  text = text.split('\n').slice(-100).join('\n')
  return text.length > STARTUP_DIAGNOSTIC_MAX_CHARS ? `${text.slice(0, STARTUP_DIAGNOSTIC_MAX_CHARS - 11)}[truncated]` : text
}

export function projectCustomerDeliveryScanState(value: unknown): ScanStartupState {
  const state = value as Partial<ScanStartupState> | null
  if (!state || typeof state !== 'object' || typeof state.running !== 'boolean' || typeof state.oomKilled !== 'boolean'
    || !Number.isSafeInteger(state.exitCode) || state.exitCode! < 0 || state.exitCode! > 255
    || !['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(state.status ?? '')) fail('DIAGNOSTIC_STATE_INVALID')
  return { running: state.running, status: state.status!, exitCode: state.exitCode!, oomKilled: state.oomKilled }
}

/** The caller passes identity only after the full container isolation check.
 * Recheck identity before logs; state may now be exited/OOM and is read-only.
 * All failures are fixed codes, never native errors or raw daemon output. */
export async function collectCustomerDeliveryScanStartupDiagnostics(verified: ScanContainerIdentity | undefined, operations: {
  inspect(id: string): Promise<unknown>; logs(id: string): Promise<string>
}): Promise<ScanStartupDiagnostics> {
  const result: ScanStartupDiagnostics = { failures: [] }
  if (!verified || !ID.test(verified.id) || !UUID.test(verified.runId) || verified.image !== CUSTOMER_DELIVERY_CLAMAV_IMAGE
    || verified.name !== `merchant-delivery-scan-${verified.runId}`) return { failures: ['OWNERSHIP_NOT_VERIFIED'] }
  try {
    const value = await operations.inspect(verified.id) as { id?: unknown; name?: unknown; image?: unknown; labels?: Record<string, unknown>; state?: unknown } | null
    if (!value || value.id !== verified.id || value.name !== `/${verified.name}` || value.image !== verified.image
      || value.labels?.['merchant.fixture.purpose'] !== PURPOSE || value.labels?.['merchant.fixture.run-id'] !== verified.runId
      || value.labels?.['merchant.fixture.kind'] !== 'clamav') return { failures: ['OWNERSHIP_NOT_VERIFIED'] }
    result.containerId = verified.id
    try { result.state = projectCustomerDeliveryScanState(value.state) } catch { result.failures.push('STATE_UNAVAILABLE') }
  } catch { return { failures: ['INSPECTION_UNAVAILABLE'] } }
  try { result.logs = sanitizeCustomerDeliveryScanLogs(await operations.logs(verified.id)) }
  catch { result.failures.push('LOGS_UNAVAILABLE') }
  return result
}

export function validateCustomerDeliveryScanReadiness(input: {
  version: string; clean: ClamAvScanResult; eicar: ClamAvScanResult; observedAt?: Date
}): ScanReadinessEvidence {
  const observedAt = input.observedAt ?? new Date()
  let evidence: ReturnType<typeof assertClamAvExecutionAdmission>
  try { evidence = assertClamAvExecutionAdmission(input.version, { now: observedAt, definitionsMaxAgeSeconds: DEFINITIONS_MAX_AGE_SECONDS }) }
  catch { return fail('DEFINITIONS_NOT_CURRENT') }
  // Date.UTC normalizes invalid dates; reject those rather than accepting a
  // malformed VERSION whose normalized timestamp happens to be recent.
  const parts = /\/([A-Za-z]{3} )?([A-Za-z]{3}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(input.version)
  const date = new Date(evidence.definitionsPublishedAt!)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  if (!parts || date.getUTCMonth() !== months.indexOf(parts[2]!) || date.getUTCDate() !== Number(parts[3])
    || date.getUTCHours() !== Number(parts[4]) || date.getUTCMinutes() !== Number(parts[5]) || date.getUTCSeconds() !== Number(parts[6])
    || date.getUTCFullYear() !== Number(parts[7]) || !Number.isSafeInteger(Number(evidence.definitionsVersion))
    || Number(evidence.definitionsVersion) < MINIMUM_DEFINITIONS_VERSION) fail('VERSION_INVALID')
  if (input.clean.status !== 'clean' || input.clean.target !== 'stream' || input.clean.raw !== 'stream: OK') fail('CLEAN_PROBE_FAILED')
  if (input.eicar.status !== 'infected' || input.eicar.target !== 'stream' || input.eicar.signature !== 'Eicar-Test-Signature') fail('EICAR_PROBE_FAILED')
  return { observedAt: observedAt.toISOString(), rawVersion: input.version, engineVersion: evidence.engineVersion!,
    definitionsVersion: evidence.definitionsVersion!, definitionsPublishedAt: evidence.definitionsPublishedAt!,
    definitionsAgeSeconds: evidence.definitionsAgeSeconds!, cleanProbe: 'clean', eicarSignature: 'Eicar-Test-Signature' }
}

export function validateCustomerDeliveryScanBindings(input: ScanEnvironmentBindings): void {
  const { fixture } = input
  if (!UUID.test(fixture.runId) || fixture.workspaceId !== `ws_ops_fixture_${fixture.runId.replaceAll('-', '')}`) fail('FIXTURE_BINDING_INVALID')
  for (const [kind, value, protocol, username, pathname] of [
    ['postgres', fixture.databaseUrl, 'postgres:', 'merchant_app', '/merchant'],
    ['redis', fixture.redisUrl, 'redis:', '', '/0'],
  ] as const) {
    const candidates = fixture.containerEvidence.filter(item => item.kind === kind)
    const item = candidates[0]
    let url: URL
    try { url = new URL(value) } catch { return fail('FIXTURE_ENDPOINT_INVALID') }
    if (candidates.length !== 1 || !item || item.runId !== fixture.runId || !ID.test(item.id) || item.autoRemove !== true || item.dataStorage !== 'tmpfs'
      || item.name !== `merchant-ops-fixture-${kind}-${fixture.runId}` || !Number.isSafeInteger(item.hostPort) || item.hostPort < 1 || item.hostPort > 65_535
      || item.labels['merchant.fixture.purpose'] !== 'isolated-ops-oidc-acceptance' || item.labels['merchant.fixture.run-id'] !== fixture.runId
      || item.labels['merchant.fixture.kind'] !== kind || url.protocol !== protocol || url.hostname !== '127.0.0.1'
      || url.port !== String(item.hostPort) || url.username !== username || !url.password || url.pathname !== pathname || url.search || url.hash) fail('FIXTURE_ENDPOINT_INVALID')
  }
  let api: URL
  try { api = new URL(input.apiBaseUrl) } catch { return fail('API_ENDPOINT_INVALID') }
  if (!Number.isSafeInteger(input.apiPort) || input.apiPort < 1 || input.apiPort > 65_535
    || api.protocol !== 'http:' || api.hostname !== '127.0.0.1' || api.port !== String(input.apiPort)
    || api.username || api.password || api.search || api.hash || api.pathname !== '/') fail('API_ENDPOINT_INVALID')
}

async function localSocket(): Promise<string> {
  const candidates = ['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock'), join(homedir(), '.colima/default/docker.sock'), join(homedir(), '.orbstack/run/docker.sock')]
  const available: string[] = []
  for (const candidate of candidates) { try { if ((await stat(candidate)).isSocket()) available.push(candidate) } catch { /* absent */ } }
  if (available.length !== 1) fail('LOCAL_DOCKER_SOCKET_AMBIGUOUS_OR_MISSING')
  return available[0]!
}

/** Default-off. No Docker or filesystem action happens unless enabled is true.
 * Startup is bounded to at most 120 seconds, followed by bounded owned cleanup.
 * This starts only ClamAV. The owner launches the real API/worker/browser and
 * must retain their event, signed-receipt and download-gate evidence separately. */
export async function startCustomerDeliveryScanFixture(input: {
  enabled?: boolean; evidenceDir?: string; startupTimeoutMs?: number; signal?: AbortSignal
} = {}): Promise<CustomerDeliveryScanFixture | undefined> {
  if (input.enabled !== true) return undefined
  const timeout = customerDeliveryScanTimeout(input.startupTimeoutMs)
  if (!input.evidenceDir || !isAbsolute(input.evidenceDir) || /[\u0000-\u001f\u007f]/u.test(input.evidenceDir)) fail('EVIDENCE_DIRECTORY_INVALID')
  if (input.signal?.aborted) fail('ABORTED')
  const deadline = Date.now() + timeout
  const runId = randomUUID()
  await mkdir(input.evidenceDir, { recursive: true, mode: 0o700 })
  const evidenceDir = await mkdtemp(join(resolve(input.evidenceDir), 'customer-delivery-scanner-'))
  const dockerConfig = join(evidenceDir, 'docker-client')
  await mkdir(dockerConfig, { mode: 0o700 })
  const plan = customerDeliveryScanRunPlan({ runId, evidenceDir })
  const socket = await localSocket()
  const remaining = () => { input.signal?.throwIfAborted(); const value = deadline - Date.now(); if (value <= 0) fail('STARTUP_TIMEOUT'); return value }
  const docker = (args: string[], cleanup = false, diagnostics = false): Promise<string> => new Promise((done, reject) => {
    execFile('docker', ['--host', `unix://${socket}`, '--config', dockerConfig, ...args], {
      env: isolatedFixtureSpawnEnvironment(), timeout: diagnostics ? 5_000 : cleanup ? 20_000 : Math.min(20_000, remaining()),
      killSignal: 'SIGKILL', ...(cleanup ? {} : { signal: input.signal }), maxBuffer: 1024 * 1024, encoding: 'utf8',
    }, (error, stdout, stderr) => { if (error) reject(new Error(`CUSTOMER_DELIVERY_SCAN_DOCKER_${args[0]?.toUpperCase() ?? 'COMMAND'}_FAILED`)); else done(args[0] === 'logs' ? `${stdout}\n${stderr}` : stdout.trim()) })
  })
  let owned: ScanContainerIdentity | undefined
  let verifiedOwned: ScanContainerIdentity | undefined
  let creationStarted = false
  const inspect = (cleanup = false) => docker(['inspect', '--format', '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"autoRemove":{{json .HostConfig.AutoRemove}},"running":{{json .State.Running}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}},"ports":{{json .NetworkSettings.Ports}}}', owned!.id], cleanup).then(value => JSON.parse(value) as ScanContainerInspection)
  let disposal: Promise<ScanDisposal> | undefined
  const stop = () => disposal ??= (async () => {
    const result = owned ? await disposeCustomerDeliveryScanContainer(owned, { inspect: () => inspect(true), stop: async id => { await docker(['stop', '--time', '10', id], true) } })
      : unidentifiedCustomerDeliveryScanDisposal(creationStarted)
    await writeFile(join(evidenceDir, 'disposal.json'), JSON.stringify({ runId, ...result, sharedContainersTouched: false, evidenceRetained: true }, null, 2), { mode: 0o600, flag: 'wx' })
    return result
  })()
  try {
    const image = JSON.parse(await docker(['image', 'inspect', '--format', '{"digests":{{json .RepoDigests}},"volumes":{{json (index .Config "Volumes")}}}', CUSTOMER_DELIVERY_CLAMAV_IMAGE])) as { digests?: unknown; volumes?: unknown }
    if (!Array.isArray(image.digests) || !image.digests.includes(CUSTOMER_DELIVERY_CLAMAV_IMAGE) || image.volumes && Object.keys(image.volumes).length > 0) fail('PINNED_IMAGE_INVALID')
    creationStarted = true
    const id = await docker(plan.args)
    if (!ID.test(id)) fail('CREATED_CONTAINER_ID_INVALID')
    owned = { id, name: plan.name, runId, image: CUSTOMER_DELIVERY_CLAMAV_IMAGE }
    const container = verifyCustomerDeliveryScanContainer(await inspect(), owned)
    verifiedOwned = { ...owned }
    let readiness: ScanReadinessEvidence | undefined
    let lastProbeCode = 'STARTUP_TIMEOUT'
    while (Date.now() < deadline) {
      try {
        const scanner = () => createClamAvScanner({ host: '127.0.0.1', port: container.hostPort, timeoutMs: Math.min(3_000, remaining()) })
        await scanner().ping()
        const version = await scanner().version()
        const clean = await scanner().scan(CLEAN_PROBE)
        const eicar = await scanner().scan(EICAR_SELF_TEST_BYTES)
        remaining()
        readiness = validateCustomerDeliveryScanReadiness({ version, clean, eicar })
        break
      } catch (error) {
        input.signal?.throwIfAborted()
        const message = error instanceof Error ? error.message : ''
        lastProbeCode = /^CUSTOMER_DELIVERY_SCAN_[A-Z_]+$/u.test(message) ? message : 'CUSTOMER_DELIVERY_SCAN_CLAMAV_NOT_READY'
        if (Date.now() < deadline) await new Promise(done => setTimeout(done, Math.min(250, deadline - Date.now())))
      }
    }
    if (!readiness) throw new Error(`CUSTOMER_DELIVERY_SCAN_STARTUP_TIMEOUT:${lastProbeCode}`)
    if (verifyCustomerDeliveryScanContainer(await inspect(), owned).hostPort !== container.hostPort) fail('CONTAINER_ENDPOINT_CHANGED')
    await writeFile(join(evidenceDir, 'readiness.json'), JSON.stringify({ runId, container, readiness, scanner: 'real-clamav', sharedConfigurationRead: false, fixtureScanVerdictsUsed: false }, null, 2), { mode: 0o600, flag: 'wx' })
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const scannerToken = randomBytes(32).toString('hex'), scannerSecret = randomBytes(32).toString('hex')
    const workerToken = randomBytes(32).toString('hex'), workerSecret = randomBytes(32).toString('hex')
    const keyId = `delivery-scan-${runId}`, serviceId = `delivery-scanner-${runId}`, policy = 'isolated-customer-delivery-real-scan-v1'
    return { runId, evidenceDir, container, readiness, stop, prepareEnvironment(bindings) {
      if (disposal) fail('ALREADY_STOPPED')
      validateCustomerDeliveryScanBindings(bindings)
      const scanEnvironment = { ASSET_SCANNER_MODE: 'clamav_worker', ALLOW_LOCAL_ASSET_SCAN_FIXTURE: 'false',
        ASSET_SCANNER_API_TOKEN: scannerToken, ASSET_SCANNER_WORKSPACE_SIGNING_SECRET: scannerSecret,
        ASSET_SCAN_POLICY_VERSION: policy, ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS: serviceId,
        ASSET_SCAN_MIN_DEFINITIONS_VERSION: String(MINIMUM_DEFINITIONS_VERSION), SCANNER_DEFINITIONS_MAX_AGE_SECONDS: String(DEFINITIONS_MAX_AGE_SECONDS) }
      return {
        apiEnvironment: { ...scanEnvironment, ASSET_SCAN_TRUSTED_PUBLIC_KEYS: JSON.stringify({ [keyId]: publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
          WORKER_API_CREDENTIALS: JSON.stringify({ scan: { token: workerToken, signing_secret: workerSecret } }) },
        workerEnvironment: { ...isolatedFixtureSpawnEnvironment(), ...scanEnvironment, NODE_ENV: 'development',
          DATABASE_URL: bindings.fixture.databaseUrl, REDIS_URL: bindings.fixture.redisUrl, WORKER_ROLE: 'scan',
          WORKER_WORKSPACES: bindings.fixture.workspaceId, WORKER_ID: serviceId, HOSTNAME: serviceId,
          WORKER_API_BASE_URL: new URL(bindings.apiBaseUrl).origin, WORKER_API_TOKEN: workerToken, WORKER_API_SIGNING_SECRET: workerSecret,
          ASSET_SCANNER_SERVICE_ID: serviceId, ASSET_SCAN_RECEIPT_KEY_ID: keyId,
          ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(container.hostPort), ASSET_SCANNER_TIMEOUT_MS: '30000',
          WORKER_READY_FILE: join(evidenceDir, 'worker-ready.json'), WORKER_POLL_INTERVAL_MS: '250', WORKER_BATCH_SIZE: '5',
          SCANNER_HEARTBEAT_INTERVAL_MS: '1000', SCANNER_HEARTBEAT_TTL_SECONDS: '15', SCANNER_MINIMUM_READY_INSTANCES: '1',
        },
      }
    } }
  } catch (error) {
    // A timed-out docker run may still have created the container. Its unique
    // cidfile is the only recovery source; never resolve the generated name.
    if (!owned) {
      try { const id = (await readFile(plan.cidFile, 'utf8')).trim(); if (ID.test(id)) owned = { id, name: plan.name, runId, image: CUSTOMER_DELIVERY_CLAMAV_IMAGE } } catch { /* no exact identity */ }
    }
    try {
      const diagnostics = await collectCustomerDeliveryScanStartupDiagnostics(verifiedOwned, {
        inspect: id => docker(['inspect', '--format', '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"state":{"running":{{json .State.Running}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}}}}', id], true, true).then(value => JSON.parse(value) as unknown),
        logs: id => docker(['logs', '--tail', '100', id], true, true),
      })
      await writeFile(join(evidenceDir, 'startup-diagnostics.json'), JSON.stringify({ runId, ...diagnostics, sharedContainersTouched: false }, null, 2), { mode: 0o600, flag: 'wx' })
    } catch { /* Diagnostics are best effort; even a write failure must not skip owned cleanup. */ }
    const disposed = await stop()
    const message = error instanceof Error && /^CUSTOMER_DELIVERY_SCAN_[A-Z_:]+$/u.test(error.message) ? error.message : 'CUSTOMER_DELIVERY_SCAN_STARTUP_FAILED'
    await writeFile(join(evidenceDir, 'failure.json'), JSON.stringify({ runId, error: message, disposal: disposed, sharedContainersTouched: false }, null, 2), { mode: 0o600, flag: 'wx' })
    throw new Error(`${message}${disposed.leftRunning.length ? ':CLEANUP_REQUIRES_REVIEW' : ''}`)
  }
}

export function prepareCustomerDeliveryScanEnvironment(scanner: CustomerDeliveryScanFixture, bindings: ScanEnvironmentBindings): ScanEnvironments { return scanner.prepareEnvironment(bindings) }
export async function stopCustomerDeliveryScanFixture(scanner: CustomerDeliveryScanFixture | undefined): Promise<ScanDisposal> { return scanner ? scanner.stop() : { stopped: [], leftRunning: [] } }
