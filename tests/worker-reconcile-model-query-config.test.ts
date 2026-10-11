import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const baseCompose = readFileSync('infra/local/docker-compose.yml', 'utf8')
const releaseOverlay = readFileSync('infra/local/docker-compose.ecs-pilot-release.yml', 'utf8')

function serviceBlock(compose: string, service: string) {
  const startPattern = new RegExp(`^  ${service}:\\n`, 'm')
  const start = startPattern.exec(compose)
  expect(start, `Compose service ${service} must exist`).toBeTruthy()
  const contentStart = start!.index + start![0].length
  const nextService = /^  [a-z0-9-]+:/gm
  nextService.lastIndex = contentStart
  const end = nextService.exec(compose)?.index ?? compose.length
  return compose.slice(contentStart, end)
}

function environmentBlock(block: string) {
  const match = block.match(/^    environment:\n((?:^      .*\n|^\n)*)/m)
  expect(match, 'service environment mapping must exist').toBeTruthy()
  return match![1]!
}

function environmentValues(block: string) {
  return Object.fromEntries(
    [...environmentBlock(block).matchAll(/^      ([A-Z][A-Z0-9_]*): (.*)$/gm)].map(([, name, value]) => [name!, value!]),
  )
}

describe('worker-reconcile model status query Compose configuration', () => {
  it('injects only the relay and image-status query settings with generation-safe defaults', () => {
    const generation = environmentValues(serviceBlock(baseCompose, 'worker-generation'))
    const reconcileBlock = serviceBlock(baseCompose, 'worker-reconcile')
    const reconcile = environmentValues(reconcileBlock)
    const queryKeys = [
      'MODEL_RELAY_BASE_URL',
      'MODEL_RELAY_ALLOWED_HOSTS',
      'MODEL_RELAY_API_KEY',
      'IMAGE_MODEL',
      'IMAGE_STATUS_PATH',
      'IMAGE_TIMEOUT_MS',
    ] as const

    for (const key of queryKeys) {
      expect(reconcile[key], `${key} must use the generation relay default`).toBe(generation[key])
    }
    expect(reconcile.IMAGE_STATUS_PATH).toBe('${IMAGE_STATUS_PATH:-}')

    for (const key of [
      'IMAGE_GENERATION_EXECUTION_MODE', 'IMAGE_GENERATION_PATH', 'IMAGE_RESPONSE_FORMAT',
      'IMAGE_EDIT_MODEL', 'IMAGE_EDIT_PATH', 'IMAGE_EDIT_TIMEOUT_MS',
      'MODEL_RELAY_IMAGE_COST_EVIDENCE', 'MODEL_RELAY_PRICING_DERIVATION_ENABLED',
      'MODEL_RELAY_PRICING_GROUP', 'MODEL_RELAY_IMAGE_PRICING_GROUP',
      'AI_MODEL', 'AI_THINKING_MODE', 'AI_MAX_INPUT_TOKENS', 'AI_MAX_OUTPUT_TOKENS',
    ]) {
      expect(reconcile[key], `${key} grants generation or usage/pricing configuration`).toBeUndefined()
    }

    // Keep the credential as an env binding only: never embed its value in a
    // command, label, healthcheck, or other service metadata that may be logged.
    expect(reconcile.MODEL_RELAY_API_KEY).toBe('${MODEL_RELAY_API_KEY:-}')
    expect(reconcileBlock.split('\n').filter(line => line.includes('MODEL_RELAY_API_KEY')))
      .toEqual(['      MODEL_RELAY_API_KEY: ${MODEL_RELAY_API_KEY:-}'])
  })

  it('keeps the ECS release overlay from resetting reconcile environment', () => {
    const overlayReconcile = serviceBlock(releaseOverlay, 'worker-reconcile')
    expect(overlayReconcile).toContain('<<: *release-worker-image')
    expect(overlayReconcile).not.toMatch(/environment:\s*!(?:reset|override)/u)
    expect(overlayReconcile).not.toContain('MODEL_RELAY_')
    expect(overlayReconcile).not.toContain('IMAGE_STATUS_PATH')
  })
})
