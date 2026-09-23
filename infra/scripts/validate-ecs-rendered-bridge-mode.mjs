import { readFileSync } from 'node:fs'

const mode = process.env.ECS_BRIDGE_CODE_ONLY
if (mode !== 'YES' && mode !== 'NO') throw new Error('ECS_BRIDGE_CODE_ONLY must be YES or NO')
const rendered = JSON.parse(readFileSync(0, 'utf8'))
const runtimeServices = ['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']
for (const name of runtimeServices) {
  const environment = rendered.services?.[name]?.environment
  if (!environment || typeof environment !== 'object') throw new Error(`runtime environment missing from ${name}`)
  const bridgeMode = environment.BRIDGE_SCHEMA_COMPATIBILITY_MODE
  if (mode === 'YES' && bridgeMode !== 'prefix_242_or_244') throw new Error(`bridge schema mode missing from ${name}`)
  if (mode === 'NO' && bridgeMode !== '') throw new Error(`non-bridge release must clear schema compatibility mode on ${name}`)
  if ((name === 'api' || name === 'api-replica') && environment.RUN_MIGRATIONS_ON_STARTUP !== 'false') {
    throw new Error(`release must disable startup migrations on ${name}`)
  }
}
if (mode === 'YES') {
  for (const name of [...runtimeServices, 'ui', 'ops-ui', 'payment-gateway', 'clamav', 'pilot-gateway']) {
    if (!/^[^\s]+@sha256:[0-9a-f]{64}$/u.test(rendered.services?.[name]?.image ?? '')) throw new Error(`bridge service lacks immutable image: ${name}`)
  }
}
