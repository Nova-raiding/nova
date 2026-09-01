import type { McpMethod } from './mcp.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type HttpAuthenticationKind = 'identity' | 'worker' | 'asset_scanner' | 'signed_asset' | 'oauth_callback' | 'payment_callback' | 'infrastructure' | 'metrics' | 'mcp'

export interface HttpOperationPolicy {
  operation: `http:${HttpMethod}:${string}`
  method: HttpMethod
  pathTemplate: string
  authentication: HttpAuthenticationKind
  mcpMethod?: McpMethod
}

const identity = (method: HttpMethod, pathTemplate: string, mcpMethod: McpMethod): HttpOperationPolicy => ({
  operation: `http:${method}:${pathTemplate}`,
  method,
  pathTemplate,
  authentication: 'identity',
  mcpMethod,
})
const machine = (method: HttpMethod, pathTemplate: string, authentication: Exclude<HttpAuthenticationKind, 'identity'>): HttpOperationPolicy => ({
  operation: `http:${method}:${pathTemplate}`,
  method,
  pathTemplate,
  authentication,
})

/**
 * Versioned authorization inventory for the documented HTTP surface.
 * Identity routes intentionally reference an MCP method policy so capability,
 * scope, workbench, audit and obligation semantics have one source of truth.
 */
export const HTTP_OPERATION_POLICIES = [
  machine('GET', '/v1/public/assets/{assetId}/display', 'signed_asset'),
  // Capability evidence is a redacted merchant-facing read model; platform
  // settings and credential mutation remain governed by platform scope.
  identity('GET', '/v1/platform-capabilities', 'workspace.health'),
  identity('GET', '/v1/delivery-readiness', 'workspace.health'),
  identity('GET', '/v1/commercial/access', 'commercial.access.get'),
  identity('GET', '/v1/commercial/catalog', 'commercial.catalog.get'),
  identity('GET', '/v1/creative-points/balance', 'creative-points.balance.get'),
  identity('GET', '/v1/creative-points/statement', 'creative-points.statement.list'),
  identity('GET', '/v1/catalog/categories', 'catalog.categories'),
  identity('GET', '/v1/rules', 'rule.list'),
  identity('GET', '/v1/rules/audit', 'ops.rules.workspace.audit'),
  identity('POST', '/v1/rules/{packId}/versions', 'knowledge.rule.create'),
  identity('POST', '/v1/rules/{packId}/versions/{version}/status', 'rule.status'),
  identity('GET', '/v1/brand-profile', 'brand.get'),
  identity('PUT', '/v1/brand-profile', 'brand.upsert'),
  identity('POST', '/v1/brand-profile/extract', 'brand.extract'),
  identity('GET', '/v1/image-generation-jobs', 'catalog.image.get'),
  identity('GET', '/v1/image-generation-jobs/{jobId}', 'catalog.image.get'),
  identity('GET', '/v1/assets', 'asset.list'),
  identity('POST', '/v1/assets', 'asset.upload'),
  identity('GET', '/v1/assets/{assetId}/products', 'asset.list'),
  identity('GET', '/v1/products/{productId}/assets', 'catalog.search'),
  identity('GET', '/v1/products/{productId}', 'catalog.search'),
  identity('POST', '/v1/products/{productId}/assets', 'catalog.product.update'),
  identity('DELETE', '/v1/products/{productId}/assets', 'catalog.product.update'),
  identity('PUT', '/v1/assets/{assetId}/preference', 'asset.preference.update'),
  identity('PUT', '/v1/assets/{assetId}/rights', 'asset.rights.update'),
  identity('POST', '/v1/assets/{assetId}/facts', 'asset.facts.confirm'),
  identity('POST', '/v1/assets/upload', 'asset.upload'),
  machine('POST', '/v1/assets/{assetId}/scan', 'worker'),
  identity('POST', '/v1/assets/{assetId}/parse', 'asset.parse'),
  identity('GET', '/v1/assets/{assetId}/download', 'asset.list'),
  machine('GET', '/v1/internal/assets/{assetId}/scan-content', 'asset_scanner'),
  machine('POST', '/v1/internal/assets/{assetId}/scan-result', 'asset_scanner'),
  identity('GET', '/v1/platform-accounts', 'platform.store.list'),
  identity('POST', '/v1/platform-accounts/{platform}/authorize', 'platform.connect'),
  identity('DELETE', '/v1/platform-accounts/{platform}', 'platform.revoke'),
  identity('POST', '/v1/platform-accounts/{platform}/sync', 'catalog.sync'),
  identity('GET', '/v1/sync-jobs', 'catalog.sync.get'),
  identity('POST', '/v1/sync-jobs', 'catalog.sync.start'),
  identity('GET', '/v1/sync-jobs/{jobId}', 'catalog.sync.get'),
  machine('POST', '/v1/sync-jobs/{jobId}/progress', 'worker'),
  machine('GET', '/v1/sync-jobs/{jobId}/execution-context', 'worker'),
  machine('POST', '/v1/sync-jobs/{jobId}/result', 'worker'),
  identity('POST', '/v1/sync-jobs/{jobId}/retry-failed', 'sync.retry_failed'),
  identity('GET', '/v1/products', 'catalog.search'),
  identity('GET', '/v1/products/{productId}/image-review', 'catalog.image.get'),
  identity('POST', '/v1/products/{productId}/confirm', 'catalog.facts.confirm'),
  identity('POST', '/v1/products/import/batch', 'catalog.import.batch'),
  identity('POST', '/v1/products/import', 'catalog.import'),
  identity('GET', '/v1/tasks', 'task.history'),
  identity('POST', '/v1/tasks', 'task.create'),
  identity('POST', '/v1/task-groups', 'task.group.create'),
  identity('POST', '/v1/tasks/understand', 'task.understand'),
  identity('POST', '/v1/task-requests', 'task.request.create'),
  identity('GET', '/v1/tasks/{taskId}/directions', 'task.timeline'),
  identity('POST', '/v1/tasks/{taskId}/directions', 'task.select_direction'),
  identity('POST', '/v1/tasks/{taskId}/sku-split', 'task.sku.split'),
  identity('POST', '/v1/tasks/{taskId}/answers', 'task.answer'),
  identity('GET', '/v1/tasks/{taskId}', 'task.timeline'),
  identity('POST', '/v1/tasks/{taskId}/plan/confirm', 'task.plan.confirm'),
  identity('POST', '/v1/tasks/{taskId}/content-jobs', 'content.generate'),
  identity('POST', '/v1/tasks/{taskId}/content', 'content.generate'),
  identity('GET', '/v1/tasks/{taskId}/content-versions', 'content.versions'),
  identity('GET', '/v1/tasks/{taskId}/timeline', 'task.timeline'),
  identity('GET', '/v1/tasks/{taskId}/feedback', 'feedback.list'),
  identity('POST', '/v1/tasks/{taskId}/feedback', 'feedback.submit'),
  identity('POST', '/v1/tasks/{taskId}/approve', 'content.approve'),
  identity('GET', '/v1/content-versions/{contentVersionId}/diff', 'content.diff'),
  identity('GET', '/v1/content-versions/{contentVersionId}/review', 'content.review'),
  identity('POST', '/v1/content-versions/{contentVersionId}/review-decisions', 'content.review.decide'),
  identity('POST', '/v1/content-versions/{contentVersionId}/modify', 'content.modify'),
  identity('POST', '/v1/content-versions/{contentVersionId}/restore', 'content.restore'),
  identity('GET', '/v1/content-versions/{contentVersionId}/export', 'content.export'),
  identity('POST', '/v1/tasks/{taskId}/publish-preview', 'publish.prepare'),
  identity('GET', '/v1/publish-jobs', 'publish.batch.get'),
  identity('POST', '/v1/publish-jobs', 'publish.confirm'),
  identity('GET', '/v1/publish-jobs/{jobId}', 'publish.get'),
  machine('GET', '/v1/generation-jobs/{jobId}', 'worker'),
  machine('POST', '/v1/generation-jobs/{jobId}/defer', 'worker'),
  machine('POST', '/v1/generation-jobs/{jobId}/result', 'worker'),
  machine('GET', '/v1/worker-events/{eventId}/execution-check', 'worker'),
  machine('GET', '/v1/publish-jobs/{jobId}/execution-check', 'worker'),
  machine('GET', '/v1/publish-jobs/{jobId}/media', 'worker'),
  machine('POST', '/v1/publish-jobs/{jobId}/observation', 'worker'),
  identity('POST', '/v1/canonical-backfill/conflicts/scan', 'ops.canonical.backfill.run'),
  machine('POST', '/v1/internal/automation/tick', 'worker'),
  machine('POST', '/v1/internal/model-usage', 'worker'),
  machine('POST', '/v1/internal/model-usage/reconciliation', 'worker'),
  machine('POST', '/v1/internal/storage/reconciliation', 'worker'),
  machine('POST', '/v1/internal/support/sla-scan', 'worker'),
  machine('POST', '/v1/internal/support/sla-report', 'worker'),
  machine('POST', '/v1/internal/storage/orphans/cleanup', 'worker'),
  machine('POST', '/v1/internal/image-generation-jobs/reconciliation', 'worker'),
  machine('POST', '/v1/internal/image-generation-jobs/{jobId}/result', 'worker'),
  machine('POST', '/v1/internal/image-generation-jobs/{jobId}/execution', 'worker'),
  machine('POST', '/v1/internal/image-generation-jobs/{jobId}/reconciliation-evidence', 'worker'),
  machine('POST', '/v1/internal/image-generation-continuations/{jobId}/execute', 'worker'),
  machine('POST', '/v1/ops/data-deletion/complete', 'worker'),
  machine('POST', '/v1/billing/callback/{channel}', 'payment_callback'),
  machine('POST', '/v1/subscriptions/callback/{channel}', 'payment_callback'),
  machine('GET', '/v1/oauth/callback/{platform}', 'oauth_callback'),
  machine('GET', '/healthz', 'infrastructure'),
  machine('GET', '/readyz', 'infrastructure'),
  machine('GET', '/livez', 'infrastructure'),
  machine('GET', '/releasez', 'infrastructure'),
  machine('GET', '/metrics', 'metrics'),
  machine('POST', '/mcp', 'mcp'),
] as const satisfies readonly HttpOperationPolicy[]

