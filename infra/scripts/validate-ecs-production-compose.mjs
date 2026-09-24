import { readFileSync } from 'node:fs'

const source = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8')
const rendered = JSON.parse(source)

function fail(message) {
  console.error(`ECS_PRODUCTION_COMPOSE_INVALID: ${message}`)
  process.exit(1)
}

function normalizedMounts(service) {
  return (service?.volumes ?? []).map(item => {
    if (typeof item === 'string') {
      const [source = '', target = '', mode = ''] = item.split(':')
      return { source, target, type: source.startsWith('/') || source.startsWith('.') ? 'bind' : 'volume', readOnly: mode.split(',').includes('ro') }
    }
    return { source: String(item?.source ?? ''), target: String(item?.target ?? ''), type: String(item?.type ?? ''), readOnly: item?.read_only === true }
  })
}

const applicationServices = new Set([
  'api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish',
  'worker-reconcile', 'worker-automation', 'worker-scan', 'payment-gateway',
  'ui', 'ops-ui', 'pilot-gateway', 'alert-receiver',
])
const immutableNodeServices = new Set([
  'api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish',
  'worker-reconcile', 'worker-automation', 'worker-scan', 'payment-gateway',
  'alert-receiver',
])

for (const [name, service] of Object.entries(rendered.services ?? {})) {
  if (service?.privileged === true) fail(`${name}.privileged must not be enabled`)
  if (String(service?.network_mode ?? '').toLowerCase() === 'host') fail(`${name}.network_mode must not equal host`)
  if (String(service?.pid ?? '').toLowerCase() === 'host') fail(`${name}.pid must not equal host`)
  if (String(service?.ipc ?? '').toLowerCase() === 'host') fail(`${name}.ipc must not equal host`)

  for (const mount of normalizedMounts(service)) {
    const source = mount.source.replace(/\/$/u, '')
    const target = mount.target.replace(/\/$/u, '')
    if (/(^|\/)docker\.sock$/u.test(source) || /(^|\/)docker\.sock$/u.test(target)) fail(`${name} must not mount a Docker socket`)
    if (mount.type === 'bind' && (source === '/' || /^(?:\/etc|\/proc|\/sys|\/dev|\/boot|\/var\/run)(?:\/|$)/u.test(source))) {
      fail(`${name} must not bind-mount sensitive host path ${source}`)
    }
  }

  if (!applicationServices.has(name)) continue
  const user = String(service?.user ?? '').trim().split(':')[0]
  if (!user || user === '0' || user === 'root') fail(`${name}.user must explicitly select a non-root identity`)
  const securityOpt = (service?.security_opt ?? []).map(value => String(value).toLowerCase())
  if (!securityOpt.includes('no-new-privileges:true')) fail(`${name}.security_opt must include no-new-privileges:true`)
  const dropped = (service?.cap_drop ?? []).map(value => String(value).toUpperCase())
  if (!dropped.includes('ALL')) fail(`${name}.cap_drop must include ALL`)
  if (immutableNodeServices.has(name) && service?.read_only !== true) fail(`${name}.read_only must equal true`)
}

