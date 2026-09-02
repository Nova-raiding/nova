import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

export const LOCAL_RUNTIME_SERVICES = [
  'api', 'api-replica', 'clamav', 'ops-ui', 'postgres', 'redis', 'ui',
  'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile',
  'worker-scan', 'worker-sync',
] as const

type ComposeRow = { Service?: string; State?: string; Health?: string; ID?: string }
export type LocalRuntimeServiceEvidence = {
  service: string
  container_id: string
  image_id: string
  state: 'running'
  health: 'healthy'
  started_at: string
}
export type LocalRuntimeEvidence = {
  schema_version: '1'
  environment: 'test'
  profile: 'local_compose'
  compose_project: 'local'
  compose_file: 'infra/local/docker-compose.yml'
  captured_at: string
  services: LocalRuntimeServiceEvidence[]
}

const compose = ['compose', '-p', 'local', '-f', 'infra/local/docker-compose.yml']
const iso = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
  && Number.isFinite(Date.parse(value))

function docker(args: string[]) {
  return execFileSync('docker', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function validateLocalRuntimeEvidence(document: unknown): string[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as Partial<LocalRuntimeEvidence>
  const errors: string[] = []
  if (value.schema_version !== '1') errors.push('schema_version must be 1')
  if (value.environment !== 'test') errors.push('environment must be test')
  if (value.profile !== 'local_compose') errors.push('profile must be local_compose')
  if (value.compose_project !== 'local') errors.push('compose_project must be local')
  if (value.compose_file !== 'infra/local/docker-compose.yml') errors.push('compose_file must be infra/local/docker-compose.yml')
  if (!iso(value.captured_at)) errors.push('captured_at must be a UTC ISO instant')
  if (!Array.isArray(value.services)) return [...errors, 'services must be an array']
  const names = value.services.map(service => service && typeof service === 'object' && !Array.isArray(service) ? service.service : undefined)
  if (names.some(name => typeof name !== 'string')) errors.push('services must contain service names')
  if (new Set(names).size !== names.length) errors.push('services must contain unique service names')
  if (names.filter((name): name is string => typeof name === 'string').sort().join(',') !== [...LOCAL_RUNTIME_SERVICES].sort().join(',')) errors.push('services must exactly match the local runtime service set')
  for (const service of value.services) {
    if (!service || typeof service !== 'object' || Array.isArray(service)) { errors.push('service entries must be objects'); continue }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(service.service ?? '')) errors.push('service.service must be a safe service name')
    if (!/^[0-9a-f]{12,64}$/u.test(service.container_id ?? '')) errors.push(`${service.service ?? 'service'} container_id must be immutable-looking hex`)
    if (!/^sha256:[0-9a-f]{64}$/u.test(service.image_id ?? '')) errors.push(`${service.service ?? 'service'} image_id must be a sha256 digest`)
    if (service.state !== 'running') errors.push(`${service.service ?? 'service'} state must be running`)
    if (service.health !== 'healthy') errors.push(`${service.service ?? 'service'} health must be healthy`)
    if (!iso(service.started_at)) errors.push(`${service.service ?? 'service'} started_at must be a UTC ISO instant`)
  }
  return errors
}

export function collectLocalRuntimeEvidence(): LocalRuntimeEvidence {
  const rows = docker([...compose, 'ps', '--format', 'json']).split('\n').filter(Boolean).map(line => JSON.parse(line) as ComposeRow)
  const byService = new Map(rows.map(row => [row.Service, row]))
  const services = LOCAL_RUNTIME_SERVICES.map(service => {
    const row = byService.get(service)
    if (!row?.ID || row.State !== 'running' || row.Health !== 'healthy') throw new Error(`${service} must be running and healthy before evidence capture`)
    const inspected = JSON.parse(docker(['inspect', '--format', '{{json .}}', row.ID])) as { Id?: string; Image?: string; State?: { Status?: string; StartedAt?: string } }
    const evidence: LocalRuntimeServiceEvidence = {
      service,
      container_id: row.ID,
      image_id: inspected.Image ?? '',
      state: inspected.State?.Status as 'running',
      health: 'healthy',
      started_at: inspected.State?.StartedAt ?? '',
    }
    const errors = validateLocalRuntimeEvidence({ schema_version: '1', environment: 'test', profile: 'local_compose', compose_project: 'local', compose_file: 'infra/local/docker-compose.yml', captured_at: new Date().toISOString(), services: [evidence, ...LOCAL_RUNTIME_SERVICES.filter(name => name !== service).map(name => ({ service: name, container_id: '0'.repeat(12), image_id: `sha256:${'0'.repeat(64)}`, state: 'running' as const, health: 'healthy' as const, started_at: new Date().toISOString() }))] })
    if (errors.some(error => error.includes(`${service} image_id`) || error.includes(`${service} started_at`) || error.includes(`${service} state`) || error.includes(`${service} container_id`))) throw new Error(errors.join('; '))
    return evidence
  })
  const result: LocalRuntimeEvidence = { schema_version: '1', environment: 'test', profile: 'local_compose', compose_project: 'local', compose_file: 'infra/local/docker-compose.yml', captured_at: new Date().toISOString(), services }
  const errors = validateLocalRuntimeEvidence(result)
  if (errors.length) throw new Error(errors.join('; '))
  return result
}

function main() {
  const args = process.argv.slice(2)
  const file = args[args.indexOf('--output') + 1]
  if (args.includes('--replay')) {
    if (!file) throw new Error('--replay requires --output <evidence.json>')
    const errors = validateLocalRuntimeEvidence(JSON.parse(readFileSync(file, 'utf8')))
    if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
    console.log(`local runtime evidence replay passed: ${file}`)
    return
  }
  const evidence = collectLocalRuntimeEvidence()
  if (file) writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(evidence, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) main()