function pathMatcher(pathTemplate: string) {
  const escaped = pathTemplate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\\{[^/]+\\\}/gu, '[^/]+')
  return new RegExp(`^${escaped}$`, 'u')
}

const compiledHttpPolicies = HTTP_OPERATION_POLICIES.map(policy => ({ policy, matcher: pathMatcher(policy.pathTemplate) }))

export function getHttpOperationPolicy(method: string | undefined, path: string): HttpOperationPolicy | undefined {
  // Route matching must happen on the same path grammar as the HTTP router.
  // Encoded separators can otherwise be accepted as an opaque resource ID by
  // this registry and decoded into a different route/resource by a downstream
  // handler. Keep the policy lookup fail-closed for malformed or ambiguous
  // paths; callers can return the normal unknown-route error envelope.
  if (!isSafeHttpPolicyPath(path)) return undefined
  const normalizedMethod = method?.toUpperCase()
  return compiledHttpPolicies.find(candidate => candidate.policy.method === normalizedMethod && candidate.matcher.test(path))?.policy
}

function isSafeHttpPolicyPath(path: string): boolean {
  if (!path.startsWith('/') || /[\\\u0000-\u001f\u007f]/u.test(path)) return false
  if (/%(?:2f|5c)/iu.test(path)) return false
  try {
    const decoded = decodeURIComponent(path)
    return !/[\\\u0000-\u001f\u007f]/u.test(decoded)
  } catch {
    return false
  }
}

export function assertHttpOperationPolicyCoverage() {
  const operations = HTTP_OPERATION_POLICIES.map(policy => policy.operation)
  const duplicates = operations.filter((operation, index) => operations.indexOf(operation) !== index)
  if (duplicates.length) throw new Error(`duplicate HTTP operation policies: ${[...new Set(duplicates)].join(', ')}`)
  for (const policy of HTTP_OPERATION_POLICIES) {
    if (policy.authentication === 'identity' && !policy.mcpMethod) throw new Error(`identity HTTP operation lacks MCP policy reference: ${policy.operation}`)
    if (policy.authentication !== 'identity' && policy.mcpMethod) throw new Error(`machine HTTP operation must not reference an identity MCP policy: ${policy.operation}`)
  }
  return { registered: operations.length, identity: HTTP_OPERATION_POLICIES.filter(policy => policy.authentication === 'identity').length }
}