for (const name of ['api', 'api-replica']) {
  const environment = rendered.services?.[name]?.environment ?? {}
  const expected = {
    NODE_ENV: 'production',
    DEPLOYMENT_PROFILE: 'ecs',
    LOCAL_COMPOSE: 'false',
    CONNECTOR_FIXTURE_MODE: 'false',
    PLATFORM_OPERATIONS_MODE: 'manual',
    OPS_AUTH_MODE: 'password',
    PUBLIC_OPS_BASE_URL: 'https://ops.yxsona.com',
    MERCHANT_TEST_APPROVED_RATES: 'false',
    ALLOW_LOCAL_DURABLE_OBJECT_STORAGE: 'false',
    ASSET_STORAGE_CREDENTIAL_PROVIDER: 'aliyun_ecs_ram_role',
    OPS_ALERT_NOTIFICATIONS_ENABLED: 'false',
  }
  for (const [key, value] of Object.entries(expected)) {
    if (String(environment[key] ?? '') !== value) fail(`${name}.${key} must equal ${value}`)
  }
  for (const key of ['ALERT_CHANNEL_SECRET_REF', 'OPS_ALERT_WEBHOOK_URL', 'OPS_ALERT_WEBHOOK_ALLOWED_HOSTS', 'OPS_ALERT_WEBHOOK_SECRET_FILE']) {
    if (String(environment[key] ?? '') !== '') fail(`${name}.${key} must be empty while alerts are disabled`)
  }
  for (const key of ['API_AUTH_TOKENS', 'SESSION_ID_HASH_SECRET', 'WORKER_API_CREDENTIALS', 'ASSET_DISPLAY_URL_SIGNING_SECRET', 'ASSET_DISPLAY_URL_SIGNING_KEY_ID', 'DATABASE_URL', 'OPS_DATABASE_URL', 'MODEL_COST_ESTIMATE_VERSION']) {
    if (!String(environment[key] ?? '').trim()) fail(`${name}.${key} must be configured`)
  }
  if (String(environment.MCP_INTEGRATION_MODE ?? '') !== 'local_stdio') fail(`${name}.MCP_INTEGRATION_MODE must equal local_stdio`)
  for (const key of ['MCP_OAUTH_REQUIRED', 'MCP_OAUTH_CLIENTS', 'MCP_OAUTH_ISSUER', 'MCP_OAUTH_AUTHORIZATION_ENDPOINT', 'MCP_OAUTH_TOKEN_ENDPOINT', 'OPENAI_APPS_CHALLENGE_TOKEN', 'OIDC_PROXY_SIGNING_SECRET']) {
    if (String(environment[key] ?? '') !== '') fail(`${name}.${key} is retired and must be omitted`)
  }
  if (String(environment.ALLOW_WILDCARD_WORKSPACE_GRANT ?? '') !== 'false') fail(`${name}.ALLOW_WILDCARD_WORKSPACE_GRANT must equal false`)
  if (String(environment.OPS_LOCAL_SESSION_WORKSPACE_ID ?? '') !== '') fail(`${name}.OPS_LOCAL_SESSION_WORKSPACE_ID must be empty`)
  const serialized = JSON.stringify(environment)
  if (/(?:pilot-local|workspace-local|actor_demo|workspace_admin_demo|local-primary|ws_demo|local-acceptance|merchant_(?:app|ops)_local_only)/u.test(serialized)) fail(`${name} contains local/demo production configuration`)
  try {
    const grants = Object.values(JSON.parse(String(environment.API_AUTH_TOKENS)))
    if (grants.some(grant => Array.isArray(grant?.workspaces) && grant.workspaces.includes('*'))) fail(`${name}.API_AUTH_TOKENS contains a wildcard workspace grant`)
    if (grants.some(grant => grant?.bootstrap === true)) fail(`${name}.API_AUTH_TOKENS contains bootstrap=true`)
  } catch {
    fail(`${name}.API_AUTH_TOKENS must be valid JSON`)
  }
  const mounts = (rendered.services?.[name]?.volumes ?? []).map(item => typeof item === 'string' ? item : `${item.source ?? ''}:${item.target ?? ''}`)
  if (mounts.some(item => item.includes('alert_receiver'))) fail(`${name} must not mount alert receiver secrets while alerts are disabled`)
  if (String(environment.CAPACITY_REPORT_PATH ?? '') !== '/run/release-evidence/capacity-report.json') fail(`${name}.CAPACITY_REPORT_PATH must use the release evidence mount`)
  if (!normalizedMounts(rendered.services?.[name]).some(item => item.target === '/run/release-evidence/capacity-report.json' && item.readOnly)) fail(`${name} must mount the release-bound capacity report read-only`)
}

