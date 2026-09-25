import type { IncomingMessage } from 'node:http'
import { DomainError, type ContentVersion, type MerchantService, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

type JsonObject = Record<string, unknown>
type ReviewRules = Parameters<MerchantService['reviewContentReport']>[2]

export interface McpContentCodexDependencies {
  service: MerchantService
  required: (params: JsonObject, name: string) => string
  scopeTask: (req: IncomingMessage, taskId: string) => Task
  controlledRelayEnvironment: () => boolean
  assertCanonicalTaskScopeForAction: (task: Task) => Promise<unknown>
  observeLegacyWalletShadow: (workspaceId: string) => Promise<unknown>
  observeLegacyTaskUsage: (workspaceId: string, taskId: string, idempotencyKey: string, actorId: string) => Promise<{ charged?: boolean; walletDebited?: boolean }>
  principalActorId: (req: IncomingMessage) => string | undefined
  header: (req: IncomingMessage, name: string) => string | undefined
  refundTaskUsage: (workspaceId: string, taskId: string, idempotencyKey: string, actorId: string, reason: string) => Promise<unknown>
  persistSnapshot: (workspaceId: string, entityType: 'content_version' | 'task', entity: ContentVersion | Task, value: Record<string, unknown>) => Promise<void>
  rulesForTask: (workspaceId: string, task: Task) => Promise<ReviewRules>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
}

export async function handleMcpContentCodex(method: string, params: JsonObject, req: IncomingMessage, workspaceId: string, deps: McpContentCodexDependencies): Promise<unknown> {
  const { service, required, scopeTask, controlledRelayEnvironment, assertCanonicalTaskScopeForAction, observeLegacyWalletShadow, observeLegacyTaskUsage, principalActorId, header, refundTaskUsage, persistSnapshot, rulesForTask, persistEvent } = deps
  switch (method) {
    case 'content.codex.prepare': {
      const task = scopeTask(req, required(params, 'task_id'))
      return (service.prepareCodexDraft(task.id))
    }
    case 'content.codex.commit': {
      if (controlledRelayEnvironment()) throw new DomainError('MODEL_RELAY_REQUIRED', '受控环境禁止绕过中转模型直接提交内容', 409)
      const task = scopeTask(req, required(params, 'task_id'))
      await assertCanonicalTaskScopeForAction(task)
      await observeLegacyWalletShadow(workspaceId)
      let body: import('../../../packages/application/src/service.js').ContentVersion['body']
      try {
        const parsed = JSON.parse(required(params, 'body_json')) as Record<string, unknown>
        if (typeof parsed.title !== 'string' || typeof parsed.detail !== 'string' || !Array.isArray(parsed.sellingPoints) || !parsed.sellingPoints.every(value => typeof value === 'string')) throw new Error('content body schema invalid')
        body = { title: parsed.title, detail: parsed.detail, sellingPoints: parsed.sellingPoints as string[], ...(Array.isArray(parsed.modules) ? { modules: parsed.modules as import('../../../packages/ai/src/generator.js').ContentModule[] } : {}), ...(parsed.brief && typeof parsed.brief === 'object' && !Array.isArray(parsed.brief) ? { brief: parsed.brief as import('../../../packages/ai/src/generator.js').StaticBrief } : {}) }
      } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'body_json 必须包含合法的 title、detail、sellingPoints', 400) }
      const usageKey = `content.codex.commit:${task.id}:${typeof params.expected_version === 'string' ? params.expected_version : 'latest'}`
      const usage = await observeLegacyTaskUsage(workspaceId, task.id, usageKey, principalActorId(req) ?? header(req, 'x-actor-id')?.trim() ?? 'merchant')
      let draft
      try { draft = service.commitCodexDraft({ taskId: task.id, body, ...(typeof params.reason === 'string' && params.reason.trim() ? { reason: params.reason.trim() } : {}) }) } catch (error) { if (usage.charged || usage.walletDebited) await refundTaskUsage(workspaceId, task.id, usageKey, principalActorId(req) ?? 'merchant', 'Codex 内容提交失败'); throw error }
      await persistSnapshot(workspaceId, 'content_version', draft, draft as unknown as Record<string, unknown>)
      await persistSnapshot(workspaceId, 'task', service.getTask(task.id), service.getTask(task.id) as unknown as Record<string, unknown>)
      const rulePreflight = service.reviewContentReport(workspaceId, draft.id, await rulesForTask(workspaceId, task))
      await persistEvent(workspaceId, draft.id, 'content.generated', draft.revision, { task_id: task.id, content_version_id: draft.id, version: draft.version, generation_mode: 'codex_native', rule_preflight: { blocking: rulePreflight.blocking, finding_count: rulePreflight.findings.length, rule_hits: rulePreflight.ruleHits ?? [] } })
      return ({ ...draft, rule_preflight: rulePreflight })
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知 Codex 内容 MCP 方法: ${method}`, 400)
  }
}
