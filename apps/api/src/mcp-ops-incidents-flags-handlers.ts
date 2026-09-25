import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { IncidentActor } from '../../../packages/contracts/src/ops/incidents.js'
import type { FeatureFlagEmergencyRequest, FeatureFlagEvaluationContext, FeatureFlagListRequest, FeatureFlagMutationRequest } from '../../../packages/contracts/src/ops/feature-flags.js'
import type { IncidentRepository, IncidentSeverity, IncidentStatus } from '../../../packages/persistence/src/incidents-repository.js'
import type { FeatureFlagsRepository } from '../../../packages/persistence/src/feature-flags-repository.js'
import { IncidentsService } from './ops/incidents-service.js'
import { FeatureFlagsService, type FeatureFlagActor } from './ops/feature-flags-service.js'
import { aliasValue, optionalNumberValue, optionalStringValue, requiredStringValue, stringArrayValue, structuredValue } from './ops-params.js'

export const MCP_OPS_INCIDENTS_FLAGS_METHODS = new Set([
  'ops.incidents.list', 'ops.incident.get', 'ops.incident.timeline', 'ops.incident.create',
  'ops.incident.transition', 'ops.incident.comment', 'ops.incident.commander.assign',
  'ops.incident.scope.update', 'ops.feature-flags.list', 'ops.feature-flag.upsert',
  'ops.feature-flag.emergency.set', 'ops.feature-flag.events', 'ops.feature-flag.evaluate',
])

export interface McpOpsIncidentsFlagsDependencies {
  persistence: { incidents?: IncidentRepository; featureFlags?: FeatureFlagsRepository; listWorkspaceIds?: () => Promise<string[]> }
  knownWorkspaces: Set<string>
  incidentActor: (req: IncomingMessage, workspaceId: string) => IncidentActor
  featureFlagActor: (req: IncomingMessage, allowed: readonly string[]) => FeatureFlagActor
  isPlatformOperations: (req: IncomingMessage) => boolean
  requirePlatformReadRole: (req: IncomingMessage) => unknown
  featureFlagRequestsCanonicalRead: (input: { key: string; defaultValue?: { value?: unknown }; targets?: Array<{ override?: { value?: unknown } }> }) => boolean
  resolveWorkspace: (req: IncomingMessage, candidate?: unknown) => string
  invokeOpsDomain: <T>(operation: () => Promise<T>) => Promise<T>
}

