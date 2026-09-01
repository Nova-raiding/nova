import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'

function parseMcpRequestSchema(source: string) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line === '    McpRequest:')
  expect(start).toBeGreaterThanOrEqual(0)
  const endOffset = lines.slice(start + 1).findIndex(line => /^    \S/u.test(line))
  const block = lines.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset)
  const propertiesIndex = block.findIndex(line => line === '      properties:')
  expect(propertiesIndex).toBeGreaterThanOrEqual(0)
  const propertyLines = block.slice(propertiesIndex + 1)
  const properties = new Map<string, string[]>()
  for (let index = 0; index < propertyLines.length;) {
    const property = propertyLines[index]!.match(/^        ([\w]+):(?:\s.*)?$/u)?.[1]
    if (!property) { index += 1; continue }
    const nested: string[] = []
    index += 1
    while (index < propertyLines.length && !/^        [\w]+:/u.test(propertyLines[index]!)) {
      nested.push(propertyLines[index]!)
      index += 1
    }
    properties.set(property, nested)
  }
  const methodEnumLine = properties.get('method')?.find(line => /^          enum: \[/u.test(line))
  const methodEnum = methodEnumLine?.slice(methodEnumLine.indexOf('[') + 1, methodEnumLine.lastIndexOf(']')).split(',').map(item => item.trim()) ?? []
  return { block, properties, methodEnum }
}

