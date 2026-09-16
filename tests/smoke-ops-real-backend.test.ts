import { describe, expect, it } from 'vitest'
// @ts-expect-error The smoke CLI is intentionally a standalone native Node script.
import { configFromEnv, runSmoke } from '../infra/scripts/smoke-ops-real-backend.mjs'

const env = { OPS_SMOKE_API_BASE_URL: 'https://yxsona.com/api', OPS_SMOKE_WORKSPACE_ID: 'ws-real', OPS_SMOKE_EXPECT_WORKSPACE_ACTOR_ID: 'actor-workspace', OPS_SMOKE_EXPECT_PLATFORM_ACTOR_ID: 'actor-platform', OPS_SMOKE_WORKSPACE_TOKEN: 'secret-workspace', OPS_SMOKE_PLATFORM_TOKEN: 'secret-platform' }
const wsSession = { schema_version: 2, workbench: 'workspace', workspace_id: 'ws-real', actor_id: 'actor-workspace', workspace_granted: true, roles: ['workspace_owner'], capabilities: ['workspace.member.manage'], identity_id: 'identity-real', session_id: 'session-real' }
const platformSession = { schema_version: 2, workbench: 'platform', workspace_id: null, context_id: 'platform:global', actor_id: 'actor-platform', canonical_roles: ['platform_admin'], identity_id: 'identity-real', session_id: 'session-real' }
const model = { ownership: 'platform', user_key_binding: false, relay: { configured: true }, model_readiness: Object.fromEntries(['text', 'image', 'image_edit', 'ocr', 'video'].map(kind => [kind, { ready: true }])), cost_evidence_by_modality: Object.fromEntries(['text', 'image', 'image_edit', 'ocr', 'video'].map(kind => [kind, true])) }
const replies: Record<string, unknown> = { 'workspace:ops.session': wsSession, 'workspace:ops.members.list': { items: [{ workspaceId: 'ws-real' }], total: 1 }, 'workspace:billing.status': { schema_version: 'commercial.billing-status.v2', workspace_id: 'ws-real', viewer: {}, model_access: {} }, 'workspace:knowledge.rule.list': [{ workspaceId: 'ws-real' }], 'workspace:ops.audit.list': { records: [{ workspaceId: 'ws-real' }] }, 'platform:ops.session': platformSession, 'platform:platform.model.status': model }

function fakeFetch(values = replies, deniedStatus?: number) {
  return async (_url: string, options: RequestInit) => {
    const rpc = JSON.parse(String(options.body))
    const headers = options.headers as Record<string, string>
    const key = `${headers['x-ops-workbench']}:${rpc.method}`
    expect(options.method).toBe('POST')
    expect(headers['x-workspace-id']).toBe(headers['x-ops-workbench'] === 'workspace' ? (deniedStatus && rpc.id === 'ops-smoke-denied-scope' ? 'ws-denied' : 'ws-real') : undefined)
    if (deniedStatus && rpc.id === 'ops-smoke-denied-scope') return new Response('', { status: deniedStatus })
    return new Response(JSON.stringify({ jsonrpc: '2.0', result: values[key] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

describe('desktop ops real-backend smoke', () => {
  it('fails closed without separate real credentials', () => {
    expect(() => configFromEnv({ ...env, OPS_SMOKE_PLATFORM_TOKEN: '' })).toThrow(/both authenticated/u)
    expect(() => configFromEnv({ ...env, OPS_SMOKE_API_BASE_URL: 'http://yxsona.com/api' })).toThrow(/HTTPS/u)
    expect(() => configFromEnv({ ...env, OPS_SMOKE_DENIED_WORKSPACE_ID: 'ws-real' })).toThrow(/must differ/u)
  })
  it('checks actual MCP responses across workspace and platform workbenches', async () => {
    const result = await runSmoke(configFromEnv(env), fakeFetch())
    expect(result.checks).toHaveLength(7)
    expect(await runSmoke(configFromEnv({ ...env, OPS_SMOKE_DENIED_WORKSPACE_ID: 'ws-denied' }), fakeFetch(replies, 403))).toMatchObject({ checks: expect.arrayContaining(['ops.members.list:denied_scope']) })
    await expect(runSmoke(configFromEnv({ ...env, OPS_SMOKE_DENIED_WORKSPACE_ID: 'ws-denied' }), fakeFetch(replies, 200))).rejects.toThrow(/not explicitly rejected/u)
  })
  it('rejects cross-tenant backend rows and fixture markers', async () => {
    await expect(runSmoke(configFromEnv(env), fakeFetch({ ...replies, 'workspace:ops.members.list': { items: [{ workspaceId: 'other' }], total: 1 } }))).rejects.toThrow(/tenant-scoped/u)
    await expect(runSmoke(configFromEnv(env), fakeFetch({ ...replies, 'platform:platform.model.status': { ...model, provider_host: 'fixture.example.test' } }))).rejects.toThrow(/fixture marker/u)
  })
})
