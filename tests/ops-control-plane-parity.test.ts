import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MCP_METHODS, MCP_METHOD_SCHEMAS } from '../packages/contracts/src/mcp.js'

const rpcMocks = vi.hoisted(() => {
  const response = (method: string): unknown => {
    if (method === 'ops.finance.search') return {
      records: [],
      summary: {
        totalRecords: 0, rechargeOrderCny: 0, subscriptionOrderCny: 0,
        walletCreditCny: 0, walletDebitCny: 0, walletNetCny: 0,
        providerCostCny: 0, customerChargeCny: 0, usageUnits: 0,
        byKind: { recharge_order: 0, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 },
      },
      snapshotAt: '2026-08-29T01:00:00.000Z',
      scope: { role: 'finance', workspaceCount: 1 },
    }
    if (method === 'ops.finance.export') return { exportId: 'finance-export', fileName: 'finance.csv', contentType: 'text/csv; charset=utf-8', csv: '', rowCount: 0, truncated: false, snapshotAt: '2026-08-29T01:00:00.000Z' }
    if (method === 'ops.audit.list') return { records: [], totalRecords: 0, truncated: false }
    if (method === 'ops.audit.export') return { exportId: 'audit-export', fileName: 'audit.csv', contentType: 'text/csv; charset=utf-8', csv: '', rowCount: 0, truncated: false }
    return {}
  }
  return {
    rpc: vi.fn<(method: string, params?: Record<string, string>) => Promise<unknown>>(async method => response(method)),
    rpcForWorkspace: vi.fn<(workspaceId: string, method: string, params?: Record<string, string>) => Promise<unknown>>(async (_workspaceId, method) => response(method)),
    OPS_EXPORT_TIMEOUT_MS: 30_000,
    MAX_OPS_EXPORT_RESPONSE_BYTES: 16 * 1024 * 1024,
  }
})

vi.mock('../apps/ops-console/src/api/opsClient.js', () => rpcMocks)

import { auditCenterClient, financeSearchClient } from '../apps/ops-console/src/api/opsDomainClients.js'

const root = process.cwd()
const contractsSource = readFileSync(resolve(root, 'packages/contracts/src/mcp.ts'), 'utf8')
const serverSource = readFileSync(resolve(root, 'apps/api/src/server.ts'), 'utf8')
const openapiSource = readFileSync(resolve(root, 'apps/api/openapi.yaml'), 'utf8')

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    if (!['.ts', '.tsx'].includes(extname(entry.name)) || /\.test\.[^.]+$/u.test(entry.name)) return []
    return [readFileSync(path, 'utf8')]
  })
}