for (const name of ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']) {
  const environment = rendered.services?.[name]?.environment ?? {}
  if (String(environment.NODE_ENV ?? '') !== 'production') fail(`${name}.NODE_ENV must equal production`)
  if (!String(environment.DATABASE_URL ?? '').trim()) fail(`${name}.DATABASE_URL must be configured`)
  if (!String(environment.WORKER_WORKSPACES ?? '').trim()) fail(`${name}.WORKER_WORKSPACES must be configured`)
  for (const key of ['WORKER_API_TOKEN', 'WORKER_API_SIGNING_SECRET']) {
    if (!String(environment[key] ?? '').trim()) fail(`${name}.${key} must be configured`)
  }
  if (/(?:ws_demo|workspace_demo|demo-workspace|local-token|local-signing-secret|merchant_app_local_only)/u.test(JSON.stringify(environment))) fail(`${name} contains a local/demo identity`)
}

// A full production release always runs a workspace-bound canary. Catch a
// scanner allowlist that silently excludes that workspace before deployment;
// this validates the rendered scanner scope without widening it.
const productionCanaryWorkspace = String(process.env.PRODUCTION_CANARY_WORKSPACE_ID ?? '').trim()
if (productionCanaryWorkspace) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(productionCanaryWorkspace)) fail('PRODUCTION_CANARY_WORKSPACE_ID is invalid')
  const scannerWorkspaces = String(rendered.services?.['worker-scan']?.environment?.WORKER_WORKSPACES ?? '').trim()
  const scannerWorkspaceAllowlist = scannerWorkspaces.split(',').map(value => value.trim()).filter(Boolean)
  if (scannerWorkspaces !== 'auto' && !scannerWorkspaceAllowlist.includes(productionCanaryWorkspace)) {
    fail('worker-scan.WORKER_WORKSPACES must include the production canary workspace or equal auto')
  }
}

const primaryEnvironment = rendered.services?.api?.environment ?? {}
try {
  const credentials = JSON.parse(String(primaryEnvironment.WORKER_API_CREDENTIALS))
  const bindings = {
    sync: 'worker-sync', generation: 'worker-generation', publish: 'worker-publish',
    reconcile: 'worker-reconcile', automation: 'worker-automation', scan: 'worker-scan',
  }
  const roles = Object.keys(bindings)
  if (Object.keys(credentials).sort().join(',') !== roles.sort().join(',')) fail('api.WORKER_API_CREDENTIALS must contain exactly the six production worker roles')
  for (const [role, service] of Object.entries(bindings)) {
    const workerEnvironment = rendered.services?.[service]?.environment ?? {}
    if (credentials[role]?.token !== workerEnvironment.WORKER_API_TOKEN) fail(`api.WORKER_API_CREDENTIALS.${role}.token must match ${service}.WORKER_API_TOKEN`)
    if (credentials[role]?.signing_secret !== workerEnvironment.WORKER_API_SIGNING_SECRET) fail(`api.WORKER_API_CREDENTIALS.${role}.signing_secret must match ${service}.WORKER_API_SIGNING_SECRET`)
  }
} catch (error) {
  if (error instanceof SyntaxError) fail('api.WORKER_API_CREDENTIALS must be valid JSON')
  throw error
}

const alertReceiver = rendered.services?.['alert-receiver']
if (alertReceiver && (!Array.isArray(alertReceiver.profiles) || alertReceiver.profiles.length !== 1 || alertReceiver.profiles[0] !== 'alerts')) {
  fail('alert-receiver must remain isolated behind the alerts profile')
}

const migrate = rendered.services?.migrate
if (!migrate) fail('migrate service is missing')
const command = Array.isArray(migrate.entrypoint) ? migrate.entrypoint.join(' ') : String(migrate.entrypoint ?? '')
if (!command.includes('/ops/apply-migrations.sh')) fail('migrate must execute apply-migrations.sh')
if (!command.includes('/ops/verify-runtime-db-role.sh')) fail('migrate must verify runtime DB roles')
if (command.includes('seed-demo.sql')) fail('production migrate must not execute seed-demo.sql')
const mounts = (migrate.volumes ?? []).map(item => typeof item === 'string' ? item : `${item.source ?? ''}:${item.target ?? ''}`)
if (mounts.some(item => item.includes('seed-demo.sql'))) fail('production migrate must not mount seed-demo.sql')

console.log('ECS production Compose contract passed')
