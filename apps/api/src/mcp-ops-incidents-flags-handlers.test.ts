import { describe, expect, it } from 'vitest'
import type { IncidentActor } from '../../../packages/contracts/src/ops/incidents.js'
import { MemoryIncidentRepository } from '../../../packages/persistence/src/incidents-repository.js'
import { handleMcpOpsIncidentsFlags, type McpOpsIncidentsFlagsDependencies } from './mcp-ops-incidents-flags-handlers.js'

const actor: IncidentActor = { actorId: 'platform_ops_1', workspaceId: 'ws_1', roles: ['platform_ops'] }

function dependencies(overrides: Partial<McpOpsIncidentsFlagsDependencies> = {}): McpOpsIncidentsFlagsDependencies {
  return {
    persistence: { mode: 'postgres', incidents: new MemoryIncidentRepository() },
    knownWorkspaces: new Set(['ws_1', 'ws_fixture_only']),
    incidentActor: () => actor,
    featureFlagActor: () => ({ id: actor.actorId, actorId: actor.actorId, workspaceId: actor.workspaceId, roles: ['ops_admin'] }),
    isPlatformOperations: () => true,
    requirePlatformReadRole: () => undefined,
    featureFlagRequestsCanonicalRead: () => false,
    resolveWorkspace: (_req, candidate) => typeof candidate === 'string' ? candidate : actor.workspaceId,
    invokeOpsDomain: async operation => operation(),
    ...overrides,
  }
}

const aggregateParams = { platformScope: 'platform' }

describe('MCP platform incident aggregate directory', () => {
  it('fails closed with 503 when the production workspace directory is missing', async () => {
    await expect(handleMcpOpsIncidentsFlags('ops.incidents.list', aggregateParams, {} as never, actor.workspaceId, dependencies()))
      .rejects.toMatchObject({ code: 'INCIDENT_WORKSPACE_DIRECTORY_UNAVAILABLE', status: 503 })
  })

  it('fails closed with 503 when the production workspace directory lookup fails', async () => {
    const deps = dependencies({ persistence: { mode: 'postgres', incidents: new MemoryIncidentRepository(), listWorkspaceIds: async () => { throw new Error('directory unavailable') } } })
    await expect(handleMcpOpsIncidentsFlags('ops.incidents.list', aggregateParams, {} as never, actor.workspaceId, deps))
      .rejects.toMatchObject({ code: 'INCIDENT_WORKSPACE_DIRECTORY_UNAVAILABLE', status: 503 })
  })

  it('keeps the known workspace fallback for memory fixtures', async () => {
    const deps = dependencies({ persistence: { mode: 'memory', incidents: new MemoryIncidentRepository() } })
    await expect(handleMcpOpsIncidentsFlags('ops.incidents.list', aggregateParams, {} as never, actor.workspaceId, deps))
      .resolves.toMatchObject({ aggregate: true, items: [] })
  })
})
