import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS, type CustomerDelivery } from '../../../packages/persistence/src/customer-delivery-repository.js'

type Rpc<T = unknown> = {
  request_id?: string
  data: { result: T } | null
  error: { code: string; message?: string } | null
}
const token = 'customer-delivery-input-validation-test-token'
let server: typeof import('./server.js').server
let base = ''
let workspaceId = ''
let delivery: CustomerDelivery

async function call<T = unknown>(method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { target_workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Rpc<T> }
}

function successful<T>(response: Awaited<ReturnType<typeof call<T>>>): T {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.error).toBeNull()
  expect(response.body.data).not.toBeNull()
  return response.body.data!.result
}

async function currentDelivery() {
  return successful(await call<CustomerDelivery>('ops.customer-delivery.get', { delivery_id: delivery.id }))
}

function mutationParams() {
  return { delivery_id: delivery.id, expected_revision: String(delivery.revision) }
}

async function rejectedWithoutMutation(method: string, params: Record<string, unknown>, status = 400, code?: string) {
  const rejected = await call(method, params)
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(status)
  expect(rejected.body.data).toBeNull()
  if (code) expect(rejected.body.error?.code).toBe(code)
  else expect(['INVALID_REQUEST', 'CUSTOMER_DELIVERY_INVALID_INPUT']).toContain(rejected.body.error?.code)
  expect(rejected.body.request_id).toMatch(/^req_/u)
  expect(await currentDelivery()).toEqual(delivery)
}

