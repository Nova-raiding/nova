#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const [, , composePath, project] = process.argv
if (!composePath || !project) throw new Error('usage: validate-ecs-compose-project.mjs <rendered-compose.json> <compose-project>')
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(project)) throw new Error('unsafe ECS_COMPOSE_PROJECT')

let compose
try {
  compose = JSON.parse(readFileSync(composePath, 'utf8'))
} catch (error) {
  throw new Error(`rendered ECS Compose is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
}

for (const kind of ['networks', 'volumes']) {
  const resources = compose?.[kind]
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) continue
  for (const [key, value] of Object.entries(resources)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ECS Compose ${kind} resource: ${key}`)
    if (value.external === true) throw new Error(`ECS Compose ${kind} resource must not be external: ${key}`)
    const expectedName = `${project}_${key}`
    if (value.name !== expectedName) {
      throw new Error(`ECS Compose ${kind} resource ${key} must be frozen as ${expectedName}; got ${String(value.name ?? '<unnamed>')}`)
    }
  }
}

console.log(`ECS Compose resource project contract passed: ${project}`)