export async function handleMcpOpsIncidentsFlags(method: string, params: Record<string, unknown>, req: IncomingMessage, workspaceId: string, deps: McpOpsIncidentsFlagsDependencies): Promise<unknown> {
  const { persistence, knownWorkspaces, incidentActor, featureFlagActor, isPlatformOperations, requirePlatformReadRole, featureFlagRequestsCanonicalRead, resolveWorkspace, invokeOpsDomain } = deps
  switch (method) {
    case 'ops.incidents.list':
    case 'ops.incident.get':
    case 'ops.incident.timeline':
    case 'ops.incident.create':
    case 'ops.incident.transition':
    case 'ops.incident.comment':
    case 'ops.incident.commander.assign':
    case 'ops.incident.scope.update': {
      const repository = persistence.incidents
      if (!repository) throw new DomainError('INCIDENT_REPOSITORY_UNAVAILABLE', '事故仓储未配置', 503)
      const incidents = new IncidentsService(repository)
      const actor = incidentActor(req, workspaceId)
      const platformScope = optionalStringValue(params, 'platformScope', 'platform_scope')
      if (platformScope && platformScope !== 'platform') throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform_scope 只能是 platform', 400)
      const raw = {
        ...(optionalStringValue(params, 'incidentId', 'incident_id') ? { incidentId: optionalStringValue(params, 'incidentId', 'incident_id') } : {}),
        ...(optionalStringValue(params, 'title') ? { title: optionalStringValue(params, 'title') } : {}),
        ...(optionalStringValue(params, 'summary') ? { summary: optionalStringValue(params, 'summary') } : {}),
        ...(optionalStringValue(params, 'severity') ? { severity: optionalStringValue(params, 'severity') } : {}),
        ...(optionalStringValue(params, 'status') ? { status: optionalStringValue(params, 'status') } : {}),
        ...(optionalStringValue(params, 'toStatus', 'to_status') ? { toStatus: optionalStringValue(params, 'toStatus', 'to_status') } : {}),
        ...(optionalStringValue(params, 'commanderId', 'commander_id') ? { commanderId: optionalStringValue(params, 'commanderId', 'commander_id') } : {}),
        ...(optionalStringValue(params, 'note') ? { note: optionalStringValue(params, 'note') } : {}),
        ...(optionalStringValue(params, 'body') ? { body: optionalStringValue(params, 'body') } : {}),
        ...(optionalStringValue(params, 'idempotencyKey', 'idempotency_key') ? { idempotencyKey: optionalStringValue(params, 'idempotencyKey', 'idempotency_key') } : {}),
        ...(optionalNumberValue(params, 'expectedRevision', 'expected_revision') !== undefined ? { expectedRevision: optionalNumberValue(params, 'expectedRevision', 'expected_revision') } : {}),
        ...(optionalNumberValue(params, 'limit') !== undefined ? { limit: optionalNumberValue(params, 'limit') } : {}),
        ...(optionalStringValue(params, 'cursor') ? { cursor: optionalStringValue(params, 'cursor') } : {}),
        affectedComponents: stringArrayValue(params, 'affectedComponents', 'affected_components_json') ?? [],
        affectedWorkspaceIds: stringArrayValue(params, 'affectedWorkspaceIds', 'affected_workspace_ids_json') ?? [],
      }
      if (method === 'ops.incidents.list') {
        if (platformScope === 'platform') {
          if (!isPlatformOperations(req)) throw new DomainError(ERROR_CODES.FORBIDDEN, '平台聚合视图需要已绑定的 platform workbench', 403)
          requirePlatformReadRole(req)
          const limit = Math.min(100, Math.max(1, optionalNumberValue(params, 'limit') ?? 50))
          const workspaceIds = persistence.listWorkspaceIds ? await persistence.listWorkspaceIds() : [...knownWorkspaces]
          const items = [] as Awaited<ReturnType<IncidentsService['list']>>['items']
          for (let offset = 0; offset < workspaceIds.length; offset += 8) {
            const batch = await Promise.all(workspaceIds.slice(offset, offset + 8).map(targetWorkspaceId => new IncidentsService(repository).list(incidentActor(req, targetWorkspaceId), { ...raw, limit })))
            for (const page of batch) items.push(...page.items)
          }
          const groups = new Map<string, { severity: IncidentSeverity; status: IncidentStatus; count: number; latestUpdatedAt: string }>()
          for (const incident of items) {
            const key = `${incident.severity}:${incident.status}`
            const current = groups.get(key)
            if (current) { current.count += 1; if (incident.updatedAt > current.latestUpdatedAt) current.latestUpdatedAt = incident.updatedAt }
            else groups.set(key, { severity: incident.severity, status: incident.status, count: 1, latestUpdatedAt: incident.updatedAt })
          }
          const aggregateItems = [...groups.values()].sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt)).map((group, index) => ({ id: `platform-incident-group-${index + 1}`, workspaceId: 'platform-aggregate', title: `${group.count} 起平台事故`, summary: '平台聚合视图已脱敏；切换到明确工作区授权会话查看事故详情。', severity: group.severity, status: group.status, affectedComponents: [], affectedWorkspaceIds: [], revision: 0, createdBy: 'platform_aggregate', createdAt: group.latestUpdatedAt, updatedAt: group.latestUpdatedAt, aggregate: true, count: group.count }))
          return ({ items: aggregateItems.slice(0, limit), aggregate: true, truncated: aggregateItems.length > limit })
        }
        return (await invokeOpsDomain(() => incidents.list(actor, raw)))
      }
      if (method === 'ops.incident.get') return (await invokeOpsDomain(() => incidents.get(actor, requiredStringValue(params, 'incidentId', 'incident_id'))))
      if (method === 'ops.incident.timeline') return (await invokeOpsDomain(() => incidents.timeline(actor, raw)))
      if (method === 'ops.incident.create') return (await invokeOpsDomain(() => incidents.create(actor, raw)))
      if (method === 'ops.incident.transition') return (await invokeOpsDomain(() => incidents.transition(actor, raw)))
      if (method === 'ops.incident.comment') return (await invokeOpsDomain(() => incidents.comment(actor, raw)))
      if (method === 'ops.incident.commander.assign') return (await invokeOpsDomain(() => incidents.assignCommander(actor, raw)))
      return (await invokeOpsDomain(() => incidents.updateScope(actor, raw)))
    }
    case 'ops.feature-flags.list':
    case 'ops.feature-flag.upsert':
    case 'ops.feature-flag.emergency.set':
    case 'ops.feature-flag.events':
    case 'ops.feature-flag.evaluate': {
      const repository = persistence.featureFlags
      if (!repository) throw new DomainError('FEATURE_FLAG_REPOSITORY_UNAVAILABLE', '功能开关仓储未配置', 503)
      const flags = new FeatureFlagsService(repository)
      if (method === 'ops.feature-flags.list') {
        const actor = featureFlagActor(req, ['support', 'platform_ops', 'platform_admin', 'ops_admin'])
        const request: FeatureFlagListRequest = { ...(optionalStringValue(params, 'environment') ? { environment: optionalStringValue(params, 'environment') } : {}), ...(optionalStringValue(params, 'query') ? { query: optionalStringValue(params, 'query') } : {}), ...(optionalStringValue(params, 'cursor') ? { cursor: optionalStringValue(params, 'cursor') } : {}), ...(optionalNumberValue(params, 'limit') !== undefined ? { limit: optionalNumberValue(params, 'limit') } : {}) }
        return (await invokeOpsDomain(() => flags.list(actor, request)))
      }
      if (method === 'ops.feature-flag.upsert') {
        const actor = featureFlagActor(req, ['platform_ops'])
        const defaultValue = structuredValue(params, 'defaultValue', 'default_value_json')
        const targets = structuredValue(params, 'targets', 'targets_json')
        if (requiredStringValue(params, 'environment') === 'production' && featureFlagRequestsCanonicalRead({ key: requiredStringValue(params, 'key'), defaultValue: defaultValue as { value?: unknown } | undefined, targets: targets as Array<{ override?: { value?: unknown } }> | undefined })) {
          throw new DomainError('CANONICAL_CUTOVER_EVIDENCE_REQUIRED', '生产环境只有在正式 canonical cutover evidence 签署后才能打开标准链切读', 503, { required_evidence: 'canonical-cutover-evidence', current_mode: 'legacy_shadow' })
        }
        const request: FeatureFlagMutationRequest = { ...(optionalStringValue(params, 'id') ? { id: optionalStringValue(params, 'id') } : {}), key: requiredStringValue(params, 'key'), environment: requiredStringValue(params, 'environment'), description: requiredStringValue(params, 'description'), defaultValue: defaultValue as FeatureFlagMutationRequest['defaultValue'], enabled: params.enabled === true || params.enabled === 'true', targets: targets === undefined ? [] : targets as FeatureFlagMutationRequest['targets'], ...(optionalStringValue(params, 'validFrom', 'valid_from') ? { validFrom: optionalStringValue(params, 'validFrom', 'valid_from') } : {}), ...(optionalStringValue(params, 'validTo', 'valid_to') ? { validTo: optionalStringValue(params, 'validTo', 'valid_to') } : {}), ...(optionalNumberValue(params, 'expectedRevision', 'expected_revision') !== undefined ? { expectedRevision: optionalNumberValue(params, 'expectedRevision', 'expected_revision') } : {}), idempotencyKey: requiredStringValue(params, 'idempotencyKey', 'idempotency_key'), reason: requiredStringValue(params, 'reason') }
        return (await invokeOpsDomain(() => flags.save(actor, request)))
      }
      if (method === 'ops.feature-flag.emergency.set') {
        const actor = featureFlagActor(req, ['platform_ops'])
        const request: FeatureFlagEmergencyRequest = { id: requiredStringValue(params, 'id'), disabled: aliasValue(params, 'disabled') === true || aliasValue(params, 'disabled') === 'true', expectedRevision: optionalNumberValue(params, 'expectedRevision', 'expected_revision') ?? 0, idempotencyKey: requiredStringValue(params, 'idempotencyKey', 'idempotency_key'), reason: requiredStringValue(params, 'reason') }
        return (await invokeOpsDomain(() => flags.setEmergency(actor, request)))
      }
      if (method === 'ops.feature-flag.events') return (await invokeOpsDomain(() => flags.events(featureFlagActor(req, ['support', 'platform_ops', 'platform_admin', 'ops_admin']), requiredStringValue(params, 'flagId', 'flag_id'), optionalNumberValue(params, 'limit'))))
      const evaluationWorkspaceId = resolveWorkspace(req, aliasValue(params, 'targetWorkspaceId', 'target_workspace_id'))
      const evaluation: FeatureFlagEvaluationContext = { flagKey: requiredStringValue(params, 'flagKey', 'flag_key'), environment: requiredStringValue(params, 'environment'), ...(optionalStringValue(params, 'identityId', 'identity_id') ? { identityId: optionalStringValue(params, 'identityId', 'identity_id') } : {}), workspaceId: evaluationWorkspaceId, ...(optionalStringValue(params, 'bucketSubject', 'bucket_subject') ? { bucketSubject: optionalStringValue(params, 'bucketSubject', 'bucket_subject') } : {}), ...(optionalStringValue(params, 'at') ? { at: optionalStringValue(params, 'at') } : {}) }
      return (await invokeOpsDomain(() => flags.evaluate(featureFlagActor(req, ['workspace_owner', 'merchant_admin', 'operator', 'support', 'finance', 'platform_ops']), evaluation)))
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知事故或功能开关 MCP 方法: ${method}`, 400)
  }
}
