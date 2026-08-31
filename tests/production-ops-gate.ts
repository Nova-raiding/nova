import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

type Service = {
  restart?: string
  healthcheck?: { test?: string[]; interval?: string; timeout?: string; retries?: number; start_period?: string }
  logging?: { driver?: string; options?: Record<string, string> }
  stop_grace_period?: string
  depends_on?: Record<string, { condition?: string }>
  environment?: Record<string, string | null> | string[]
  deploy?: { resources?: { limits?: { cpus?: string | number; memory?: string | number }; reservations?: { cpus?: string | number; memory?: string | number } } }
}

type Compose = { services?: Record<string, Service> }

const composeFile = 'infra/local/docker-compose.yml'
const runbookFile = 'doc/todo/release/production-ops-runbook.md'
const otelFile = 'infra/observability/otel-collector.example.yaml'
const alertsFile = 'infra/observability/prometheus-alerts.example.yaml'
const apiManifest = readFileSync('infra/kubernetes/base/api.yaml', 'utf8')
const productionRuntime = readFileSync('infra/kubernetes/base/configmap.yaml', 'utf8')

function compose(): Compose {
  return JSON.parse(execFileSync('docker', ['compose', '-f', composeFile, 'config', '--format', 'json'], { encoding: 'utf8' })) as Compose
}

function env(service: Service): Record<string, string> {
  if (!service.environment) return {}
  if (!Array.isArray(service.environment)) return Object.fromEntries(Object.entries(service.environment).map(([key, value]) => [key, value ?? '']))
  return Object.fromEntries(service.environment.map(item => {
    const separator = item.indexOf('=')
    return separator === -1 ? [item, ''] : [item.slice(0, separator), item.slice(separator + 1)]
  }))
}

function contains(service: Service, pattern: string) {
  return service.healthcheck?.test?.some(value => value.includes(pattern)) === true
}

