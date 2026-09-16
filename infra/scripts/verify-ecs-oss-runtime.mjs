import { readFileSync } from 'node:fs'

function fail(reason) {
  console.error(`ECS_OSS_RUNTIME_INVALID: ${reason}`)
  process.exit(1)
}

let payload
try {
  payload = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  fail('healthz must return JSON')
}

const health = payload?.data ?? payload
// The API's canonical envelope uses `error: null` and does not currently emit
// `ok`. If a success marker is present, require the boolean true so strings or
// numbers cannot masquerade as success.
if (payload?.ok !== undefined && payload.ok !== true) fail('healthz envelope success marker is invalid')
if (payload?.error != null) fail('healthz envelope reports an error')
if (health?.status !== 'ok') fail('healthz status must be ok')
if (health?.setup?.mode !== 'production') fail('setup.mode must be production')
if (health?.setup?.objectStorage?.configured !== true) fail('objectStorage.configured must be true')
if (health?.setup?.objectStorage?.mode !== 's3_compatible') fail('objectStorage.mode must be s3_compatible')
if (health?.writesEnabled !== true) fail('writesEnabled must be true')

console.log('ECS OSS runtime contract passed')
