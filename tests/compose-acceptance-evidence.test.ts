import { describe, expect, it } from 'vitest'
import { buildLocalComposeAcceptanceEvidence } from './compose-acceptance.js'

describe('local Compose acceptance evidence', () => {
  it('binds the real local HTTP/Postgres run to explicit test versions', () => {
    expect(buildLocalComposeAcceptanceEvidence({
      workspaces: 50,
      releaseId: 'release-test-1',
      softwareVersion: 'api@0.1.1',
      configVersion: 'compose-v3',
      dataVersion: 'migration-134',
    })).toEqual({
      schema_version: '1', profile: 'pilot_50_compose_postgres', release_id: 'release-test-1',
      software_version: 'api@0.1.1', config_version: 'compose-v3', data_version: 'migration-134',
      environment: 'test', cloud_gate: false, status: 'pass', transport: 'real_http',
      persistence: 'real_compose_postgres', workspaces: 50, migration_restart: 'passed', outbox_replay: 'passed',
    })
  })

  it('does not allow whitespace-only bindings to produce evidence', () => {
    expect(() => buildLocalComposeAcceptanceEvidence({
      workspaces: 50, releaseId: ' ', softwareVersion: ' ', configVersion: ' ', dataVersion: ' ',
    })).toThrow('requires release, software, config and data version bindings')
  })

  it('cannot be promoted by changing the local evidence builder output', () => {
    const evidence = buildLocalComposeAcceptanceEvidence({ workspaces: 50 })
    expect(evidence.environment).toBe('test')
    expect(evidence.cloud_gate).toBe(false)
    expect(evidence.status).toBe('pass')
  })

  it('does not label a non-50-workspace run as the pilot_50 profile', () => {
    expect(() => buildLocalComposeAcceptanceEvidence({ workspaces: 49 })).toThrow('exactly 50 exercised workspaces')
    expect(() => buildLocalComposeAcceptanceEvidence({ workspaces: 51 })).toThrow('exactly 50 exercised workspaces')
    expect(() => buildLocalComposeAcceptanceEvidence({ workspaces: 50.5 })).toThrow('exactly 50 exercised workspaces')
  })
})
