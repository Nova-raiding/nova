export type DecisionEvidenceStatus =
  | 'verified'
  | 'missing'
  | 'expired'
  | 'conflict'

export type DecisionDisposition =
  | 'ready'
  | 'omitted'
  | 'blocked'
  | 'legacy_review_required'

export interface DetailPageDecisionContract {
  buyerQuestion: string
  pageTask: string
  claim: {
    limitations: readonly string[]
  }
  evidence: {
    status: DecisionEvidenceStatus
  }
  optional: boolean
}

export interface DetailModuleDecisionPresentation {
  disposition: DecisionDisposition
  contract: DetailPageDecisionContract | null
  evidenceStatus: DecisionEvidenceStatus | 'pending' | null
  label: string
  detail: string
  recovery: string | null
  bodyVisible: boolean
}

export interface EvidenceSafeTopLevelContent {
  detail: null
  sellingPoints: readonly []
  suppressed: boolean
  notice: string
}

export function moduleDecisionContract(module: unknown): DetailPageDecisionContract | null {
  if (!module || typeof module !== 'object') return null
  const contract = (module as { decisionContract?: unknown }).decisionContract
  if (!contract || typeof contract !== 'object') return null
  const candidate = contract as Record<string, unknown>
  const claim = candidate.claim
  const evidence = candidate.evidence
  if (
    typeof candidate.buyerQuestion !== 'string' ||
    typeof candidate.pageTask !== 'string' ||
    !claim ||
    typeof claim !== 'object' ||
    !Array.isArray((claim as Record<string, unknown>).limitations) ||
    !(claim as { limitations: unknown[] }).limitations.every(
      (item) => typeof item === 'string',
    ) ||
    !evidence ||
    typeof evidence !== 'object' ||
    typeof candidate.optional !== 'boolean' ||
    !['verified', 'missing', 'expired', 'conflict'].includes(
      String((evidence as Record<string, unknown>).status),
    )
  ) return null
  return contract as DetailPageDecisionContract
}

export function moduleDecisionPresentation(module: unknown): DetailModuleDecisionPresentation {
  const contract = moduleDecisionContract(module)
  if (!contract) {
    return {
      disposition: 'legacy_review_required',
      contract: null,
      evidenceStatus: null,
      label: '需迁移审核',
      detail: '历史模块缺少详情页决策合同，不能视为已确认事实。',
      recovery: '补录买家问题、页面任务和证据后重新审核。',
      bodyVisible: false,
    }
  }

  const candidate = module as { body?: unknown; contentKind?: unknown }
  const pending = candidate.contentKind === 'pending' ||
    (typeof candidate.body === 'string' && candidate.body.trimStart().startsWith('[待确认]'))
  const status = pending ? 'pending' : contract.evidence.status
  if (status === 'verified') {
    return {
      disposition: 'ready',
      contract,
      evidenceStatus: status,
      label: '可展示 · 证据已验证',
      detail: '证据已通过当前合同校验。',
      recovery: null,
      bodyVisible: true,
    }
  }
  if (status === 'missing' && contract.optional) {
    return {
      disposition: 'omitted',
      contract,
      evidenceStatus: status,
      label: '已省略 · 可选证据缺失',
      detail: '可选模块缺少证据，正文已隐藏；省略不代表已验证。',
      recovery: '补充并验证证据后，可恢复正文展示。',
      bodyVisible: false,
    }
  }

  const blocked = {
    missing: ['已阻断 · 必需证据缺失', '必需证据不完整，正文已隐藏。', '补充并验证必需证据后重新审核。'],
    expired: ['已阻断 · 证据已过期', '证据已超过有效期，正文已隐藏。', '更新证据有效期并重新校验。'],
    conflict: ['已阻断 · 证据有冲突', '证据之间存在冲突，正文已隐藏。', '处理冲突并由人工重新审核。'],
    pending: ['已阻断 · 证据待确认', '模块仍在等待事实确认，正文已隐藏。', '完成事实确认并重新审核。'],
  } as const
  const [label, detail, recovery] = blocked[status]
  return {
    disposition: 'blocked',
    contract,
    evidenceStatus: status,
    label,
    detail,
    recovery,
    bodyVisible: false,
  }
}

export function evidenceSafeTopLevelContent(body: unknown): EvidenceSafeTopLevelContent {
  if (!body || typeof body !== 'object') {
    return {
      detail: null,
      sellingPoints: [],
      suppressed: false,
      notice: '选择商品并生成内容版本后，再按详情模块证据逐项审阅。',
    }
  }
  const candidate = body as { detail?: unknown; sellingPoints?: unknown }
  const suppressed =
    (typeof candidate.detail === 'string' && Boolean(candidate.detail.trim())) ||
    (Array.isArray(candidate.sellingPoints) && candidate.sellingPoints.length > 0)
  return {
    detail: null,
    sellingPoints: [],
    suppressed,
    notice: suppressed
      ? '顶层详情和卖点未绑定逐项决策合同，已隐藏；请按下方详情模块审阅证据。'
      : '当前版本没有可直接展示的顶层详情；请按下方详情模块审阅证据。',
  }
}
