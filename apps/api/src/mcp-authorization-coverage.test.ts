import { describe, expect, it } from 'vitest'
import { persistenceReady, registeredMcpAuthorizationDecision, resolveAuthorizationResourceScope, resolveLoadedAuthorizationResourceScope, service, workspaceAccountPermissionAtoms } from './server.js'
import { AUTHZ_POLICY_VERSION, MCP_METHODS, getHttpOperationPolicy, getMcpMethodPolicy, type MethodPolicy } from '../../../packages/contracts/src/index.js'
import { MemoryBrandUnitRepository, type CanonicalProductRow } from '../../../packages/persistence/src/index.js'

/**
 * Records what each canonical read asked for and how many rows the storage
 * layer actually returned, so a test can assert a request is page-scoped
 * instead of catalog-scoped.
 */
class RecordingBrandUnits extends MemoryBrandUnitRepository {
  readonly calls: Array<{ workspaceId: string; brandIds?: readonly string[]; sourceProductIds?: readonly string[] }> = []
  readonly rowCounts: number[] = []
  override async listCanonicalProducts(input: { workspaceId: string; brandIds?: readonly string[]; sourceProductIds?: readonly string[] }): Promise<CanonicalProductRow[]> {
    this.calls.push({ ...input })
    const rows = await super.listCanonicalProducts(input)
    this.rowCounts.push(rows.length)
    return rows
  }
}

