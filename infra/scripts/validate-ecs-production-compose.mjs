import { readFileSync } from 'node:fs'

const source = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8')
const rendered = JSON.parse(source)

function fail(message) {
  console.error(`ECS_PRODUCTION_COMPOSE_INVALID: ${message}`)
  process.exit(1)
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
  }
  for (const [key, value] of Object.entries(expected)) {
    if (String(environment[key] ?? '') !== value) fail(`${name}.${key} must equal ${value}`)
  }
  for (const key of ['ALERT_CHANNEL_SECRET_REF', 'OPS_ALERT_WEBHOOK_URL', 'OPS_ALERT_WEBHOOK_ALLOWED_HOSTS', 'OPS_ALERT_WEBHOOK_SECRET_FILE']) {
    if (String(environment[key] ?? '') !== '') fail(`${name}.${key} must be empty while alerts are disabled`)
  }
  const mounts = (rendered.services?.[name]?.volumes ?? []).map(item => typeof item === 'string' ? item : `${item.source ?? ''}:${item.target ?? ''}`)
  if (mounts.some(item => item.includes('alert_receiver'))) fail(`${name} must not mount alert receiver secrets while alerts are disabled`)
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
