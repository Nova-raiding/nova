import type { InvariantMutation } from './registry.js'

/**
 * Fragments are contributed per-invariant so two authors never edit the same
 * list. This file owns two invariants that were each fixed one call site at a
 * time and left their siblings asymmetric:
 *
 *   1. "what a brand restricted member can read" is decided by one predicate,
 *      and `workspace.metrics` had hand-copied every part of it except the
 *      publish job list;
 *   2. "a generation job in a terminal state is never rewritten and produces no
 *      side effects" is decided by one guard, and the `/defer` branch was the
 *      third sibling the previous round missed.
 *
 * The evidence runs against the real dependency, never a source-string match:
 * the durable product page is exercised on a real PostgreSQL 17 through the
 * full migration chain, and the two API rows drive the composition root over
 * real HTTP with the real service and event stream behind them.
 */
export const mutations: InvariantMutation[] = [
  {
    id: 'brand-visible-publish-jobs',
    chokepointSymbol: 'accessibleTaskScope',
    invariant:
      'A brand restricted member reads a publish job — its id, its task id and its platform rejection code — only when the task that owns it is visible to them, on every surface that aggregates publish jobs.',
    chokepoint: 'apps/api/src/server.ts',
    file: 'apps/api/src/server.ts',
    find: "const allPublishJobs = service.listPublishJobs(workspaceId).filter(job => taskScope.taskVisible(normalizedTaskById.get(job.taskId)))",
    replace: 'const allPublishJobs = service.listPublishJobs(workspaceId)',
    evidence: 'apps/api/src/catalog-brand-scope.e2e.test.ts',
    overRejection: {
      find: 'const allPublishJobs = service.listPublishJobs(workspaceId).filter(job => taskScope.taskVisible(normalizedTaskById.get(job.taskId)))',
      replace: 'const allPublishJobs = service.listPublishJobs(workspaceId).filter(() => false)',
      why: 'hiding every publish job from every member is the same defect as hiding none from the restricted one: an evidence file that only asserts the hidden brand is absent would still pass, so it has to fail here as well',
    },
    evidenceFailsWith: 'the metrics surface hides exactly the publish jobs the task scope hides',
    uniqueness: {
      callers: ['apps/api/src/server.ts'],
      noSecondImplementation: [
        {
          pattern: 'taskVisible\\(',
          sample: 'const allPublishJobs = service.listPublishJobs(workspaceId).filter(job => taskScope.taskVisible(normalizedTaskById.get(job.taskId)))',
          allow: ['apps/api/src/server.ts'],
          why: 'every surface that aggregates publish jobs has to route the visibility decision through `AccessibleTaskScope.taskVisible`; a surface that re-derives it (comparing brand ids by hand) is a second implementation of the same permission boundary',
        },
      ],
    },
    rationale:
      'This is the leak the audit found: `workspace.metrics` aggregated the unfiltered `service.listPublishJobs` while `GET /v1/publish-jobs` filtered the same list by task brand, so a restricted member received the hidden brand\'s task id, publish job id and rejection code through the PUBLISH_REJECTED risk item, jobs.publish, dataCoverage.publishJobs and platformMetrics, and then got a 404 for the same objects on the point reads. Removing the filter must turn the metrics evidence red; if it stays green, the evidence never exercised the publish-job path.',
  },
  {
    id: 'brand-durable-product-predicate',
    chokepointSymbol: 'accessibleProductBrandClause',
    invariant:
      'The durable product page hides exactly the products the in-memory predicate hides: a product is visible to a brand restricted member exactly when a canonical row for it is bound to a brand they hold a grant on, on every backend that answers the product page.',
    chokepoint: 'packages/persistence/src/product-brand-visibility.ts',
    file: 'packages/persistence/src/business-repository.ts',
    // The shared clause stays in the statement — so the brand parameter it
    // references is still bound — and the `OR TRUE` widens the page to "any
    // canonical row", which is the pre-fix predicate the audit found and what a
    // second implementation of this rule amounts to.
    find: '        clauses.push(accessibleProductBrandClause(values.length))',
    replace: '        clauses.push(accessibleProductBrandClause(values.length) + ` OR TRUE`)',
    evidence: 'packages/persistence/src/business-repository.postgres.test.ts',
    overRejection: {
      find: '        clauses.push(accessibleProductBrandClause(values.length))',
      replace: '        clauses.push(accessibleProductBrandClause(values.length) + ` AND FALSE`)',
      why: 'a durable page that hides every product from every restricted member is the mirror of one that hides none of them: the evidence must fail in both directions, or it only proves that the wider clause is gone',
    },
    evidenceFailsWith: 'products visible to a member granted only brand_visible',
    uniqueness: {
      callers: ['packages/persistence/src/business-repository.ts'],
      noSecondImplementation: [
        {
          pattern: 'cp\\.legacy_product_id = products\\.id',
          sample: 'AND cp.legacy_product_id = products.id AND cp.brand_id = ANY($${brandIndex}::text[])',
          allow: ['packages/persistence/src/product-brand-visibility.ts', 'tests/invariants'],
          why: 'the durable product-visibility clause is written once, in `accessibleProductBrandClause`; the same join in a second query is the third backend of this endpoint that made one product visible in the list, 404 on the point read and hidden in MCP catalog.search',
        },
        {
          pattern: 'canonicalLinkedProductIds|tasksByProduct|accessibleBrandSet',
          sample: "const canonicalLinkedProductIds = new Set(canonicalRows.map(row => row.sourceProductId).filter((value): value is string => Boolean(value)))",
          allow: ['tests/invariants'],
          why: 'the in-memory product predicate is built once, from canonical rows, in `visibleProductIds`; the removed second predicate — a canonical-link set plus a per-product task-brand map — is what let the list keep a legacy product the point read answered 404 for, and re-writing it here is that regression',
        },
      ],
    },
    requires: 'PERSISTENCE_RELEASE_DATABASE_URL',
    rationale:
      'The two backends of one endpoint disagreed, and so did two in-memory surfaces. The durable clause was `EXISTS(granted canonical) OR NOT EXISTS(any canonical)`; its replacement kept a task-brand fallback, so a legacy product with no canonical row whose task carried a granted brand was still listed while the point read (`assertProductBrandAccess`) and MCP `catalog.search` hid it — reproduced over real HTTP on the API (list: present, point read: 404 PRODUCT_NOT_FOUND, catalog.search: absent). Converging meant choosing a direction: the durable page and the in-memory list now apply the narrower rule the point read already applied, so every surface fails closed and a restricted member with no grant reads no product. The evidence asserts the durable page equals `visibleProductIds` on the same fixture, on a real PostgreSQL 17 through the full migration chain.',
  },
  {
    id: 'terminal-generation-write-guard',
    chokepointSymbol: 'generationJobWriteRefused',
    invariant:
      'A generation job whose outcome is already decided is never rewritten and produces no side effects of a state change — no outbox event, no refund, no distributed slot release — while a failed job stays rewritable, because retry and defer legitimately move it back to queued.',
    chokepoint: 'packages/contracts/src/generation-job-state.ts',
    file: 'packages/contracts/src/generation-job-state.ts',
    find: '  return isGenerationJobTerminal(job.state)',
    replace: '  return false',
    evidence: 'apps/api/src/generation-late-failure-guard.e2e.test.ts',
    overRejection: {
      find: '  return isGenerationJobTerminal(job.state)',
      replace: '  return true',
      why: 'refusing every write, including the legitimate defer of a queued job the same function has to let through, is the mirror of refusing none: an evidence file that only proves one late replay was blocked would certify a guard that blocks the real path too',
    },
    evidenceFailsWith: 'the generation terminal guard lets exactly the writes the domain state allows',
    uniqueness: {
      noSecondImplementation: [
        {
          pattern: "'succeeded'\\s*\\|\\|[^\\n]*'failed'",
          sample: "if (envelope.data?.state === 'succeeded' || envelope.data?.state === 'failed') {",
          allow: ['tests/invariants'],
          why: 'the states whose outcome is decided are declared once, in `generation-job-state.ts`; a second place comparing one state against both literals is a second terminal-state predicate — the worker kept exactly that copy and it already disagreed with the API about `failed`, so the API treated a late failure report as writable while the worker dead-lettered the execution event',
        },
      ],
    },
    rationale:
      'The previous round fixed this by hand in two of the three sibling branches of `POST /v1/generation-jobs/:id/result` and left `/defer` unguarded, so a redelivered defer wrote a phantom `generation.deferred` event directly after `generation.completed`. Collapsing the decision into one function is the point, but the collapse stopped at the API boundary: the worker kept its own terminal set (`succeeded || failed`) in `assertGenerationExecution`, so a redelivered execution event for a failed job dead-lettered on the worker while the API still considered the job rewritable. Both sides now import one state table; the mutation neutralises the shared write guard and the evidence must catch it in both directions.',
  },
]
