import type { McpMethod } from './mcp.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type HttpAuthenticationKind = 'identity' | 'worker' | 'asset_scanner' | 'signed_asset' | 'oauth_callback' | 'payment_callback' | 'infrastructure' | 'metrics' | 'mcp'

export interface HttpOperationPolicy {
  operation: `http:${HttpMethod}:${string}`
  method: HttpMethod
  pathTemplate: string
  authentication: HttpAuthenticationKind
  mcpMethod?: McpMethod
  /** Authenticated operations route with no merchant MCP equivalent. */
  identityOnly?: boolean
}

const identity = (method: HttpMethod, pathTemplate: string, mcpMethod: McpMethod): HttpOperationPolicy => ({
  operation: `http:${method}:${pathTemplate}`,
  method,
  pathTemplate,
  authentication: 'identity',
  mcpMethod,
})
const identityOnly = (method: HttpMethod, pathTemplate: string): HttpOperationPolicy => ({
  operation: `http:${method}:${pathTemplate}`,
  method,
  pathTemplate,
  authentication: 'identity',
  identityOnly: true,
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
  // Platform account provisioning. It is the same platform-only transport as
  // the registration queue and the authorization decision below: the router
  // authenticates the caller and then requires an operations role, and there is
  // no merchant MCP method for it (`authenticate` + `requireOperationsRole`).
  identityOnly('POST', '/v1/ops/merchant-accounts'),
  identityOnly('GET', '/v1/ops/merchant-registration-applications'),
  identityOnly('POST', '/v1/ops/merchant-registration-applications/review'),
  identityOnly('POST', '/v1/ops/merchant-accounts/authorize'),
  machine('GET', '/v1/public/assets/{assetId}/display', 'signed_asset'),
  // Capability evidence is a redacted merchant-facing read model; platform
  // settings and credential mutation remain governed by platform scope.
  identity('GET', '/v1/platform-capabilities', 'workspace.health'),
  identity('GET', '/v1/delivery-readiness', 'workspace.health'),
  identity('GET', '/v1/commercial/access', 'commercial.access.get'),
  identity('GET', '/v1/commercial/catalog', 'commercial.catalog.get'),
  identity('POST', '/v1/commercial/orders', 'commercial.order.create'),
  identity('GET', '/v1/commercial/orders/{orderId}/payment', 'commercial.order.payment.get'),
  identity('GET', '/v1/creative-points/balance', 'creative-points.balance.get'),
  identity('GET', '/v1/creative-points/statement', 'creative-points.statement.list'),
  identity('GET', '/v1/catalog/categories', 'catalog.categories'),
  identity('GET', '/v1/rules', 'rule.list'),
  identity('GET', '/v1/rules/audit', 'ops.rules.workspace.audit'),
  identity('POST', '/v1/rules/{packId}/versions', 'rule.publish'),
  identity('POST', '/v1/rules/{packId}/versions/{version}/status', 'rule.status'),
  identity('GET', '/v1/brand-profile', 'brand.get'),
  identity('PUT', '/v1/brand-profile', 'brand.upsert'),
  identity('POST', '/v1/brand-profile/extract', 'brand.extract'),
  // The collection is workspace-scoped and filtered by accessible products in
  // the handler; an individual job remains brand-scoped below.
  identity('GET', '/v1/image-generation-jobs', 'catalog.search'),
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
  identity('GET', '/v1/ops/customer-deliveries/workspaces/{targetWorkspaceId}/{deliveryId}/assets/{assetId}/download', 'ops.customer-delivery.assets.get'),
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
  // The merchant HTTP endpoint only reads the product's images and runs the
  // deterministic local checker. It does not persist candidate review
  // evidence (that write-capable operation remains MCP-only), so keep this
  // transport on the workspace-scoped read policy. This prevents a product
  // without a canonical brand relation from being incorrectly denied before
  // the checker can explain its findings.
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
  machine('POST', '/v1/internal/billing/reconciliation', 'worker'),
  // Worker-owned knowledge embedding admission and outcome callbacks. They are
  // dispatched through `isWorkerRoute` and authenticated by the worker bearer
  // plus request signing, exactly like the reconciliation routes around them.
  machine('POST', '/v1/internal/knowledge-embeddings/admission', 'worker'),
  machine('POST', '/v1/internal/knowledge-embeddings/outcome', 'worker'),
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
  // The commercial settlement callback shares the provider proof boundary of
  // the two above: the router routes all three through the same
  // `/v1/{billing|subscriptions|commercial}/callback/{channel}` match and the
  // same HMAC-verified `verifyPaymentCallback` (timestamp + single-use nonce).
  // It is deliberately *not* an identity operation — an external payment
  // provider cannot present a merchant bearer, and registering it as identity
  // would break settlement.
  machine('POST', '/v1/commercial/callback/{channel}', 'payment_callback'),
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

/**
 * Route shapes the server dispatches without a registry entry, each with the
 * independent authentication boundary that already stands in front of it.
 *
 * These are not forgotten operations: they *are* the authentication protocol
 * (password sessions, the MCP OAuth authorization server, OAuth discovery) and
 * registering them would be actively wrong, not merely redundant. The router
 * consumes a registered policy in places a session endpoint must never reach:
 *
 * - `enforceRegisteredHttpCapability` would resolve a merchant capability for a
 *   request that has no identity yet;
 * - the commercial-access gate runs for every request that resolves to *any*
 *   policy, so a protocol endpoint would start answering
 *   `COMMERCIAL_OPERATION_UNCLASSIFIED` (503) instead of issuing a session.
 *
 * Keeping them here rather than silently absent is what lets the coverage
 * assertion tell a deliberate exemption apart from drift, and forces a written
 * reason for the next one.
 */
export interface HttpRouteCoverageExemption {
  pathTemplate: string
  /**
   * The methods this exemption actually covers, read off the router's own
   * dispatch guard rather than assumed.
   *
   * Exempting a *path* is not the same as exempting every method on it: the
   * authorization review that this list forces is per-operation, and a new verb
   * on an already-exempt path would otherwise arrive with no review at all —
   * e.g. a second way to mint an ops bearer at an already-exempt path. Pinning
   * the verbs makes that addition fail the gate instead.
   */
  methods: readonly HttpMethod[]
  reason: string
}

const AUTH_FORM_METHODS: readonly HttpMethod[] = ['GET', 'POST']

export const HTTP_ROUTE_COVERAGE_EXEMPTIONS: readonly HttpRouteCoverageExemption[] = [
  // Password authentication. The router dispatches these before the identity
  // boundary and they authenticate by credentials, not by a bearer. The group
  // guard admits GET and POST and rejects everything else with 405.
  { pathTemplate: '/v1/auth/register', methods: AUTH_FORM_METHODS, reason: 'password registration; runs before the identity boundary' },
  { pathTemplate: '/v1/auth/login', methods: AUTH_FORM_METHODS, reason: 'password login; issues the session cookie that later requests present' },
  { pathTemplate: '/v1/auth/session', methods: AUTH_FORM_METHODS, reason: 'reads the caller session from the HttpOnly cookie' },
  { pathTemplate: '/v1/auth/logout', methods: AUTH_FORM_METHODS, reason: 'revokes the caller session from the HttpOnly cookie' },
  { pathTemplate: '/v1/auth/refresh', methods: AUTH_FORM_METHODS, reason: 'rotates the caller session from the HttpOnly cookie' },
  { pathTemplate: '/v1/auth/password/reset-request', methods: AUTH_FORM_METHODS, reason: 'password reset request; unauthenticated by design' },
  { pathTemplate: '/v1/auth/password/reset-confirm', methods: AUTH_FORM_METHODS, reason: 'password reset confirmation; authenticated by the reset token' },
  { pathTemplate: '/v1/auth/password/change', methods: AUTH_FORM_METHODS, reason: 'password change; authenticated by the caller session cookie' },
  { pathTemplate: '/v1/auth/mcp-token', methods: AUTH_FORM_METHODS, reason: 'local desktop MCP token exchange; authenticated by the caller session cookie plus origin check' },
  { pathTemplate: '/v1/auth/mcp-token/refresh', methods: AUTH_FORM_METHODS, reason: 'local desktop MCP token refresh; authenticated by the refresh token itself' },
  { pathTemplate: '/v1/auth/mcp-token/revoke', methods: AUTH_FORM_METHODS, reason: 'local desktop MCP token revocation; authenticated by the token being revoked' },
  { pathTemplate: '/v1/auth/local-plugin/authorize', methods: AUTH_FORM_METHODS, reason: 'local desktop PKCE consent; GET renders explicit consent and POST requires the existing same-origin merchant session' },
  { pathTemplate: '/v1/auth/local-plugin/token', methods: ['POST'], reason: 'local desktop PKCE code exchange; authenticates the one-time code and verifier, not a ChatGPT OAuth client' },
  { pathTemplate: '/v1/auth/local-plugin/connect-requests', methods: ['POST'], reason: 'creates a browser-session-bound one-click local plugin request after same-origin validation' },
  { pathTemplate: '/v1/auth/local-plugin/connect-requests/{requestId}/status', methods: ['GET'], reason: 'polls only the current merchant session account and workspace request; never returns credentials' },
  { pathTemplate: '/v1/auth/local-plugin/install-instances/register', methods: ['POST'], reason: 'registers an untrusted P-256 public installation key and short-lived pairing capability without tenant access' },
  { pathTemplate: '/v1/auth/local-plugin/install-instances/pair', methods: ['POST'], reason: 'pairs an installation through an authenticated same-origin merchant session and one-time capability' },
  // Local Ops Console bootstrap. Disabled unless OPS_LOCAL_SESSION_ENABLED is
  // set outside production, answers 404 otherwise, requires a loopback host and
  // loopback origin, and gets its bearer from the API environment. The dispatch
  // guard is `req.method === 'GET'`.
  { pathTemplate: '/v1/ops/local-session', methods: ['GET'], reason: 'local-only ops console bootstrap; 404 outside the local Compose profile' },
]

/**
 * One routed operation as it is actually dispatched by
 * `apps/api/src/server.ts`, derived from the router source rather than restated
 * by hand. `method` is omitted when the dispatch guard is method-agnostic.
 */
export interface DispatchedHttpOperation {
  method?: HttpMethod
  path: string
  /** Where in the server source this dispatch was read from, for failure messages. */
  evidence: string
}

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const compiledExemptions = HTTP_ROUTE_COVERAGE_EXEMPTIONS.map(exemption => ({
  exemption,
  matcher: pathMatcher(exemption.pathTemplate),
}))

/**
 * An exemption covers a dispatch only when it covers the dispatched *method*.
 *
 * Matching on the path alone would let a new verb on an already-exempt path
 * through without the review this gate exists to force — the shape of the next
 * `POST /v1/ops/local-session`, say, which would be a second way to mint an ops
 * bearer. That path is attributed a method by the parser, so the addition is
 * caught.
 *
 * Residual, stated rather than papered over: when the parser cannot attribute a
 * method — it falls back to method-agnostic whenever the guard's method sits on
 * a non-continuation earlier line, which is the case for the whole
 * `/v1/auth/*` group at `server.ts:20395` — the exemption still covers by path,
 * and a new verb there would not be reported by this gate. That group's own
 * dispatch guard admits only GET and POST and answers 405 otherwise, so the
 * addition is rejected at runtime, but the review this gate forces does not
 * extend to it. Closing that belongs to the parser, not here.
 */
function exemptionCovers(candidate: (typeof compiledExemptions)[number], entry: DispatchedHttpOperation): boolean {
  if (!candidate.matcher.test(entry.path)) return false
  if (entry.method === undefined) return true
  return candidate.exemption.methods.includes(entry.method)
}

function dispatchedOperationIsCovered(entry: DispatchedHttpOperation): boolean {
  if (compiledExemptions.some(candidate => exemptionCovers(candidate, entry))) return true
  if (entry.method) return getHttpOperationPolicy(entry.method, entry.path) !== undefined
  return HTTP_METHODS.some(method => getHttpOperationPolicy(method, entry.path) !== undefined)
}

/**
 * Coverage gate for the HTTP surface.
 *
 * The duplicate and shape checks always run. When the caller passes the
 * operations the server really dispatches — `tests/http-route-authz-coverage.test.ts`
 * reads them out of the router source — the gate also fails on drift in both
 * directions:
 *
 * - a dispatched route with no registered policy and no exemption, i.e. a route
 *   whose authorization nobody reviewed; and
 * - an exemption that no longer matches any dispatched route, i.e. a reason that
 *   outlived the route it was written for.
 *
 * Drift used to be undetectable here because the registry and the router were
 * only ever compared by hand. The inventory is derived from the dispatcher so
 * this check cannot itself go stale.
 */
export function assertHttpOperationPolicyCoverage(dispatched: readonly DispatchedHttpOperation[] = []) {
  const operations = HTTP_OPERATION_POLICIES.map(policy => policy.operation)
  const duplicates = operations.filter((operation, index) => operations.indexOf(operation) !== index)
  if (duplicates.length) throw new Error(`duplicate HTTP operation policies: ${[...new Set(duplicates)].join(', ')}`)
  for (const policy of HTTP_OPERATION_POLICIES) {
    if (policy.authentication === 'identity' && !policy.mcpMethod && !policy.identityOnly) throw new Error(`identity HTTP operation lacks MCP policy reference: ${policy.operation}`)
    if (policy.authentication !== 'identity' && policy.mcpMethod) throw new Error(`machine HTTP operation must not reference an identity MCP policy: ${policy.operation}`)
  }
  const uncovered = dispatched.filter(entry => !dispatchedOperationIsCovered(entry))
  if (uncovered.length) {
    throw new Error(`HTTP routes dispatched by apps/api/src/server.ts without an authorization policy: ${uncovered.map(entry => `${entry.method ?? '*'} ${entry.path} [${entry.evidence}]`).join(', ')}`)
  }
  const staleExemptions = dispatched.length
    ? compiledExemptions.filter(candidate => !dispatched.some(entry => candidate.matcher.test(entry.path)))
    : []
  if (staleExemptions.length) {
    throw new Error(`HTTP route coverage exemptions no longer dispatched by apps/api/src/server.ts: ${staleExemptions.map(candidate => candidate.exemption.pathTemplate).join(', ')}`)
  }
  return { registered: operations.length, identity: HTTP_OPERATION_POLICIES.filter(policy => policy.authentication === 'identity').length }
}
