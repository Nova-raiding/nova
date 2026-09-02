import { describe, expect, it } from 'vitest'
import { LOCAL_RUNTIME_SERVICES, validateLocalRuntimeEvidence } from './local-docker-runtime-evidence.js'

const service = (name: string) => ({ service: name, container_id: 'a'.repeat(12), image_id: `sha256:${'b'.repeat(64)}`, state: 'running', health: 'healthy', started_at: '2026-09-02T01:02:03.000Z' })
const evidence = () => ({ schema_version: '1', environment: 'test', profile: 'local_compose', compose_project: 'local', compose_file: 'infra/local/docker-compose.yml', captured_at: '2026-09-02T01:02:03.000Z', services: LOCAL_RUNTIME_SERVICES.map(service) })

describe('local Docker runtime evidence replay gate', () => {
  it('accepts a complete local snapshot that can be replayed without Docker', () => {
    expect(validateLocalRuntimeEvidence(evidence())).toEqual([])
  })

  it('rejects production-looking or incomplete evidence', () => {
    const invalid = evidence() as Record<string, unknown>
    invalid.environment = 'production'
    invalid.services = (invalid.services as unknown[]).slice(1)
    expect(validateLocalRuntimeEvidence(invalid)).toEqual(expect.arrayContaining([
      'environment must be test',
      'services must exactly match the local runtime service set',
    ]))
  })

  it('rejects mutable image references and unhealthy snapshots', () => {
    const invalid = evidence() as { services: Array<Record<string, unknown>> }
    invalid.services[0]!.image_id = 'merchant-api:latest'
    invalid.services[0]!.health = 'starting'
    expect(validateLocalRuntimeEvidence(invalid)).toEqual(expect.arrayContaining([
      'api image_id must be a sha256 digest',
      'api health must be healthy',
    ]))
  })
})
