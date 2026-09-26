#!/usr/bin/env node
// Read-only inspection of `docker compose config --format json` for the
// B-derived 242/254 review tree. This is not a deploy preflight or evidence.
import { readFileSync } from 'node:fs'

const runtime = ['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']
const releaseFields = ['RELEASE_ID', 'RELEASE_GIT_SHA', 'RELEASE_MANIFEST_SHA256', 'RELEASE_IMAGE_SET_DIGEST']
const imagePattern = /^[^\s]+@sha256:[0-9a-f]{64}$/u

function requireValue(value, message) { if (!value) throw new Error(message) }

export function inspectBridge254Compose(config) {
  requireValue(config && typeof config === 'object' && !Array.isArray(config), 'rendered Compose must be an object')
  const services = config.services
  requireValue(services && typeof services === 'object' && !Array.isArray(services), 'rendered Compose services are missing')
  const apiEnv = services.api?.environment
  requireValue(apiEnv && typeof apiEnv === 'object' && !Array.isArray(apiEnv), 'api environment is missing')
  for (const field of releaseFields) requireValue(typeof apiEnv[field] === 'string' && apiEnv[field].trim(), `api ${field} is missing`)
  requireValue(/^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(apiEnv.RELEASE_ID), 'api release ID is invalid')
  requireValue(/^[0-9a-f]{40}$/u.test(apiEnv.RELEASE_GIT_SHA), 'api Git SHA is invalid')
  for (const field of releaseFields.slice(2)) requireValue(/^[0-9a-f]{64}$/u.test(apiEnv[field]) || /^sha256:[0-9a-f]{64}$/u.test(apiEnv[field]), `api ${field} is invalid`)
  for (const name of runtime) {
    const service = services[name]
    requireValue(service && typeof service === 'object', `${name} service is missing`)
    requireValue(service.build === undefined || service.build === null, `${name} retains a mutable build`)
    requireValue(typeof service.image === 'string' && imagePattern.test(service.image), `${name} image is not digest pinned`)
    const environment = service.environment
    requireValue(environment && typeof environment === 'object' && !Array.isArray(environment), `${name} environment is missing`)
    requireValue(environment.BRIDGE_SCHEMA_COMPATIBILITY_MODE === 'prefix_242_or_254', `${name} bridge mode must be prefix_242_or_254`)
    requireValue(environment.RUN_MIGRATIONS_ON_STARTUP === 'false', `${name} startup migrations must be disabled`)
    if (name.startsWith('api')) for (const field of releaseFields) requireValue(environment[field] === apiEnv[field], `${name} ${field} differs from api`)
    if (name.startsWith('worker-')) requireValue(service.image === services['worker-sync'].image, `${name} worker image differs`)
    if (name.startsWith('api')) requireValue(service.image === services.api.image, `${name} API image differs`)
  }
  return {
    schema_version: 'ecs-bridge-254-compose-inspection/1',
    status: 'review_only', deployable: false, runtime_verified: false,
    release_id: apiEnv.RELEASE_ID, release_git_sha: apiEnv.RELEASE_GIT_SHA,
    inspected_services: runtime,
  }
}

if (process.argv[1]?.endsWith('/inspect-ecs-bridge-254-rendered-compose.mjs')) {
  try {
    requireValue(process.argv.length === 2, 'usage: docker compose config --format json | node inspect-ecs-bridge-254-rendered-compose.mjs')
    process.stdout.write(`${JSON.stringify(inspectBridge254Compose(JSON.parse(readFileSync(0, 'utf8'))))}\n`)
  } catch (error) {
    process.stderr.write(`bridge 254 Compose inspection rejected: ${error.message}\n`)
    process.exitCode = 1
  }
}