describe('OpenAPI security contract', () => {
  it('documents the implemented security response/status surface and method allowlist', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/api/openapi.yaml'), 'utf8')
    for (const path of ['/v1/oauth/callback/{platform}:', '/v1/rules/audit:', '/v1/rules/{packId}/versions:', '/v1/rules/{packId}/versions/{version}/status:', '/v1/publish-jobs:', '/v1/publish-jobs/{jobId}:', '/v1/image-generation-jobs:', '/v1/image-generation-jobs/{jobId}:', '/mcp:']) expect(source).toContain(path)
    expect(source).toContain("REQUEST_BODY_TOO_LARGE")
    expect(source).toContain("'429': { $ref: '#/components/responses/ErrorEnvelope' }")
    expect(source).toContain('name: X-Workspace-Id')
    expect(source).toContain('name: Idempotency-Key')
    expect(source).toContain('publish.confirm')
    const publishConfirmSchema = source.slice(
      source.indexOf('    PublishConfirmRequest:'),
      source.indexOf('    PublishObservationRequest:'),
    )
    expect(publishConfirmSchema).toContain("confirmation_ticket_nonce_hash: { type: string, pattern: '^[a-f0-9]{64}$'")
    expect(publishConfirmSchema).toContain("confirmation_ticket_intent_hash: { type: string, pattern: '^[a-f0-9]{64}$'")
    expect(publishConfirmSchema).toContain('required: [task_id, content_version_id, confirmation_hash, remote_snapshot_hash]')
    expect(publishConfirmSchema).not.toMatch(/required: \[[^\]]*confirmation_ticket_/u)
    expect(source).toContain('X-Rule-Approval-Token')
    expect(source).toContain('rules_admin')
    expect(source).not.toContain('admin.raw_sql')
    const mcpRequest = parseMcpRequestSchema(source)
    expect(mcpRequest.properties.has('enum'), 'enum must be nested under properties.method').toBe(false)
    expect(mcpRequest.methodEnum).toEqual([...MCP_METHODS])
    expect(new Set(mcpRequest.methodEnum).size).toBe(mcpRequest.methodEnum.length)
    expect(mcpRequest.methodEnum.filter(method => method.startsWith('ops.audit.'))).toEqual([
      'ops.audit.list', 'ops.audit.platform.list', 'ops.audit.detail', 'ops.audit.export',
    ])
    for (const method of [
      'platform.media.spec.list', 'platform.media.spec.get', 'platform.media.spec.create',
      'platform.media.spec.update', 'platform.media.spec.approve', 'platform.media.spec.expire',
      'platform.mapping.preflight', 'delivery.bundle.verify',
    ]) expect(source).toMatch(new RegExp(`^            ${method.replaceAll('.', '\\.')}: '#/components/schemas/Mcp`, 'mu'))
    for (const schema of [
      'McpPlatformMediaSpecListParams', 'McpPlatformMediaSpecGetParams', 'McpPlatformMediaSpecCreateParams',
      'McpPlatformMediaSpecUpdateParams', 'McpPlatformMediaSpecTransitionParams',
      'McpPlatformMappingPreflightParams', 'McpDeliveryBundleVerifyParams',
      'McpMarketingImageReconcileParams', 'McpMarketingImageEvidenceExportParams', 'McpMarketingImageArchiveAuditParams', 'McpMarketingImageBillingAuditParams',
    ]) expect(source).toContain(`    ${schema}:`)
    for (const method of ['campaign.batch.pause', 'campaign.batch.resume']) {
      expect(source).toContain(`${method}: '#/components/schemas/McpCampaignBatchControlParams'`)
    }
    expect(source).toContain("campaign.batch.retry_failed: '#/components/schemas/McpCampaignBatchRetryFailedParams'")
    expect(source).toContain("brand-unit.bind-store: '#/components/schemas/McpBrandUnitBindStoreParams'")
    for (const method of ['ops.marketing.image.reconcile', 'ops.marketing.image.evidence.export', 'ops.marketing.image.archive.audit', 'ops.marketing.image.billing.audit']) {
      expect(source).toContain(`${method}: '#/components/schemas/McpMarketingImage`)
    }
    expect(source).toContain('    McpBrandUnitBindStoreParams:')
    expect(source).toContain('    McpCanonicalProductConsistencyBlocking:')
    expect(source).toContain('    McpCanonicalProductConsistencyNextAction:')
    expect(source).toContain('    McpCanonicalProductConsistencyOrphanFinding:')
    expect(source).toContain('    McpCanonicalProductConsistencyEvidence:')
    expect(source).toContain('    McpCanonicalProductConsistencyBlockingObject:')
    expect(source).toContain('    McpCanonicalProductConsistencyNextActionObject:')
    expect(source).toContain('    McpCanonicalProductReadControl:')
    expect(source).toContain('    McpCanonicalProductUnifiedLinkAudit:')
    expect(source).toContain('required: [workspaceId, status, contractVersion, contractStatus, generatedAt, readMode, freshness, revision, availability, blocking, counts, findings, orphanFindings, readOnly, cutover, source, durable, read_control, unified_link_audit]')
    expect(source).toContain('method: { type: string, enum: [brand-unit.product.create, brand-unit.listing.create, canonical.product.consistency] }')
    expect(source).toContain('entityType: { type: string, enum: [canonical_product, listing, campaign_item, task, publish_job] }')
    const canonicalSchemas = source.slice(source.indexOf('    McpCanonicalProductConsistencyResult:'), source.indexOf('    BrandVisualRules:'))
    expect(canonicalSchemas).not.toContain('additionalProperties: true')
    expect(canonicalSchemas).toContain("read_control: { $ref: '#/components/schemas/McpCanonicalProductReadControl' }")
    expect(canonicalSchemas).toContain("unified_link_audit: { $ref: '#/components/schemas/McpCanonicalProductUnifiedLinkAudit' }")
    expect(source).toContain('objectType: { type: string, enum: [product, canonical_product, listing, campaign_item, task, publish_job, workspace] }')
    expect(source).toContain('confirmation: { type: string, enum: [none, interactive_confirmation] }')
    expect(source).toContain('orphanFindings:')
    expect(source).not.toContain('objectType: { type: string, enum: [product] }')
    expect(source).toContain("expected_revision: { type: string, pattern: '^[1-9][0-9]*$', maxLength: 10, description: Optional current brand revision; stale values fail with 409 BRAND_STORE_REVISION_CONFLICT. }")
    expect(source).toContain('    McpCampaignBatchControlParams:')
    expect(source).toContain('    McpCampaignBatchRetryFailedParams:')
    expect(source).toContain('required: [campaign_id, expected_revision, idempotency_key, reason]')
    expect(source).toContain('spec_json: { type: string, contentMediaType: application/json, x-json-shape: object }')
    expect(source).toContain('files_json: { type: string, contentMediaType: application/json, x-json-shape: array }')
    expect(source).toContain("next_actions: { type: array, items: { $ref: '#/components/schemas/ApiNextAction' } }")
    expect(source).toContain('    ApiNextAction:')
    expect(source).toContain('The same value may be present as error.details.retry_after_seconds.')
    expect(source).toContain('Retry-After:')
  })
})
