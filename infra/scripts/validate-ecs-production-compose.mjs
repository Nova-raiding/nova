import { readFileSync } from 'node:fs'
import { BlockList, isIP } from 'node:net'

const source = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8')
const rendered = JSON.parse(source)

function fail(message) {
  console.error(`ECS_PRODUCTION_COMPOSE_INVALID: ${message}`)
  process.exit(1)
}

function validatePaymentUrl(value, field) {
  const original = String(value ?? '')
  let url
  try { url = new URL(original) } catch { fail(`${field} must be a canonical public HTTPS URL`) }
  const hostname = url.hostname.toLowerCase()
  const canonical = original === url.href || (url.pathname === '/' && original === url.href.slice(0, -1))
  if (!canonical || url.protocol !== 'https:' || url.username || url.password || url.href.includes('?') || url.href.includes('#') || !paymentPublicHostname(hostname)) fail(`${field} must be a canonical public HTTPS URL`)
  if (/(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|localhost|test)$/iu.test(hostname)) fail(`${field} must not target a reserved placeholder host`)
}

function paymentPublicHostname(hostname) {
  const address = hostname.replace(/^\[|\]$/gu, '')
  const family = isIP(address)
  if (family === 4) {
    const blocked = new BlockList()
    for (const [network, prefix] of [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ]) blocked.addSubnet(network, prefix, 'ipv4')
    return !blocked.check(address, 'ipv4')
  }
  if (family === 6) {
    const global = new BlockList()
    global.addSubnet('2000::', 3, 'ipv6')
    const blocked = new BlockList()
    for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(network, prefix, 'ipv6')
    return global.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
  }
  return hostname.includes('.') && hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
}

for (const name of ['api', 'api-replica']) {
  const environment = rendered.services?.[name]?.environment ?? {}
  const expected = {
    NODE_ENV: 'production',
    DEPLOYMENT_PROFILE: 'ecs',
    LOCAL_COMPOSE: 'false',
    CONNECTOR_FIXTURE_MODE: 'false',
    MERCHANT_TEST_APPROVED_RATES: 'false',
    ALLOW_LOCAL_DURABLE_OBJECT_STORAGE: 'false',
    ASSET_STORAGE_CREDENTIAL_PROVIDER: 'aliyun_ecs_ram_role',
    OPS_ALERT_NOTIFICATIONS_ENABLED: 'false',
    PAYMENT_MODE: 'provider',
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
  for (const key of ['PAYMENT_CHECKOUT_BASE_URL', 'PAYMENT_PROVIDER_CHECKOUT_API_URL', 'PAYMENT_PROVIDER_QUERY_API_URL', 'PAYMENT_PROVIDER_REFUND_QUERY_API_URL', 'PAYMENT_PROVIDER_REFUND_API_URL']) {
    validatePaymentUrl(environment[key], `${name}.${key}`)
  }
  const merchantId = String(environment.PAYMENT_PROVIDER_MERCHANT_ID ?? '').trim()
  if (!merchantId || /(?:example|placeholder|replace[-_]?me|change[-_]?me|dummy|demo|test)/iu.test(merchantId)) fail(`${name}.PAYMENT_PROVIDER_MERCHANT_ID must be a non-placeholder merchant identity`)
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