// Real loopback MCP validation with isolated in-memory drafts. No uploaded
// assets, synthetic clean verdicts, scanner execution or payment occurs here.
describe('customer delivery input validation over loopback HTTP', () => {
  beforeAll(async () => {
    for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'PGHOST', 'ASSET_STORAGE_ENDPOINT']) {
      if (process.env[key]) throw new Error(`Use scripts/run-safe-tests.ts; inherited ${key} is not allowed`)
    }
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'false')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'customer-delivery-input-validation-session-secret')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { actor_id: 'customer-delivery-input-validation-operator', roles: ['platform_ops'], workbenches: ['platform'], workspaces: [] },
    }))
    server = (await import('./server.js')).server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback API did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  beforeEach(async () => {
    workspaceId = `ws_delivery_input_${randomUUID()}`
    delivery = successful(await call<CustomerDelivery>('ops.customer-delivery.create', { company_name: `输入校验草稿 ${randomUUID()}` }))
  })

  afterAll(async () => {
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it.each([
    ['companyName', 123], ['companyName', true], ['companyName', null], ['companyName', {}],
    ['contractNumber', 123], ['contractNumber', false], ['contractNumber', []],
    ['projectOwner', 123], ['projectOwner', {}], ['supportOwner', false], ['supportOwner', []],
    ['paymentStatus', 'unknown'], ['paymentStatus', true], ['paymentStatus', null],
    ['customerProfileStatus', 'done'], ['customerProfileStatus', true], ['customerProfileStatus', null],
    ['paymentDate', 123], ['paymentDate', {}], ['plannedGoLiveAt', false], ['plannedGoLiveAt', []],
  ])('rejects malformed profile field %s=%j with 400 and an unchanged draft', async (field, value) => {
    await rejectedWithoutMutation('ops.customer-delivery.update', {
      ...mutationParams(), patch_json: JSON.stringify({ [field as string]: value }),
    })
  })

  it.each([
    ['paymentDate', 'not-a-date'], ['paymentDate', '2026-02-30'], ['paymentDate', '2026-13-01'],
    ['paymentDate', '2026-09-14T01:00:00.000Z'],
    ['plannedGoLiveAt', 'not-a-date'], ['plannedGoLiveAt', '2026-02-30T01:00:00.000Z'],
    ['plannedGoLiveAt', '2026-10-01T25:00:00.000Z'],
    ['plannedGoLiveAt', '2026-10-01T09:00:00+16:00'],
    ['plannedGoLiveAt', '2026-10-01T09:00:00-16:00'],
    ['plannedGoLiveAt', '2026-10-01T09:00:00+23:59'],
    ['plannedGoLiveAt', '2026-10-01T09:00:00-23:59'],
    ['plannedGoLiveAt', '2026-10-01'], ['plannedGoLiveAt', '2026-10-01T09:00:00'],
  ])('rejects invalid calendar or timestamp input %s=%s atomically', async (field, value) => {
    await rejectedWithoutMutation('ops.customer-delivery.update', {
      ...mutationParams(), patch_json: JSON.stringify({ [field as string]: value }),
    })
  })

  it('preserves a valid date and explicit UTC instant, and permits clearing nullable draft fields', async () => {
    const fields = {
      contractNumber: 'INPUT-VALID-1',
      projectOwner: '项目负责人', supportOwner: '客服负责人',
      paymentDate: '2028-02-29', plannedGoLiveAt: '2026-10-01T01:00:00.000Z',
    }
    const saved = successful(await call<CustomerDelivery>('ops.customer-delivery.update', {
      ...mutationParams(), patch_json: JSON.stringify(fields),
    }))
    expect(saved).toMatchObject({ ...fields, paymentStatus: 'unpaid', customerProfileStatus: 'incomplete', trainingCompleted: false, effectiveAt: null })
    expect(saved.revision).toBe(delivery.revision + 1)
    expect(await currentDelivery()).toEqual(saved)
    delivery = saved
    const nullableFields = Object.fromEntries(Object.keys(fields).map(field => [field, null]))
    const cleared = successful(await call<CustomerDelivery>('ops.customer-delivery.update', {
      ...mutationParams(), patch_json: JSON.stringify(nullableFields),
    }))
    expect(cleared).toMatchObject({ ...nullableFields, paymentStatus: 'unpaid', trainingCompleted: false, effectiveAt: null })
    expect(cleared.revision).toBe(saved.revision + 1)
    expect(await currentDelivery()).toEqual(cleared)
  })

  it.each(['{', '{"companyName":"bad",}', 'null', '[]', '"not-an-object"'])('rejects damaged or wrong-shaped profile JSON %s', async patch_json => {
    await rejectedWithoutMutation('ops.customer-delivery.update', { ...mutationParams(), patch_json })
  })

  it.each(['0', '-1', '01', '1.5', '1e0', 'NaN', '99999999999', '', null, true, 1])('rejects invalid revision %j before changing profile or training', async expected_revision => {
    await rejectedWithoutMutation('ops.customer-delivery.update', {
      ...mutationParams(), expected_revision, patch_json: '{"supportOwner":"must not save"}',
    })
    await rejectedWithoutMutation('ops.customer-delivery.training.complete', {
      ...mutationParams(), expected_revision, completed: 'false', evidence_refs_json: '[]',
    })
  })

  it.each([
    ['ops.customer-delivery.update', { patch_json: '{"supportOwner":"must not save"}' }],
    ['ops.customer-delivery.checklist.update', { checklist_key: 'customer_profile', completed: 'false' }],
    ['ops.customer-delivery.training.complete', { completed: 'false', evidence_refs_json: '[]' }],
  ])('rejects a mismatched revision on %s without making a completion claim', async (method, params) => {
    await rejectedWithoutMutation(method as string, { ...mutationParams(), ...(params as Record<string, unknown>), expected_revision: String(delivery.revision + 1) }, 409, 'CUSTOMER_DELIVERY_REVISION_CONFLICT')
  })

  it.each(['yes', 'TRUE', '', null, true, false, 1, {}])('rejects a non-contract completion value %j on checklist and training', async completed => {
    await rejectedWithoutMutation('ops.customer-delivery.checklist.update', { ...mutationParams(), checklist_key: 'customer_profile', completed })
    await rejectedWithoutMutation('ops.customer-delivery.training.complete', { ...mutationParams(), completed, evidence_refs_json: '[]' })
  })

  it.each(['{', '{}', 'null', '[{"itemKey":"插件账号","completed":false},]'])('rejects damaged or wrong-shaped checklist JSON %s', async items_json => {
    await rejectedWithoutMutation('ops.customer-delivery.checklist.update', { ...mutationParams(), checklist_key: 'system_integration', items_json })
  })

  it.each([
    { items: [null] }, { items: [{ itemKey: '插件账号', completed: null }] }, { items: [{ itemKey: 1, completed: false }] },
    { items: [{ itemKey: '插件账号', completed: 'yes' }] }, { items: [{ itemKey: '插件账号', completed: false, evidence: [] }] },
  ])('rejects malformed nested checklist items $items before recording any item', async ({ items }) => {
    await rejectedWithoutMutation('ops.customer-delivery.checklist.update', { ...mutationParams(), checklist_key: 'system_integration', items_json: JSON.stringify(items) })
    expect(successful(await call<{ items: unknown[] }>('ops.customer-delivery.checklist-items.list', { delivery_id: delivery.id, checklist_key: 'system_integration' })).items).toEqual([])
  })

  it.each(['["asset_training",]', '{}', 'null', '"asset_training"'])('rejects non-array or broken training evidence JSON %s', async evidence_refs_json => {
    await rejectedWithoutMutation('ops.customer-delivery.training.complete', { ...mutationParams(), completed: 'false', evidence_refs_json })
  })

  it('completes manually confirmed training without an evidence upload', async () => {
    const trained = successful(await call<CustomerDelivery>('ops.customer-delivery.training.complete', { ...mutationParams(), completed: 'true', evidence_refs_json: '[]' }))
    expect(trained).toMatchObject({ trainingCompleted: true, trainingEvidenceRefs: [] })
  })

  it('does not complete an unfilled customer profile through the scalar endpoint', async () => {
    await rejectedWithoutMutation('ops.customer-delivery.checklist.update', { ...mutationParams(), checklist_key: 'customer_profile', completed: 'true' }, 400, 'CUSTOMER_DELIVERY_INVALID_INPUT')
  })

  describe('remaining storage and draft boundary regressions', () => {
    it.each(['A', '企'])('enforces the existing 200-character company limit for %s profile updates', async character => {
      const saved = successful(await call<CustomerDelivery>('ops.customer-delivery.update', {
        ...mutationParams(), patch_json: JSON.stringify({ companyName: character.repeat(200) }),
      }))
      expect(saved.companyName).toBe(character.repeat(200))
      expect(saved.revision).toBe(delivery.revision + 1)
      delivery = saved
      await rejectedWithoutMutation('ops.customer-delivery.update', {
        ...mutationParams(), patch_json: JSON.stringify({ companyName: character.repeat(201) }),
      }, 400, 'INVALID_REQUEST')
    })

    it.each([
      { companyName: '公司\u0000名称' },
      { contractNumber: 'CONTRACT\u0000NUMBER' },
      { projectOwner: '项目\u0000负责人' },
      { supportOwner: '售后\u0000负责人' },
      { contractRef: 'https://example.test/contracts/\u0000file.pdf' },
      { paymentEvidenceRefs: ['asset_ref_payment\u0000bad'] },
    ])('rejects PostgreSQL-unrepresentable NUL text before draft mutation (%j)', async patch => {
      await rejectedWithoutMutation('ops.customer-delivery.update', {
        ...mutationParams(), patch_json: JSON.stringify(patch),
      }, 400, 'INVALID_REQUEST')
    })

    it('rejects NUL company text at the create boundary without creating a second record', async () => {
      const rejected = await call('ops.customer-delivery.create', { company_name: '新公司\u0000名称' })
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(400)
      expect(rejected.body.error?.code).toBe('INVALID_REQUEST')
      expect(rejected.body.data).toBeNull()
      const listed = successful(await call<{ items: CustomerDelivery[] }>('ops.customer-delivery.list', {}))
      expect(listed.items).toEqual([delivery])
    })

    it('rejects NUL training references even when saving an incomplete draft', async () => {
      await rejectedWithoutMutation('ops.customer-delivery.training.complete', {
        ...mutationParams(), completed: 'false', evidence_refs_json: JSON.stringify(['asset_ref_training\u0000bad']),
      }, 400, 'INVALID_REQUEST')
    })

    it('retains empty optional draft strings without inventing missing business length limits', async () => {
      const draftFields = { contractNumber: '', projectOwner: '  ', supportOwner: '', customerProfileStatus: 'incomplete' }
      const saved = successful(await call<CustomerDelivery>('ops.customer-delivery.update', {
        ...mutationParams(), patch_json: JSON.stringify(draftFields),
      }))
      expect(saved).toMatchObject({ ...draftFields, paymentStatus: 'unpaid', trainingCompleted: false, effectiveAt: null })
      expect(saved.revision).toBe(delivery.revision + 1)
      expect(await currentDelivery()).toEqual(saved)
    })

    it('does not let an HTTPS URL complete a profile without uploaded scanned contract evidence', async () => {
      const attemptedProfile = {
        contractNumber: 'COMPLETE-PROFILE-ONLY', contractRef: 'https://example.test/contracts/profile-only.pdf',
        projectOwner: '项目负责人', supportOwner: '售后负责人',
        plannedGoLiveAt: '2026-10-01T01:00:00.000Z', customerProfileStatus: 'complete',
      }
      await rejectedWithoutMutation('ops.customer-delivery.update', {
        ...mutationParams(), patch_json: JSON.stringify(attemptedProfile),
      }, 400, 'INVALID_REQUEST')
    })
  })

  describe('incomplete checklist JSON storage boundaries', () => {
    const evidenceCases = [
      { label: 'note', evidence: { note: '备注\u0000内容' } },
      { label: 'asset reference', evidence: { asset_refs: ['asset_ref_pending\u0000invalid'] } },
      { label: 'JSON object key', evidence: { ['备注\u0000键']: '内容' } },
      { label: 'nested note', evidence: { details: [{ note: '备注\u0000内容' }] } },
      { label: 'nested JSON object key', evidence: { details: [{ ['备注\u0000键']: null }] } },
    ]

    for (const checklistKey of ['system_integration', 'functional_acceptance'] as const) {
      for (const mode of ['batch', 'single'] as const) {
        const method = mode === 'batch' ? 'ops.customer-delivery.checklist.update' : 'ops.customer-delivery.checklist-item.update'
        const paramsFor = (evidence: Record<string, unknown>) => ({
          ...mutationParams(), checklist_key: checklistKey,
          ...(mode === 'batch'
            ? { items_json: JSON.stringify(CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[checklistKey].map((itemKey, index) => ({ itemKey, completed: false, evidence: index === 0 ? evidence : {} }))) }
            : { item_key: CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[checklistKey][0], completed: 'false', evidence_json: JSON.stringify(evidence) }),
        })

        it.each(evidenceCases)(`rejects NUL in $label on incomplete ${checklistKey} ${mode} before reaching persistence`, async ({ evidence }) => {
          await rejectedWithoutMutation(method, paramsFor(evidence), 400, 'INVALID_REQUEST')
          const listed = successful(await call<{ items: unknown[] }>('ops.customer-delivery.checklist-items.list', { delivery_id: delivery.id, checklist_key: checklistKey }))
          expect(listed.items).toEqual([])
        })

        it(`allows manually reviewed incomplete ${checklistKey} ${mode} notes without uploaded evidence`, async () => {
          successful(await call(method, paramsFor({ note: '人工核验记录\n下一步', asset_refs: [] })))
          const listed = successful(await call<{ items: unknown[] }>('ops.customer-delivery.checklist-items.list', { delivery_id: delivery.id, checklist_key: checklistKey }))
          expect(listed.items.length).toBeGreaterThan(0)
        })
      }

      it(`rejects NUL in the string evidence shorthand for incomplete ${checklistKey} batch`, async () => {
        await rejectedWithoutMutation('ops.customer-delivery.checklist.update', {
          ...mutationParams(), checklist_key: checklistKey,
          items_json: JSON.stringify(CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS[checklistKey].map((itemKey, index) => ({ itemKey, completed: false, evidence: index === 0 ? '备注\u0000内容' : '' }))),
        }, 400, 'INVALID_REQUEST')
        const listed = successful(await call<{ items: unknown[] }>('ops.customer-delivery.checklist-items.list', { delivery_id: delivery.id, checklist_key: checklistKey }))
        expect(listed.items).toEqual([])
      })
    }
  })
})