describe('registered MCP authorization coverage', () => {
  it('keeps HTTP account/task routes on the same MCP scope contract', () => {
    const cases = [
      ['DELETE', '/v1/platform-accounts/taobao', 'platform.revoke', 'account'],
      ['POST', '/v1/platform-accounts/taobao/sync', 'catalog.sync', 'workspace'],
      ['GET', '/v1/tasks/task_scope/timeline', 'task.timeline', 'brand'],
      ['POST', '/v1/tasks/task_scope/content', 'content.generate', 'brand'],
    ] as const
    for (const [method, path, mcpMethod, scope] of cases) {
      const http = getHttpOperationPolicy(method, path)
      expect(http, `${method} ${path}`).toMatchObject({ mcpMethod })
      expect(getMcpMethodPolicy(mcpMethod)).toMatchObject({ scope })
    }
  })

  it('projects a workspace role to an exact account only when the account belongs to that workspace', () => {
    const policy = getMcpMethodPolicy('platform.store.alias.set')!
    const workspaceAtom = {
      capability: policy.capability,
      effect: 'allow' as const,
      scope: { type: 'workspace' as const, ids: ['ws_scope'] },
      source: 'workspace_membership' as const,
      sourceId: 'membership_1',
      obligations: [] as const,
    }

    const allowed = workspaceAccountPermissionAtoms(policy, 'ws_scope', 'account_a', ['account_a', 'account_b'], [workspaceAtom])
    expect(allowed).toEqual(expect.arrayContaining([
      workspaceAtom,
      expect.objectContaining({ source: 'resource_grant', sourceId: 'workspace-account:ws_scope:account_a', scope: { type: 'account', ids: ['account_a'] } }),
    ]))
    expect(workspaceAccountPermissionAtoms(policy, 'ws_scope', 'account_foreign', ['account_a'], [workspaceAtom])).toEqual([workspaceAtom])
  })

  it('never derives an account grant from a temporary workspace grant', () => {
    const policy = getMcpMethodPolicy('platform.store.alias.set')!
    const temporaryWorkspaceAtom = {
      capability: policy.capability,
      effect: 'allow' as const,
      scope: { type: 'workspace' as const, ids: ['ws_scope'] },
      source: 'temporary_grant' as const,
      sourceId: 'grant_1',
      obligations: [] as const,
    }
    expect(workspaceAccountPermissionAtoms(policy, 'ws_scope', 'account_a', ['account_a'], [temporaryWorkspaceAtom])).toEqual([temporaryWorkspaceAtom])
  })

  it('uses the authoritative task account instead of a caller-selected account', async () => {
    const workspaceId = `ws_task_account_scope_${Date.now()}`
    const productId = `product_task_account_scope_${Date.now()}`
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'remote_task_account_scope', credentialRef: 'vault://task-account-scope' })
    const accountId = service.listPlatformAccounts(workspaceId)[0]!.id
    service.products.set(productId, {
      ...service.products.get('prod_fixture_1')!,
      id: productId,
      workspaceId,
      accountId,
    })
    const task = service.createTask({ workspaceId, productId, platform: 'taobao', accountId })
    const policy = getMcpMethodPolicy('platform.store.alias.set')!

    await expect(resolveLoadedAuthorizationResourceScope(policy, workspaceId, { task_id: task.id, account_id: 'account_b' })).resolves.toEqual({ type: 'account', id: accountId })
  })

  it('does not resolve a foreign task into a local account scope', async () => {
    const workspaceId = `ws_task_account_scope_local_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    const productId = `product_task_account_scope_foreign_${Date.now()}`
    service.registerPlatformAccount({ workspaceId: foreignWorkspaceId, platform: 'taobao', remoteAccountId: 'remote_foreign_task_scope', credentialRef: 'vault://foreign-task-scope' })
    const foreignAccountId = service.listPlatformAccounts(foreignWorkspaceId)[0]!.id
    service.products.set(productId, {
      ...service.products.get('prod_fixture_1')!,
      id: productId,
      workspaceId: foreignWorkspaceId,
      accountId: foreignAccountId,
    })
    const task = service.createTask({ workspaceId: foreignWorkspaceId, productId, platform: 'taobao', accountId: foreignAccountId })
    const policy = getMcpMethodPolicy('platform.store.alias.set')!

    await expect(resolveLoadedAuthorizationResourceScope(policy, workspaceId, { task_id: task.id, account_id: 'local_account' })).resolves.toEqual({ type: 'account', id: undefined })
  })

  it('scopes the canonical lookup of a task-bound request to that task product instead of the whole catalog', async () => {
    const suffix = Date.now()
    const workspaceId = `ws_task_canonical_scope_${suffix}`
    const productId = `product_task_canonical_scope_${suffix}`
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `remote_canonical_scope_${suffix}`, credentialRef: 'vault://canonical-scope' })
    const accountId = service.listPlatformAccounts(workspaceId)[0]!.id
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId, accountId })
    const created = service.createTask({ workspaceId, productId, platform: 'taobao', accountId })
    service.tasks.get(created.id)!.brandId = 'brand_task_scope'

    const persistence = await persistenceReady
    const previousBrandUnits = persistence.brandUnits
    const repository = new RecordingBrandUnits()
    persistence.brandUnits = repository
    try {
      await repository.createBrand({ workspaceId, id: 'brand_task_scope', name: 'Task brand' })
      await repository.createBrand({ workspaceId, id: 'brand_catalog_tail', name: 'Catalog tail brand' })
      await repository.createCanonicalProduct({ workspaceId, id: 'canonical_task_scope', brandId: 'brand_task_scope', title: 'Task product', sourceProductId: productId })
      // A catalog-sized tail whose rows this request must never read.
      for (let index = 0; index < 25; index += 1) {
        await repository.createCanonicalProduct({ workspaceId, id: `canonical_catalog_tail_${index}`, brandId: 'brand_catalog_tail', title: `Tail ${index}`, sourceProductId: `${productId}_tail_${index}` })
      }
      const policy = getMcpMethodPolicy('task.timeline')!

      // Reference verdict of the previous call shape, derived from the data the
      // old code read: the whole catalog plus a JS `sourceProductId === id`
      // filter. Stating it from the rows themselves keeps the comparison
      // independent of the implementation under test.
      const legacyCandidates = (await repository.listCanonicalProducts({ workspaceId })).filter(row => row.sourceProductId === productId)
      const legacyBrandIds = [...new Set(legacyCandidates.map(row => row.brandId))]
      expect(legacyCandidates).toHaveLength(1)
      expect(legacyBrandIds).toEqual(['brand_task_scope'])

      const scoped = await resolveLoadedAuthorizationResourceScope(policy, workspaceId, { task_id: created.id })

      // The page-scoped read must not change the authorization verdict.
      expect(scoped).toEqual({ type: 'brand', id: legacyBrandIds.length === 1 ? legacyBrandIds[0] : undefined })
      // The request only reads the rows bound to its own task product: the
      // whole catalog holds 26 canonical rows, this request reads exactly one.
      expect(repository.calls.at(-1)).toEqual({ workspaceId, sourceProductIds: [productId] })
      expect(repository.rowCounts.at(-1)).toBe(1)
      expect(await repository.listCanonicalProducts({ workspaceId })).toHaveLength(26)
    } finally {
      persistence.brandUnits = previousBrandUnits
    }
  })

  it('produces one unique strict authorization decision for every live MCP method', () => {
    const decisions = MCP_METHODS.map((method, index) => {
      const policy = getMcpMethodPolicy(method)
      expect(policy, `${method} must have an authorization policy`).toBeDefined()
      return registeredMcpAuthorizationDecision({
        decisionId: `coverage_${index}_${method}`,
        method,
        atoms: [],
        resourceScope: { type: policy!.scope, id: policy!.scope === 'platform' ? '*' : 'coverage-resource' },
        workbench: policy!.workbench,
        mode: 'enforce',
        now: '2026-09-01T00:00:00.000Z',
      })
    })

    expect(decisions).toHaveLength(MCP_METHODS.length)
    expect(new Set(decisions.map(decision => decision.decision_id)).size).toBe(MCP_METHODS.length)
    expect(decisions.map(decision => decision.method)).toEqual(MCP_METHODS)
    for (const decision of decisions) {
      expect(decision).toMatchObject({
        policy_version: AUTHZ_POLICY_VERSION,
        mode: 'enforce',
        enforced: true,
        authorized: false,
        allowed: false,
        result: 'deny',
        reason_code: 'AUTHZ_CAPABILITY_MISSING',
      })
    }
  })

  it('keeps workspace.bootstrap inside the same evaluator contract', () => {
    const decision = registeredMcpAuthorizationDecision({
      decisionId: 'coverage_bootstrap',
      method: 'workspace.bootstrap',
      atoms: [],
      resourceScope: { type: 'workspace', id: 'bootstrap-pending' },
      workbench: 'workspace',
      mode: 'enforce',
    })

    expect(decision).toMatchObject({
      method: 'workspace.bootstrap',
      policy_version: AUTHZ_POLICY_VERSION,
      mode: 'enforce',
      result: 'deny',
      reason_code: 'AUTHZ_CAPABILITY_MISSING',
    })
  })

  it.each([
    ['platform', {}, undefined, { type: 'platform', id: '*' }],
    ['workspace', {}, undefined, { type: 'workspace', id: 'ws_exact' }],
    ['self', {}, { actorId: 'actor_exact' }, { type: 'self', id: 'actor_exact' }],
    ['brand', { brand_id: ' brand_exact ' }, undefined, { type: 'brand', id: 'brand_exact' }],
    ['account', { account_id: ' account_exact ' }, undefined, { type: 'account', id: 'account_exact' }],
  ] as const)('resolves an exact %s scope without accepting an untrimmed identifier', (scope, params, principal, expected) => {
    const policy = { ...getMcpMethodPolicy('ops.session')!, scope } as MethodPolicy
    expect(resolveAuthorizationResourceScope(policy, ' ws_exact ', params, principal)).toEqual(expected)
  })

  it.each(['workspace', 'self', 'brand', 'account'] as const)('leaves a missing %s identifier unresolved so evaluation fails closed', scope => {
    const policy = { ...getMcpMethodPolicy('ops.session')!, scope } as MethodPolicy
    const resourceScope = resolveAuthorizationResourceScope(policy, '   ', { brand_id: ' ', account_id: '' })
    expect(resourceScope).toEqual({ type: scope, id: undefined })
  })
})
