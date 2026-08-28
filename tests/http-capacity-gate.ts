import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { Product } from '../packages/application/src/service.js'

type Mode = 'local_fake' | 'compose' | 'real_cloud'
type Profile = 'pilot_50' | 'wave_100' | 'wave_250' | 'target_500'

export interface CapacityGateSummary {
  profile: Profile
  mode: Mode
  transport: 'real_http'
  connectorMode: 'fake' | 'not_exercised' | 'real_platform'
  platformTrafficExercised: false
  coverage: 'api_http_only'
  cloudGate: boolean
  baseUrl: string
  workspaces: number
  requests: number
  concurrency: number
  errors: number
  statusCounts: Record<string, number>
  p95Ms: number
  p99Ms: number
  maxMs: number
  status: 'pass'
}

const profile = (process.env.CAPACITY_GATE_PROFILE ?? 'pilot_50') as Profile
const mode = (process.env.CAPACITY_GATE_MODE ?? 'local_fake') as Mode
const profileWorkspaces: Record<Profile, number> = { pilot_50: 50, wave_100: 100, wave_250: 250, target_500: 500 }
const profileP95Budget: Record<Profile, number> = { pilot_50: 1_000, wave_100: 1_200, wave_250: 1_600, target_500: 2_000 }

assert.ok(profile in profileWorkspaces, `CAPACITY_GATE_PROFILE must be pilot_50, wave_100, wave_250 or target_500`)
assert.ok(['local_fake', 'compose', 'real_cloud'].includes(mode), 'CAPACITY_GATE_MODE must be local_fake, compose, or real_cloud')

const workspaces = Number(process.env.CAPACITY_GATE_WORKSPACES ?? profileWorkspaces[profile])
const iterations = Number(process.env.CAPACITY_GATE_ITERATIONS ?? 1)
const concurrency = Number(process.env.CAPACITY_GATE_CONCURRENCY ?? Math.min(workspaces, 50))
assert.equal(workspaces, profileWorkspaces[profile], `workspace count must remain fixed for ${profile}`)
assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 20, 'CAPACITY_GATE_ITERATIONS must be 1..20')
assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= workspaces, 'CAPACITY_GATE_CONCURRENCY must be within workspace count')
assert.notEqual(process.env.CAPACITY_GATE_CONNECTOR_MODE, 'real_platform', 'HTTP capacity gate cannot claim real platform connector traffic; use a separate platform canary')

function isLoopback(url: string) {
  const hostname = new URL(url).hostname
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

function validateTarget(target: string) {
  const url = new URL(target)
  assert.ok(url.protocol === 'http:' || url.protocol === 'https:', 'capacity gate target must use HTTP(S)')
  if (mode === 'local_fake') assert.ok(isLoopback(target), 'local_fake target must be loopback')
  if (mode === 'compose') assert.ok(isLoopback(target), 'compose target must be loopback in this local gate')
  if (mode === 'real_cloud') {
    assert.equal(process.env.CAPACITY_GATE_CONFIRM_REAL_CLOUD, 'true', 'real_cloud requires CAPACITY_GATE_CONFIRM_REAL_CLOUD=true')
    assert.ok(!isLoopback(target), 'real_cloud target must not be loopback')
    assert.ok(url.protocol === 'https:', 'real_cloud target must use HTTPS')
    assert.ok(process.env.CAPACITY_GATE_ENVIRONMENT === 'preproduction' || process.env.CAPACITY_GATE_ENVIRONMENT === 'production', 'real_cloud requires CAPACITY_GATE_ENVIRONMENT')
  }
}

const serverForLocalFake = async (): Promise<{ server: Server; baseUrl: string }> => {
  process.env.NODE_ENV = 'test'
  const api = await import('../apps/api/src/server.js')
  const server = api.server
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local fake HTTP server did not bind')
  for (let index = 0; index < workspaces; index += 1) {
    const workspaceId = `ws_capacity_${index}`
    const product: Product = { id: `prod_capacity_${index}`, workspaceId, platform: 'taobao', storeName: `Capacity ${index}`, remoteId: `TB-CAPACITY-${index}`, title: `Capacity test ${index}`, skuCount: 1, stock: 10, factsConfirmed: true, source: 'fixture', updatedAt: new Date().toISOString() }
    api.service.products.set(product.id, product)
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

const closeServer = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

async function run(): Promise<CapacityGateSummary> {
  let localServer: Server | undefined
  let baseUrl = process.env.CAPACITY_GATE_URL ?? ''
  if (mode === 'local_fake') {
    const started = await serverForLocalFake()
    localServer = started.server
    baseUrl = started.baseUrl
  }
  assert.ok(baseUrl, 'CAPACITY_GATE_URL is required for compose and real_cloud')
  validateTarget(baseUrl)

  const timings: number[] = []
  const statusCounts: Record<string, number> = {}
  let errors = 0
  let cursor = 0
  const total = workspaces * iterations
  const worker = async () => {
    while (true) {
      const index = cursor++
      if (index >= total) return
      const workspaceId = `ws_capacity_${index % workspaces}`
      const started = performance.now()
      try {
        const response = await fetch(`${baseUrl}/v1/products`, { headers: { 'x-workspace-id': workspaceId, authorization: `Bearer ${process.env.CAPACITY_GATE_TOKEN ?? 'pilot-local-token'}` } })
        const elapsed = performance.now() - started
        timings.push(elapsed)
        statusCounts[String(response.status)] = (statusCounts[String(response.status)] ?? 0) + 1
        if (!response.ok) errors += 1
        await response.arrayBuffer()
      } catch {
        timings.push(performance.now() - started)
        errors += 1
        statusCounts.network_error = (statusCounts.network_error ?? 0) + 1
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, worker))
  } finally {
    if (localServer) await closeServer(localServer)
  }
  timings.sort((a, b) => a - b)
  const percentile = (fraction: number) => timings[Math.min(timings.length - 1, Math.ceil(timings.length * fraction) - 1)] ?? 0
  const summary: CapacityGateSummary = {
    profile,
    mode,
    transport: 'real_http',
    // This route only exercises the service edge. Real platform traffic is
    // reported separately and must be explicitly declared by the external
    // platform canary, never inferred from an HTTP capacity run.
    connectorMode: mode === 'local_fake' ? 'fake' : 'not_exercised',
    platformTrafficExercised: false,
    coverage: 'api_http_only',
    cloudGate: mode === 'real_cloud',
    baseUrl,
    workspaces,
    requests: total,
    concurrency,
    errors,
    statusCounts,
    p95Ms: Math.round(percentile(0.95) * 100) / 100,
    p99Ms: Math.round(percentile(0.99) * 100) / 100,
    maxMs: Math.round((timings.at(-1) ?? 0) * 100) / 100,
    status: 'pass',
  }
  assert.equal(summary.errors, 0, `HTTP capacity gate had ${summary.errors} errors`)
  assert.equal(summary.requests, total)
  assert.ok(summary.p95Ms <= profileP95Budget[profile], `p95 ${summary.p95Ms}ms exceeds ${profileP95Budget[profile]}ms budget`)
  const output = process.env.CAPACITY_GATE_OUTPUT
  if (output) writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return summary
}

const summary = await run()
console.log(JSON.stringify(summary))