function productionRuntimeValue(key: string): string | undefined {
  const match = productionRuntime.match(new RegExp(`^\\s+${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))\\s*$`, 'm'))
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

const config = compose()
const services = config.services ?? {}
const workerServices = ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation']
const expectedServices = ['ui', 'api', ...workerServices, 'migrate', 'postgres', 'redis']
for (const name of expectedServices) assert.ok(services[name], `Compose service ${name} is required`)

for (const name of ['ui', 'api', ...workerServices, 'postgres', 'redis']) {
  const service = services[name]!
  assert.equal(service.restart, 'unless-stopped', `${name} must restart after an unplanned process exit`)
  assert.ok(service.healthcheck, `${name} must declare an explicit healthcheck in Compose`)
  assert.ok(service.stop_grace_period, `${name} must declare stop_grace_period`)
  assert.equal(service.logging?.driver, 'json-file', `${name} must use bounded local logging in Compose`)
  assert.equal(service.logging?.options?.['max-size'], '10m', `${name} log max-size must be bounded`)
  assert.equal(service.logging?.options?.['max-file'], '5', `${name} log max-file must be bounded`)
}

assert.equal(services.migrate!.restart, 'no', 'migration service must not restart indefinitely')
assert.ok(contains(services.ui!, '127.0.0.1'), 'UI healthcheck must probe the local HTTP listener')
assert.ok(contains(services.api!, '/readyz'), 'API healthcheck must probe dependency readiness at /readyz')
assert.ok(apiManifest.includes('path: /livez'), 'API liveness must use the dependency-independent /livez probe')
for (const name of workerServices) assert.ok(contains(services[name]!, 'process.kill(1, 0)'), `${name} healthcheck must probe process liveness`)
assert.ok(contains(services.postgres!, 'pg_isready'), 'Postgres readiness check is required')
assert.ok(contains(services.redis!, 'redis-cli'), 'Redis readiness check is required')

for (const dependency of [
  ['ui', 'api', 'service_healthy'],
  ['api', 'migrate', 'service_completed_successfully'],
  ['api', 'postgres', 'service_healthy'],
  ['api', 'redis', 'service_healthy'],
  ...workerServices.flatMap(worker => [[worker, 'migrate', 'service_completed_successfully'], [worker, 'postgres', 'service_healthy'], [worker, 'redis', 'service_healthy']] as const),
  ...workerServices.map(worker => [worker, 'api', 'service_healthy'] as const),
  ['migrate', 'postgres', 'service_healthy'],
] as const) {
  assert.equal(services[dependency[0]]!.depends_on?.[dependency[1]]?.condition, dependency[2], `${dependency[0]} must wait for ${dependency[1]} (${dependency[2]})`)
}

const apiEnv = env(services.api!)
// infra/local is deliberately a development/acceptance Compose stack. The
// production assertions must read the production runtime contract instead of
// treating local-only defaults as a deployment configuration.
assert.equal(productionRuntimeValue('NODE_ENV'), 'production')
assert.equal(productionRuntimeValue('CONNECTOR_FIXTURE_MODE'), 'false')
assert.equal(productionRuntimeValue('PLUGIN_WRITE_ENABLED'), 'false')
assert.ok('OTEL_EXPORTER_OTLP_ENDPOINT' in apiEnv, 'API must expose an OTEL endpoint injection point')
assert.ok(apiEnv.WORKER_API_CREDENTIALS, 'API must expose a role-scoped worker credential map')
const workerCredentials = JSON.parse(apiEnv.WORKER_API_CREDENTIALS) as Record<string, { token: string; signing_secret: string }>
assert.equal(new Set(Object.values(workerCredentials).map(value => value.token)).size, workerServices.length, 'worker role tokens must be distinct')
assert.equal(new Set(Object.values(workerCredentials).map(value => value.signing_secret)).size, workerServices.length, 'worker role signing secrets must be distinct')
for (const name of workerServices) {
  const workerEnv = env(services[name]!)
  assert.ok(workerEnv.WORKER_ROLE, `${name} must declare a worker role`)
  assert.equal(workerEnv.WORKER_API_TOKEN, workerCredentials[workerEnv.WORKER_ROLE!]?.token, `${name} token must match only its role`)
  assert.equal(workerEnv.WORKER_API_SIGNING_SECRET, workerCredentials[workerEnv.WORKER_ROLE!]?.signing_secret, `${name} signing secret must match only its role`)
  assert.equal(workerEnv.WORKER_WORKSPACES, 'auto')
  assert.ok('OTEL_EXPORTER_OTLP_ENDPOINT' in workerEnv, `${name} must expose an OTEL endpoint injection point`)
}

const runbook = readFileSync(runbookFile, 'utf8')
for (const required of [
  '发布前 Go/No-Go',
  '标准部署顺序',
  '健康检查与观测',
  'Worker 重启、队列积压或 Outbox 不收敛',
  '平台 429、401/403 或 OAuth 撤权',
  '数据库恢复',
  '回滚',
  '扩容与容量门禁',
  'CONFIRM_RESTORE=YES',
  'CONFIRM_ROLLBACK=YES',
]) assert.ok(runbook.includes(required), `runbook must cover ${required}`)

const otel = readFileSync(otelFile, 'utf8')
for (const required of ['traces:', 'metrics:', 'logs:', 'memory_limiter', 'attributes/redact', 'authorization', 'access_token', 'refresh_token', 'app_secret']) {
  assert.ok(otel.includes(required), `OTEL example must cover ${required}`)
}

const alerts = readFileSync(alertsFile, 'utf8')
for (const required of ['MerchantApiHigh5xx', 'MerchantPublishUnknown', 'MerchantDatabaseConnectionsHigh', 'MerchantQueueBacklog', 'MerchantConnectorTimeouts', 'MerchantOutboxPending']) {
  assert.ok(alerts.includes(required), `alert contract must cover ${required}`)
}

for (const script of ['infra/scripts/apply-migrations.sh', 'infra/scripts/backup-postgres.sh', 'infra/scripts/restore-postgres.sh', 'infra/scripts/rollback.sh', 'infra/scripts/scale-workloads.sh', 'tests/backup-restore-acceptance.sh']) {
  execFileSync('sh', ['-n', script])
}

console.log(JSON.stringify({
  profile: 'production_ops_gate',
  compose: { services: expectedServices, explicitHealthchecks: true, boundedLogs: true, restartPolicies: true, gracefulShutdown: true },
  observability: { otelPipelines: ['traces', 'metrics', 'logs'], redactionContract: true, alertContract: true },
  runbook: { file: runbookFile, deployment: true, incident: true, recovery: true, capacity: true },
  cloudGate: false,
  status: 'pass',
}))
