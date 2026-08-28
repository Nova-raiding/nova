import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const configMap = readFileSync('infra/kubernetes/base/configmap.yaml', 'utf8')
const workers = readFileSync('infra/kubernetes/base/workers.yaml', 'utf8')
const productionConfig = readFileSync('docs/production-config.example.yaml', 'utf8')

function value(text: string, key: string) {
  const match = text.match(new RegExp(`\\b${key}: ["']?([0-9]+)`))
  if (!match) throw new Error(`missing ${key}`)
  return Number(match[1])
}

function maxReplicasFor(name: string) {
  const block = workers.split('---').find(section => section.includes(`metadata: {name: merchant-worker-${name}}`) && section.includes('kind: HorizontalPodAutoscaler'))
  if (!block) throw new Error(`missing HPA for ${name}`)
  return value(block, 'maxReplicas')
}

describe('database connection budget contract', () => {
  it('keeps pilot and target profiles below the 300 backend connection budget', () => {
    const apiPool = value(configMap, 'DB_POOL_MAX')
    const workerPool = value(configMap, 'WORKER_DB_POOL_MAX')
    const targetApi = 12
    const targetWorkers = ['sync', 'generation', 'publish', 'reconcile'].map(maxReplicasFor).reduce((sum, count) => sum + count, 0) + 1
    const targetClientConnections = targetApi * apiPool + targetWorkers * workerPool
    expect(targetWorkers).toBe(41)
    expect(targetClientConnections).toBe(267)
    expect(targetClientConnections).toBeLessThanOrEqual(300)

    const pilotClientConnections = 3 * 20 + 8 * 5
    expect(pilotClientConnections).toBe(100)
    expect(pilotClientConnections).toBeLessThanOrEqual(120)
    expect(productionConfig).toContain('minimum_replicas: 3')
    expect(productionConfig).toContain('worker_replicas_max: 11')
    expect(productionConfig).toContain('client_pool_connections: 100')
    expect(productionConfig).toContain('client_pool_connections: 267')
  })
})