describe('customer delivery parsed JSON NUL guard', () => {
  it.each([
    { value: '\u0000' },
    { value: ['safe', '\u0000'] },
    { value: { note: '\u0000' } },
    { value: { ['\u0000']: 'safe' } },
    { value: { nested: [{ note: '\u0000' }] } },
    { value: { nested: [{ ['\u0000']: null }] } },
  ])('rejects PostgreSQL-unrepresentable parsed JSON atomically (%j)', async ({ value }) => {
    const { validateCustomerDeliveryJsonNoNul } = await import('./customer-delivery-profile-validation.js')
    expect(() => validateCustomerDeliveryJsonNoNul(value)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', status: 400 }))
  })

  it('preserves nullable drafts, Unicode, whitespace and literal backslash-u text', async () => {
    const { validateCustomerDeliveryJsonNoNul } = await import('./customer-delivery-profile-validation.js')
    const value = { note: '备注\n\t\r\\u0000', empty: '', entries: [null, false, 0, {}, []] }
    const before = structuredClone(value)
    expect(() => validateCustomerDeliveryJsonNoNul(value)).not.toThrow()
    expect(value).toEqual(before)
  })

  it('inspects deeply nested parsed JSON without recursive stack overflow', async () => {
    const { validateCustomerDeliveryJsonNoNul } = await import('./customer-delivery-profile-validation.js')
    const depth = 6_000
    const valid = JSON.parse(`${'['.repeat(depth)}null${']'.repeat(depth)}`)
    expect(() => validateCustomerDeliveryJsonNoNul(valid)).not.toThrow()
    const invalid = JSON.parse(`${'['.repeat(depth)}"\\u0000"${']'.repeat(depth)}`)
    expect(() => validateCustomerDeliveryJsonNoNul(invalid)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', status: 400 }))
  })
})
