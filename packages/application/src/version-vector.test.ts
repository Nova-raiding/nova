import { describe, expect, it } from 'vitest'
import { DomainError, MerchantService } from './service.js'

describe('content version provenance vector', () => {
  it('stores immutable provenance and exports it with the delivery manifest', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)

    expect(version.versionVector).toMatchObject({
      assetVersionIds: [`product:${task.productId}:v1`],
      taskInputSnapshotId: `task:${task.id}:v2`,
      ruleSnapshotId: 'rules:cn-commerce-1.0.0,taobao-apparel-1.0.0,apparel-1.0.0',
      mappingVersion: 'taobao.mapping.v1',
      pluginVersion: '0.1.0',
      skillBundleVersion: '0.1.0',
      mcpVersion: '0.1.0',
      connectorBuild: 'local',
      modelId: 'deterministic-fixture',
      promptBundleVersion: 'fixture-1.0.0',
      createdBy: 'system',
      reason: 'fixture_draft',
    })

    const manifest = JSON.parse(service.exportContent('ws_demo', version.id, 'manifest').body) as { version_vector: Record<string, unknown> }
    expect(manifest.version_vector).toEqual(version.versionVector)

    const restored = service.restoreContentVersion('ws_demo', version.id).version
    expect(restored.versionVector?.reason).toBe(`restore:${version.id}`)
    expect(restored.versionVector?.createdAt).not.toBe(version.versionVector?.createdAt)
  })

  it('fails closed when a hydrated task snapshot is stale or crosses task scope', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    expect(() => service.hydrateSnapshot({ entityType: 'task', entity: { ...task, inputSnapshotId: `task:${task.id}:v${task.version + 1}` } }))
      .toThrowError(expect.objectContaining({ code: 'TASK_SNAPSHOT_VERSION_INVALID', status: 409 }))
    const snapshot = service.getTask(task.id)
    expect(() => service.hydrateSnapshot({ entityType: 'task', entity: { ...snapshot, inputSnapshot: { id: snapshot.inputSnapshotId, taskId: snapshot.id, capturedAt: snapshot.createdAt, rulesCheckedAt: snapshot.createdAt, product: { ...service.products.get(task.productId)!, id: 'other-product' }, skuIds: [], ruleVersionIds: [], assets: [], promotions: [], stock: 1 } } }))
      .toThrowError(expect.objectContaining({ code: 'TASK_SNAPSHOT_INVALID', status: 409 }))
  })

  it('accepts reordered and newer task snapshots while rejecting stale or same-version conflicts', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    const reordered = Object.fromEntries(Object.entries(structuredClone(task)).reverse())
    expect(() => service.hydrateSnapshot({ entityType: 'task', entity: reordered })).not.toThrow()
    expect(() => service.hydrateSnapshot({ entityType: 'task', entity: { ...task, state: 'draft' } }))
      .toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }))
    service.hydrateSnapshot({ entityType: 'task', entity: { ...task, version: task.version + 1 } })
    expect(() => service.hydrateSnapshot({ entityType: 'task', entity: structuredClone(task) }))
      .toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }))
  })

  it('rejects conflicting content revision hydration', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const version = service.createDraft(task.id)
    service.hydrateSnapshot({ entityType: 'content_version', entity: structuredClone(version) })
    expect(() => service.hydrateSnapshot({ entityType: 'content_version', entity: { ...version, revision: version.revision + 1 } }))
      .toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }))
  })

  it('rejects stale task mutations instead of overwriting a newer client version', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    expect(() => service.selectDirection(task.id, 'A', task.version + 1)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }))
    const selected = service.selectDirection(task.id, 'A', task.version)
    const draft = service.createDraft(task.id)
    expect(() => service.approveContent(task.id, draft.id, undefined, selected.version - 1)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }))
  })

  it('persists resumable task answers and only unlocks facts after explicit confirmation', () => {
    const service = new MerchantService()
    const product = service.importProduct({ workspaceId: 'ws_answers', platform: 'taobao', remoteId: 'answers-1', title: '待确认商品', stock: 2, skuCount: 1 })
    const task = service.createTask({ workspaceId: 'ws_answers', productId: product.id, platform: 'taobao', requestText: '做一版春季上新详情页' })
    const answered = service.answerTask('ws_answers', task.id, { goal: '春季上新', confirm_facts: true }, task.version)
    expect(answered.inputSnapshotId).toBe(`task:${task.id}:v2`)
    expect(answered.answers).toMatchObject({ goal: '春季上新', confirm_facts: true })
    expect(answered.state).toBe('ready_for_direction')
    expect(answered.missingQuestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'audience', kind: 'recommended' }),
      expect.objectContaining({ id: 'asset_ids', kind: 'optional' }),
    ]))
    expect(answered.missingQuestions).toHaveLength(3)
  })

    it('recomputes progressive questions, allows non-blocking deferral, and never defers blockers', () => {
      const service = new MerchantService()
      const product = service.importProduct({ workspaceId: 'ws_questions', platform: 'taobao', remoteId: 'questions-1', title: '追问商品', stock: 2, skuCount: 1 })
    const task = service.createTask({ workspaceId: 'ws_questions', productId: product.id, platform: 'taobao', requestText: '制作详情页' })
    expect(task.missingQuestions).toHaveLength(4)
    expect(task.missingQuestions[0]).toMatchObject({ id: 'confirm_facts', kind: 'blocking' })
    expect(() => service.answerTask('ws_questions', task.id, { defer_questions: ['confirm_facts'] })).toThrowError(expect.objectContaining({ code: 'TASK_BLOCKING_QUESTION_REQUIRED' }))

    const answered = service.answerTask('ws_questions', task.id, { confirm_facts: true, goal: '新品上架' })
    expect(answered.state).toBe('ready_for_direction')
    expect(answered.missingQuestions.map(question => question.id)).toEqual(['audience', 'output_count', 'asset_ids'])
    const deferred = service.answerTask('ws_questions', task.id, { defer_questions: ['audience', 'output_count', 'asset_ids'] })
    expect(deferred.missingQuestions).toEqual([])
    expect(deferred.deferredQuestionIds).toEqual(['audience', 'output_count', 'asset_ids'])
    expect(deferred.deferredQuestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'audience', prompt: expect.any(String), why: expect.any(String), ifSkipped: expect.any(String) }),
      expect.objectContaining({ id: 'output_count', prompt: expect.any(String), why: expect.any(String), ifSkipped: expect.any(String) }),
    ]))
    const resumed = service.resumeTask('ws_questions', task.id)
    expect(resumed.pendingQuestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'audience', status: 'deferred', prompt: expect.any(String) }),
    ]))
    expect(resumed.nextAction).toContain('回答任一暂缓问题')

    const promotion = service.answerTask('ws_questions', task.id, { price_policy: '限时优惠价' })
    expect(promotion.state).toBe('draft')
    expect(promotion.missingQuestions[0]).toMatchObject({ id: 'activity_valid_until', kind: 'blocking' })
    expect(() => service.selectDirection(task.id, 'A')).toThrowError(expect.objectContaining({ code: 'INVALID_TASK_TRANSITION' }))
      const dated = service.answerTask('ws_questions', task.id, { activity_valid_until: '2026-09-01T00:00:00+08:00' })
      expect(dated.state).toBe('ready_for_direction')
      expect(dated.missingQuestions).toEqual([])
    })

    it('can clear deferred questions when they are later answered', () => {
      const service = new MerchantService()
      const product = service.importProduct({ workspaceId: 'ws_questions_reopen', platform: 'taobao', remoteId: 'questions-reopen-1', title: '追问可重开商品', stock: 4, skuCount: 1 })
      const task = service.createTask({ workspaceId: 'ws_questions_reopen', productId: product.id, platform: 'taobao', requestText: '紧急制作主图与详情页' })
      const afterSkip = service.answerTask('ws_questions_reopen', task.id, { confirm_facts: true, defer_questions: ['goal', 'audience'] })
      expect(afterSkip.missingQuestions).toHaveLength(1)
      expect(afterSkip.deferredQuestionIds).toEqual(['goal', 'audience'])

      const afterAnswer = service.answerTask('ws_questions_reopen', task.id, { audience: '通勤人群', goal: '清晰表达商品卖点' }, afterSkip.version)
      expect(afterAnswer.missingQuestions.map(question => question.id)).toEqual(expect.not.arrayContaining(['goal', 'audience']))
      expect(afterAnswer.deferredQuestionIds).toEqual([])
    })

    it('restores deferred questions across a new service session', () => {
      const service = new MerchantService({ seedFixture: false })
      const product = service.importProduct({ workspaceId: 'ws_questions_restart', platform: 'taobao', remoteId: 'questions-restart-1', title: '跨会话追问商品', stock: 4, skuCount: 1 })
      const task = service.createTask({ workspaceId: 'ws_questions_restart', productId: product.id, platform: 'taobao', requestText: '制作详情页' })
      const deferred = service.answerTask('ws_questions_restart', task.id, { confirm_facts: true, defer_questions: ['goal', 'audience'] })
      const restarted = new MerchantService({ seedFixture: false })
      restarted.hydrateSnapshot({ entityType: 'product', entity: structuredClone(product) })
      restarted.hydrateSnapshot({ entityType: 'task', entity: structuredClone(deferred) })
      const restored = restarted.getTask(task.id)
      expect(restored.deferredQuestionIds).toEqual(['goal', 'audience'])
      expect(restored.missingQuestions.map(question => question.id)).toEqual(['output_count', 'asset_ids'])
      const completed = restarted.answerTask('ws_questions_restart', task.id, { goal: '新品上架', audience: '通勤人群' }, restored.version)
      expect(completed.deferredQuestionIds).toEqual([])
    })

    it('limits every round to at most 4 questions and reduces optional round size for urgent tasks', () => {
      const service = new MerchantService()
      const skus = [
        { id: 's1', name: '白色', price: 99, stock: 12 },
        { id: 's2', name: '黑色', price: 109, stock: 8 },
      ]
      const product = service.importProduct({ workspaceId: 'ws_questions_cap', platform: 'taobao', remoteId: 'questions-cap-1', title: '多sku 商品', stock: 20, skuCount: 2, skus })
      const task = service.createTask({ workspaceId: 'ws_questions_cap', productId: product.id, platform: 'taobao', requestText: '紧急帮我做一版主图素材' })

      expect(task.missingQuestions).toHaveLength(3)

      const answered = service.answerTask('ws_questions_cap', task.id, { confirm_facts: true, sku_id: 's1', defer_questions: ['goal', 'audience', 'constraints'] })
      expect(answered.missingQuestions.length).toBeLessThanOrEqual(3)
      expect(answered.missingQuestions.length).toBeGreaterThan(0)
    })

  it('creates independent platform subtasks under one task group', () => {
    const service = new MerchantService()
    const taobao = service.importProduct({ workspaceId: 'ws_group', platform: 'taobao', remoteId: 'tb-group', title: '同款商品', stock: 1, skuCount: 1 })
    const jd = service.importProduct({ workspaceId: 'ws_group', platform: 'jd', remoteId: 'jd-group', title: '同款商品', stock: 1, skuCount: 1 })
    const group = service.createTaskGroup({ workspaceId: 'ws_group', requestText: '多平台上新', entries: [{ productId: taobao.id, platform: 'taobao' }, { productId: jd.id, platform: 'jd' }] })
    expect(new Set(group.tasks.map(task => task.taskGroupId))).toEqual(new Set([group.id]))
    expect(new Set(group.tasks.map(task => task.platform))).toEqual(new Set(['taobao', 'jd']))
    expect(group.tasks[0]?.id).not.toBe(group.tasks[1]?.id)
  })

  it('creates an idempotent multi-platform task group directly from an unambiguous request', () => {
    const service = new MerchantService({ seedFixture: false })
    const taobao = service.importProduct({ workspaceId: 'ws_request_create', platform: 'taobao', title: '淘宝春季防晒衣', stock: 1 })
    const douyin = service.importProduct({ workspaceId: 'ws_request_create', platform: 'douyin', title: '抖音春季防晒衣', stock: 1 })
    const requestText = `请把${taobao.title}和${douyin.title}做成春季上新详情页，发布到淘宝和抖音`
    const created = service.createTaskFromRequest({ workspaceId: 'ws_request_create', requestText, idempotencyKey: 'request-create-1' })
    expect(created.mode).toBe('split_by_platform')
    expect(created.tasks.map(task => task.platform).sort()).toEqual(['douyin', 'taobao'])
    expect(created.tasks.every(task => task.taskGroupId === created.taskGroupId)).toBe(true)
    const replay = service.createTaskFromRequest({ workspaceId: 'ws_request_create', requestText, idempotencyKey: 'request-create-1' })
    expect(replay.replayed).toBe(true)
    expect(replay.taskIds).toEqual(created.taskIds)
  })

  it('refuses natural-language auto creation when a platform has ambiguous products', () => {
    const service = new MerchantService({ seedFixture: false })
    service.importProduct({ workspaceId: 'ws_request_ambiguous', platform: 'taobao', title: '同名商品', stock: 1 })
    service.importProduct({ workspaceId: 'ws_request_ambiguous', platform: 'taobao', title: '同名商品', localProductKey: 'second', stock: 1 })
    expect(() => service.createTaskFromRequest({ workspaceId: 'ws_request_ambiguous', requestText: '把同名商品发布到淘宝' })).toThrowError(expect.objectContaining({ code: 'TASK_REQUEST_NEEDS_CLARIFICATION' }))
  })

  it('replays a single natural-language task and rejects a reused key with a different intent', () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_single_request', platform: 'taobao', title: '单任务商品', stock: 1 })
    const request = `请把${product.title}发布到淘宝`
    const created = service.createTaskFromRequest({ workspaceId: 'ws_single_request', requestText: request, idempotencyKey: 'single-request-1' })
    const replay = service.createTaskFromRequest({ workspaceId: 'ws_single_request', requestText: `  ${request}  `, idempotencyKey: 'single-request-1' })
    expect(replay.replayed).toBe(true)
    expect(replay.taskIds).toEqual(created.taskIds)
    expect(() => service.createTaskFromRequest({ workspaceId: 'ws_single_request', requestText: `请把${product.title}发布到淘宝，改成主图`, idempotencyKey: 'single-request-1' })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }))
  })

  it('validates the complete task group before writing children and allows one product per platform', () => {
    const service = new MerchantService({ seedFixture: false })
    const taobaoA = service.importProduct({ workspaceId: 'ws_atomic_group', platform: 'taobao', title: '淘宝 A', stock: 1 })
    const taobaoB = service.importProduct({ workspaceId: 'ws_atomic_group', platform: 'taobao', title: '淘宝 B', stock: 1 })
    const before = service.tasks.size
    expect(() => service.createTaskGroup({ workspaceId: 'ws_atomic_group', entries: [{ productId: taobaoA.id, platform: 'taobao' }, { productId: taobaoB.id, platform: 'pinduoduo' }] })).toThrowError(expect.objectContaining({ code: 'PLATFORM_SCOPE_MISMATCH' }))
    expect(service.tasks.size).toBe(before)
    expect(() => service.createTaskGroup({ workspaceId: 'ws_atomic_group', entries: [{ productId: taobaoA.id, platform: 'taobao' }, { productId: taobaoB.id, platform: 'taobao' }] })).toThrowError(expect.objectContaining({ code: 'TASK_GROUP_PLATFORM_DUPLICATE' }))
    expect(service.tasks.size).toBe(before)
  })

  it('bounds task groups before validating or creating child tasks', () => {
    const service = new MerchantService({ seedFixture: false })
    const entries = Array.from({ length: 51 }, (_, index) => ({ productId: `not-created-${index}`, platform: 'taobao' as const }))
    expect(() => service.createTaskGroup({ workspaceId: 'ws_group_limit', entries })).toThrowError(expect.objectContaining({ code: 'TASK_GROUP_LIMIT', status: 413 }))
    expect(service.tasks.size).toBe(0)
  })

  it('allows parallel task-group children for different stores on the same platform', () => {
    const service = new MerchantService({ seedFixture: false })
    const flagship = service.importProduct({ workspaceId: 'ws_multi_store_group', platform: 'taobao', accountId: 'taobao-flagship', title: '同款旗舰店', stock: 1 })
    const discount = service.importProduct({ workspaceId: 'ws_multi_store_group', platform: 'taobao', accountId: 'taobao-discount', title: '同款折扣店', stock: 1 })
    const group = service.createTaskGroup({ workspaceId: 'ws_multi_store_group', requestText: '同平台双店铺上新', entries: [{ productId: flagship.id, platform: 'taobao' }, { productId: discount.id, platform: 'taobao' }] })
    expect(group.tasks).toHaveLength(2)
    expect(group.tasks.map(task => task.accountId).sort()).toEqual(['taobao-discount', 'taobao-flagship'])
    expect(new Set(group.tasks.map(task => task.taskGroupId))).toEqual(new Set([group.id]))
  })

  it('replays an idempotent task group after hydration and rejects key reuse for a different intent', () => {
    const service = new MerchantService({ seedFixture: false })
    const taobao = service.importProduct({ workspaceId: 'ws_group_replay', platform: 'taobao', title: '淘宝防晒衣', localProductKey: 'tb-replay', stock: 10, price: 99 })
    const pinduoduo = service.importProduct({ workspaceId: 'ws_group_replay', platform: 'pinduoduo', title: '拼多多防晒衣', localProductKey: 'pdd-replay', stock: 20, price: 89 })
    const entries = [{ productId: taobao.id, platform: 'taobao' as const }, { productId: pinduoduo.id, platform: 'pinduoduo' as const }]
    const first = service.createTaskGroup({ workspaceId: 'ws_group_replay', entries, requestText: '多平台详情页', idempotencyKey: 'group-replay-1' })
    const replay = service.createTaskGroup({ workspaceId: 'ws_group_replay', entries: [...entries].reverse(), requestText: '多平台详情页', idempotencyKey: 'group-replay-1' })
    expect(replay).toMatchObject({ id: first.id, taskIds: first.taskIds, replayed: true })
    expect(service.tasks.size).toBe(2)

    const restarted = new MerchantService({ seedFixture: false })
    for (const task of first.tasks) restarted.hydrateSnapshot({ entityType: 'task', entity: structuredClone(task) })
    const afterRestart = restarted.createTaskGroup({ workspaceId: 'ws_group_replay', entries, requestText: '多平台详情页', idempotencyKey: 'group-replay-1' })
    expect(afterRestart).toMatchObject({ id: first.id, taskIds: first.taskIds, replayed: true })
    expect(() => service.createTaskGroup({ workspaceId: 'ws_group_replay', entries, requestText: '改成主图', idempotencyKey: 'group-replay-1' })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }))
  })

  it('creates a child version for local edits and enforces locked fields', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const source = service.createDraft(task.id)
    const modified = service.modifyContentVersion({ workspaceId: 'ws_demo', sourceVersionId: source.id, changes: { title: '新标题' }, lockedFields: ['detail'], reason: '调整标题' })
    expect(modified.version.parentId).toBe(source.id)
    expect(modified.version.body.title).toBe('新标题')
    expect(modified.version.state).toBe('review_required')
    expect(() => service.modifyContentVersion({ workspaceId: 'ws_demo', sourceVersionId: modified.version.id, changes: { detail: '不应修改' }, reason: '越过锁定字段' })).toThrowError(expect.objectContaining({ code: 'CONTENT_FIELD_LOCKED' }))
  })

  it('returns mergeable field differences when concurrent clients edit different fields', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const base = service.createDraft(task.id)
    const current = service.modifyContentVersion({ workspaceId: 'ws_demo', sourceVersionId: base.id, changes: { title: '客户端 A 标题' }, reason: '客户端 A 保存', expectedRevision: base.revision }).version

    let conflict: DomainError | undefined
    try {
      service.modifyContentVersion({ workspaceId: 'ws_demo', sourceVersionId: base.id, changes: { detail: '客户端 B 详情' }, reason: '客户端 B 保存', expectedRevision: base.revision })
    } catch (error) {
      conflict = error as DomainError
    }

    expect(conflict).toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 409,
      details: {
        current_version: current.version,
        expected_version: base.version,
        current_version_id: current.id,
        base_version_id: base.id,
        can_auto_merge: true,
        auto_mergeable_fields: ['body.detail'],
        conflicting_fields: [],
      },
    })
    expect(conflict?.details?.base_current_changes).toEqual(expect.arrayContaining([
      { path: 'body.title', before: base.body.title, after: '客户端 A 标题' },
    ]))
    expect(service.listContentVersions('ws_demo', task.id)).toHaveLength(2)
  })

  it('identifies overlapping concurrent edits and never exposes conflict details across workspaces', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const base = service.createDraft(task.id)
    service.modifyContentVersion({ workspaceId: 'ws_demo', sourceVersionId: base.id, changes: { title: '客户端 A 标题' }, reason: '客户端 A 保存', expectedRevision: base.revision })

    expect(() => service.modifyContentVersion({ workspaceId: 'ws_demo', sourceVersionId: base.id, changes: { title: '客户端 B 标题' }, reason: '客户端 B 保存', expectedRevision: base.revision }))
      .toThrowError(expect.objectContaining({
        code: 'VERSION_CONFLICT',
        details: expect.objectContaining({ can_auto_merge: false, auto_mergeable_fields: [], conflicting_fields: ['body.title'] }),
      }))

    let denied: DomainError | undefined
    try {
      service.modifyContentVersion({ workspaceId: 'ws_other', sourceVersionId: base.id, changes: { detail: '越权读取' }, reason: '越权请求', expectedRevision: base.revision })
    } catch (error) {
      denied = error as DomainError
    }
    expect(denied).toMatchObject({ code: 'TENANT_SCOPE_DENIED', status: 403 })
    expect(denied?.details).toBeUndefined()
    expect(JSON.stringify(denied)).not.toContain('客户端 A 标题')
  })

  it('regenerates one detail module without changing sibling modules or provenance', () => {
    const service = new MerchantService({ fixtureMode: true })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    const source = service.createDraft(task.id)
    const sourceModules = source.body.modules!
    const regenerated = service.regenerateContentModule({ workspaceId: 'ws_demo', sourceVersionId: source.id, moduleKey: 'hero', reason: '根据已确认事实重新生成首屏模块' })
    expect(regenerated.version.parentId).toBe(source.id)
    expect(regenerated.version.state).toBe('review_required')
    expect(regenerated.version.body.modules).toHaveLength(sourceModules.length)
    expect(regenerated.version.body.modules?.find(module => module.key === 'hero')).toMatchObject({ key: 'hero', contentKind: 'fact' })
    expect(regenerated.version.body.modules?.filter(module => module.key !== 'hero')).toEqual(sourceModules.filter(module => module.key !== 'hero'))
    expect(regenerated.version.factVersionIds).toEqual(source.factVersionIds)
    expect(() => service.regenerateContentModule({ workspaceId: 'ws_demo', sourceVersionId: source.id, moduleKey: 'hero', lockedFields: ['hero'], reason: '锁定模块不可重生成' })).toThrowError(expect.objectContaining({ code: 'CONTENT_FIELD_LOCKED' }))
  })

  it('returns explainable task understanding candidates and blocking questions', () => {
    const service = new MerchantService({ fixtureMode: true })
    const understanding = service.understandTaskRequest('ws_demo', '给轻云防晒外套 2026 做一版淘宝春季上新详情页')
    expect(understanding).toMatchObject({ platformCandidates: ['taobao'], extracted: { platform: 'taobao', product_id: 'prod_fixture_1' } })
    expect(understanding.questions).toEqual([])
    const incomplete = service.understandTaskRequest('ws_demo', '做一版春季上新详情页')
    expect(incomplete.questions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'platform', kind: 'blocking' }), expect.objectContaining({ id: 'product_id', kind: 'blocking' })]))
  })

  it('labels blocking-question provenance without inventing evidence for generic recommendations', () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_question_provenance', platform: 'taobao', title: '来源测试商品', stock: 1 })
    const task = service.createTask({ workspaceId: 'ws_question_provenance', productId: product.id, platform: 'taobao', requestText: '做淘宝详情页' })
    expect(task.missingQuestions).toContainEqual(expect.objectContaining({ id: 'confirm_facts', evidenceKind: 'catalog_fact' }))
    expect(task.missingQuestions?.find(question => question.id === 'placement')).toBeUndefined()

    service.confirmProductFacts('ws_question_provenance', product.id)
    service.answerTask('ws_question_provenance', task.id, { confirm_facts: true }, task.version)
    expect(task.missingQuestions).toContainEqual(expect.objectContaining({ id: 'goal', kind: 'recommended' }))
    expect(task.missingQuestions?.find(question => question.id === 'goal')?.evidenceKind).toBeUndefined()
  })

  it('returns stable product ids for an ambiguous product selection card', () => {
    const service = new MerchantService({ fixtureMode: true })
    service.importProduct({ workspaceId: 'ws_demo', platform: 'taobao', localProductKey: 'same-title-2', title: '轻云防晒外套 2026', stock: 2 })
    const understanding = service.understandTaskRequest('ws_demo', '给轻云防晒外套 2026 做淘宝详情页')
    const question = understanding.questions.find(item => item.id === 'product_id')

    expect(question).toMatchObject({
      kind: 'blocking',
      candidates: expect.arrayContaining(['prod_fixture_1']),
    })
    expect(question?.candidates).toHaveLength(2)
    expect(new Set(question?.candidates).size).toBe(2)
    expect(understanding.executionPlan.canCreate).toBe(false)
  })

  it('plans independent child tasks for multiple platforms without reusing one platform product', () => {
    const service = new MerchantService({ fixtureMode: true })
    const understanding = service.understandTaskRequest('ws_demo', '给轻云防晒外套 2026 同时做淘宝和拼多多详情页')
    expect(understanding.platformCandidates).toEqual(['taobao', 'pinduoduo'])
    expect(understanding.extracted.product_id).toBeUndefined()
    expect(understanding.executionPlan).toMatchObject({ mode: 'split_by_platform', canCreate: false, childTasks: [
      { platform: 'taobao', bindingState: 'ready', candidateProductIds: ['prod_fixture_1'] },
      { platform: 'pinduoduo', bindingState: 'missing', candidateProductIds: [] },
    ] })
    expect(understanding.questions).toContainEqual(expect.objectContaining({ id: 'platform_product_bindings', kind: 'blocking' }))
  })

  it('extracts the PRD task fields and carries them into the production plan', () => {
    const service = new MerchantService({ fixtureMode: true })
    const text = '给轻云防晒外套 2026 做淘宝详情页，目标：提升转化，面向通勤人群，主推轻便，场景：日常出行，活动价 99 元，有效期至 2026-09-30，做 2 套，不得使用绝对化表达'
    const understanding = service.understandTaskRequest('ws_demo', text)
    expect(understanding.extracted).toMatchObject({
      placement: '商品详情页', goal: '提升转化', audience: '通勤人群', selling_points: '轻便', scene: '日常出行',
      price_policy: '活动价 99 元', activity_valid_until: '2026-09-30', output_count: '2', constraints: '不得使用绝对化表达',
    })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', requestText: text })
    expect(task.answers).toMatchObject({ placement: '商品详情页', goal: '提升转化', audience: '通勤人群', selling_points: '轻便', scene: '日常出行', price_policy: '活动价 99 元', activity_valid_until: '2026-09-30', output_count: '2', constraints: '不得使用绝对化表达' })
    service.selectDirection(task.id, 'A')
    expect(task.productionPlan?.rulesCheckedAt).toBeUndefined()
    service.confirmProductionPlan('ws_demo', task.id, 'merchant')
    expect(task.productionPlan?.rulesCheckedAt).toEqual(expect.any(String))
    expect(task.productionPlan).toMatchObject({ placement: '商品详情页', goal: '提升转化', audience: '通勤人群', scene: '日常出行', activityValidUntil: '2026-09-30', constraints: '不得使用绝对化表达', outputCount: 2, rulesCheckedAt: expect.any(String) })
  })

  it('keeps fact evidence attached to direction and confirmed production selling points', () => {
    const service = new MerchantService({ fixtureMode: true })
    const product = service.importProduct({
      workspaceId: 'ws_demo', platform: 'taobao', localProductKey: 'evidence-product', title: '证据外套',
      sellingPoints: [{ id: 'sp-fabric', text: '防泼水面料', proofStatus: 'confirmed', sourceIds: ['product-field:fabric'] }],
    })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: product.id, platform: 'taobao' })
    service.answerTask('ws_demo', task.id, { confirm_facts: true, selling_points: ['防泼水面料'] })
    const directions = service.listCreativeDirections('ws_demo', task.id)
    expect(directions[0]?.sellingPointEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ text: '已确认商品事实', proofStatus: 'pending', factSourceIds: [] })]))
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_demo', task.id, 'merchant')
    expect(task.productionPlan?.sellingPointEvidence).toEqual([{ text: '防泼水面料', proofStatus: 'confirmed', factSourceIds: ['product-field:fabric'] }])
  })

  it('replaces the task entity when the merchant corrects product_id', () => {
    const service = new MerchantService({ fixtureMode: true, seedFixture: false })
    const first = service.importProduct({ workspaceId: 'ws_correction', platform: 'taobao', localProductKey: 'first', title: '候选一' })
    const second = service.importProduct({ workspaceId: 'ws_correction', platform: 'taobao', localProductKey: 'second', title: '候选二' })
    const task = service.createTask({ workspaceId: 'ws_correction', productId: first.id, platform: 'taobao', requestText: '做商品详情页' })
    service.answerTask('ws_correction', task.id, { product_id: second.id })
    expect(task.productId).toBe(second.id)
    expect(task.answers.product_id).toBe(second.id)
    expect(task.productionPlan).toBeUndefined()
    expect(() => service.answerTask('ws_correction', task.id, { product_id: first.id })).not.toThrow()
  })

  it('scopes the frozen plan and content provenance to the explicitly selected SKU', () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_sku_scope', platform: 'taobao', localProductKey: 'sku-scope', title: '多 SKU 商品', stock: 12, skus: [
      { id: 'sku-a', name: '蓝色/M', price: 99, stock: 5 },
      { id: 'sku-b', name: '黑色/L', price: 109, stock: 7 },
    ] })
    const task = service.createTask({ workspaceId: 'ws_sku_scope', productId: product.id, platform: 'taobao' })
    service.answerTask('ws_sku_scope', task.id, { confirm_facts: true, sku_id: 'sku-a' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_sku_scope', task.id, 'merchant')
    expect(task.productionPlan?.skuIds).toEqual(['sku-a'])
    expect(task.inputSnapshot?.skuIds).toEqual(['sku-a'])
    expect(task.inputSnapshot?.product.skus).toEqual([expect.objectContaining({ id: 'sku-a', price: 99, stock: 5 })])
  })

  it('atomically splits an unfrozen multi-SKU task into independent SKU delivery tasks', () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_sku_split', platform: 'taobao', localProductKey: 'sku-split', title: '可拆分多 SKU 商品', skus: [
      { id: 'sku-a', name: '蓝色/M', price: 99, stock: 5 },
      { id: 'sku-b', name: '黑色/L', price: 109, stock: 7 },
    ] })
    const source = service.createTask({ workspaceId: 'ws_sku_split', productId: product.id, platform: 'taobao', requestText: '制作多 SKU 详情页' })
    service.answerTask('ws_sku_split', source.id, { confirm_facts: true })
    const split = service.splitTaskBySku({ workspaceId: 'ws_sku_split', taskId: source.id, idempotencyKey: 'sku-split-1' })
    expect(split.skuIds).toEqual(['sku-a', 'sku-b'])
    expect(split.tasks.map(task => task.answers.sku_id)).toEqual(['sku-a', 'sku-b'])
    expect(split.tasks.every(task => task.taskGroupId === split.taskGroupId)).toBe(true)
    expect(split.tasks.every(task => task.answers.sku_id === 'sku-a' || task.answers.sku_id === 'sku-b')).toBe(true)
    const replay = service.splitTaskBySku({ workspaceId: 'ws_sku_split', taskId: source.id, idempotencyKey: 'sku-split-1' })
    expect(replay.replayed).toBe(true)
    expect(replay.taskIds).toEqual(split.taskIds)
  })

  it('recognizes a natural-language request to create one delivery package per SKU', () => {
    const service = new MerchantService({ seedFixture: false })
    const product = service.importProduct({ workspaceId: 'ws_nl_sku', platform: 'taobao', localProductKey: 'nl-sku', title: '自然语言多 SKU 商品', skus: [
      { id: 'sku-nl-a', name: '蓝色/M', price: 99, stock: 5 },
      { id: 'sku-nl-b', name: '黑色/L', price: 109, stock: 7 },
    ] })
    const request = '请把自然语言多 SKU 商品在淘宝每个 SKU 分别做详情页和主副图'
    const understanding = service.understandTaskRequest('ws_nl_sku', request)
    expect(understanding.executionPlan).toMatchObject({ mode: 'split_by_sku', splitBySku: true, canCreate: false })
    expect(understanding.questions).toContainEqual(expect.objectContaining({ id: 'sku_facts_confirmation', kind: 'blocking' }))
    service.confirmProductFacts('ws_nl_sku', product.id)
    const created = service.createTaskFromRequest({ workspaceId: 'ws_nl_sku', requestText: request, idempotencyKey: 'nl-sku-1' })
    expect(created.mode).toBe('split_by_sku')
    expect(created.tasks.map(task => task.answers.sku_id)).toEqual(['sku-nl-a', 'sku-nl-b'])
  })
})