const opsUiSource = productionSources(resolve(root, 'apps/ops-console/src')).join('\n')
const uiMethods = [...new Set(
  [...opsUiSource.matchAll(/['"](ops\.[a-z0-9.-]+)['"]/gu)].map(match => match[1]!),
)].sort()

function openapiMethods(): string[] {
  const enumBody = openapiSource.match(/^\s+enum:\s*\[(merchant\.start[^\]]+)\]\s*$/mu)?.[1]
  expect(enumBody, 'OpenAPI McpRequest.method enum is missing').toBeDefined()
  return enumBody!.split(',').map(value => value.trim())
}

function hasServerHandler(method: string): boolean {
  return serverSource.includes(`case '${method}'`)
    || serverSource.includes(`method === '${method}'`)
}

function schema(method: keyof typeof MCP_METHOD_SCHEMAS) {
  const value = MCP_METHOD_SCHEMAS[method]
  expect(value, `${method} is missing its MCP parameter schema`).toBeDefined()
  return value
}

function expectRequired(method: keyof typeof MCP_METHOD_SCHEMAS, names: readonly string[]) {
  const value = schema(method)
  for (const name of names) {
    expect(value.properties[name], `${method} must declare ${name}`).toBeDefined()
    expect(value.required ?? [], `${method} must require ${name}`).toContain(name)
  }
}

function expectProperty(method: keyof typeof MCP_METHOD_SCHEMAS, name: string) {
  expect(schema(method).properties[name], `${method} must declare ${name}`).toBeDefined()
}

describe('Ops control-plane parity gate', () => {
  it('keeps every production Ops UI method on the MCP, API handler and OpenAPI surfaces', () => {
    const allowlist = new Set<string>(MCP_METHODS)
    const documented = new Set(openapiMethods())

    expect(uiMethods.length, 'no Ops UI methods were discovered').toBeGreaterThan(0)
    for (const method of uiMethods) {
      expect(allowlist.has(method), `${method} is used by Ops UI but absent from MCP_METHODS`).toBe(true)
      expect(MCP_METHOD_SCHEMAS[method as keyof typeof MCP_METHOD_SCHEMAS], `${method} is used by Ops UI but has no MCP schema`).toBeDefined()
      expect(hasServerHandler(method), `${method} is used by Ops UI but has no API server handler`).toBe(true)
      expect(documented.has(method), `${method} is used by Ops UI but absent from OpenAPI`).toBe(true)
    }
  })

  it('removes deprecated plural and save-style names from every production surface', () => {
    const deprecated = [
      'ops.support.ticket.list',
      'ops.incidents.timeline',
      'ops.incidents.create',
      'ops.incidents.comment',
      'ops.incidents.transition',
      'ops.incidents.commander.assign',
      'ops.incidents.scope.update',
      'ops.feature-flags.save',
      'ops.feature-flags.emergency',
      'ops.feature-flags.events',
    ]
    const surfaces = { opsUiSource, contractsSource, serverSource, openapiSource }
    for (const method of deprecated) {
      for (const [surface, source] of Object.entries(surfaces)) {
        expect(source, `${surface} still contains deprecated ${method}`).not.toContain(`'${method}'`)
        expect(source, `${surface} still contains deprecated ${method}`).not.toContain(`"${method}"`)
        expect(source, `${surface} still contains deprecated ${method}`).not.toMatch(new RegExp(`(?:^|[\\s,\\[])${method.replaceAll('.', '\\.')}(?:$|[\\s,\\]])`, 'mu'))
      }
    }
  })

  it('requires concurrency, reason and idempotency evidence for domain mutations', () => {
    expectRequired('ops.support.ticket.create', ['idempotency_key'])
    expectRequired('ops.support.ticket.assign', ['expected_revision', 'idempotency_key'])
    expectRequired('ops.support.ticket.transition', ['expected_revision', 'reason', 'idempotency_key'])
    expectRequired('ops.support.ticket.comment', ['expected_revision', 'idempotency_key'])

    expectRequired('ops.incident.create', ['idempotency_key'])
    expectRequired('ops.incident.transition', ['expected_revision', 'note', 'idempotency_key'])
    expectRequired('ops.incident.comment', ['expected_revision', 'body', 'idempotency_key'])
    expectRequired('ops.incident.commander.assign', ['expected_revision', 'note', 'idempotency_key'])
    expectRequired('ops.incident.scope.update', ['expected_revision', 'note', 'idempotency_key'])

    expectRequired('ops.feature-flag.upsert', ['reason', 'idempotency_key'])
    expectProperty('ops.feature-flag.upsert', 'expected_revision')
    expectRequired('ops.feature-flag.emergency.set', ['expected_revision', 'reason', 'idempotency_key'])

    expectRequired('ops.member.upsert', ['reason'])
    expectProperty('ops.member.upsert', 'expected_revision')
    expectRequired('ops.member.suspend', ['expected_revision', 'reason'])
  })

  it('keeps finance and audit reads bounded and exports cursor-free', () => {
    for (const method of ['ops.finance.search', 'ops.audit.list'] as const) {
      const limit = schema(method).properties.limit
      expect(limit?.maxLength, `${method} limit must be bounded to three digits`).toBe(3)
      expect(new RegExp(limit?.pattern ?? '').test('100'), `${method} must allow 100`).toBe(true)
      expect(new RegExp(limit?.pattern ?? '').test('101'), `${method} must reject 101`).toBe(false)
      expect(schema(method).properties.cursor?.maxLength, `${method} cursor must be bounded`).toBeLessThanOrEqual(4_096)
    }

    for (const method of ['ops.finance.export', 'ops.audit.export'] as const) {
      expect(schema(method).properties.cursor, `${method} must not accept a pagination cursor`).toBeUndefined()
      const contract = contractsSource.match(new RegExp(`method: '${method.replaceAll('.', '\\.')}'[^\\n]+`, 'u'))?.[0]
      expect(contract, `${method} contract is missing`).toContain('5000')
    }

    expect(schema('ops.finance.search').properties.workspace_ids_json?.maxLength).toBeLessThanOrEqual(33_000)
    expect(schema('ops.finance.search').properties.text?.maxLength).toBeLessThanOrEqual(200)
    expect(schema('ops.audit.list').properties.sources_json?.maxLength).toBeLessThanOrEqual(128)
    expect(schema('ops.audit.detail').properties.source?.enum?.length).toBeGreaterThan(0)
  })

  it('sends finance and audit requests inside their declared wire schemas', async () => {
    rpcMocks.rpc.mockClear()
    rpcMocks.rpcForWorkspace.mockClear()
    rpcMocks.rpc.mockImplementation(async method => {
      if (method === 'ops.finance.search') return {
        records: [],
        summary: {
          totalRecords: 0,
          rechargeOrderCny: 0,
          subscriptionOrderCny: 0,
          walletCreditCny: 0,
          walletDebitCny: 0,
          walletNetCny: 0,
          providerCostCny: 0,
          customerChargeCny: 0,
          usageUnits: 0,
          byKind: {
            recharge_order: 0,
            wallet_transaction: 0,
            subscription_order: 0,
            usage_entry: 0,
            model_usage: 0,
          },
        },
        snapshotAt: '2026-08-29T01:00:00.000Z',
        scope: { role: 'platform_ops', workspaceCount: 1 },
      }
      if (method === 'ops.finance.export') return {
        exportId: 'finance-export', fileName: 'finance.csv',
        contentType: 'text/csv; charset=utf-8', csv: '', rowCount: 0,
        truncated: false, snapshotAt: '2026-08-29T01:00:00.000Z',
      }
      if (method === 'ops.audit.list') return { records: [], totalRecords: 0, truncated: false }
      if (method === 'ops.audit.export') return {
        exportId: 'audit-export', fileName: 'audit.csv',
        contentType: 'text/csv; charset=utf-8', csv: '', rowCount: 0,
        truncated: false,
      }
      return {}
    })
    rpcMocks.rpcForWorkspace.mockImplementation(async (_workspaceId, method) => {
      if (method === 'ops.audit.list') return { records: [], totalRecords: 0, truncated: false }
      if (method === 'ops.audit.export') return {
        exportId: 'audit-export', fileName: 'audit.csv',
        contentType: 'text/csv; charset=utf-8', csv: '', rowCount: 0,
        truncated: false,
      }
      return {}
    })
    const financeQuery = {
      workspaceIds: ['workspace-a'],
      kinds: ['recharge_order' as const],
      statuses: ['paid'],
      text: 'order',
      fromAt: '2026-08-01T00:00:00.000Z',
      toAt: '2026-08-29T00:00:00.000Z',
      cursor: 'finance-cursor',
      snapshotAt: '2026-08-29T01:00:00.000Z',
      limit: 100,
    }
    const auditQuery = {
      workspaceId: 'workspace-a',
      text: 'member',
      sources: ['operation' as const],
      actorId: 'operator-a',
      action: 'member.upsert',
      resourceType: 'workspace_member',
      fromAt: '2026-08-01T00:00:00.000Z',
      toAt: '2026-08-29T00:00:00.000Z',
      cursor: 'audit-cursor',
      limit: 100,
    }

    await financeSearchClient.search(financeQuery)
    await financeSearchClient.exportCsv(financeQuery)
    await auditCenterClient.list(auditQuery)
    await auditCenterClient.exportCsv(auditQuery)

    const calls = ([
      ...(rpcMocks.rpc.mock.calls as unknown as Array<[keyof typeof MCP_METHOD_SCHEMAS, Record<string, string>]>).map(([method, params]) => ({ method, params })),
      ...(rpcMocks.rpcForWorkspace.mock.calls as unknown as Array<[string, keyof typeof MCP_METHOD_SCHEMAS, Record<string, string>]>).map(([, method, params]) => ({ method, params })),
    ] as unknown) as Array<{ method: keyof typeof MCP_METHOD_SCHEMAS; params: Record<string, string> }>
    expect(calls.map(call => call.method).sort()).toEqual([
      'ops.audit.export', 'ops.audit.list', 'ops.finance.export', 'ops.finance.search',
    ])
    for (const call of calls) {
      const contract = schema(call.method)
      expect(Object.keys(call.params).filter(key => !(key in contract.properties)), `${call.method} sends off-contract parameters`).toEqual([])
      expect(contract.required?.filter(key => key !== 'workspace_id' && !(key in call.params)) ?? [], `${call.method} omits required parameters`).toEqual([])
      expect(Object.values(call.params).every(value => typeof value === 'string'), `${call.method} must serialize wire values as strings`).toBe(true)
    }
    expect(calls.find(call => call.method === 'ops.finance.export')?.params).not.toHaveProperty('cursor')
    expect(calls.find(call => call.method === 'ops.audit.export')?.params).not.toHaveProperty('cursor')
  })
})
