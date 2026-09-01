import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  ShieldAlert,
} from 'lucide-react'
import './detail-decision-contract.css'
import type { DetailPageDecisionContract } from './detail-decision-contract'

const statusPresentation = {
  verified: {
    label: '已验证',
    detail: '证据已通过当前合同校验',
    Icon: CheckCircle2,
  },
  missing: {
    label: '缺少证据',
    detail: '证据不完整，当前内容不能据此确认',
    Icon: AlertCircle,
  },
  expired: {
    label: '证据已过期',
    detail: '需要更新证据后重新校验',
    Icon: Clock3,
  },
  conflict: {
    label: '证据冲突',
    detail: '证据之间存在冲突，需要人工处理',
    Icon: ShieldAlert,
  },
} as const

export function DetailDecisionContract({
  contract,
}: {
  contract: DetailPageDecisionContract | null
}) {
  if (!contract) return null

  const presentation = statusPresentation[contract.evidence.status]
  const StatusIcon = presentation.Icon

  return (
    <section
      className="detail-decision-contract"
      aria-label="详情页决策合同"
      data-evidence-status={contract.evidence.status}
    >
      <b className="decision-contract-title">详情页决策合同</b>
      <dl className="decision-contract-summary">
        <div>
          <dt>买家问题</dt>
          <dd>{contract.buyerQuestion}</dd>
        </div>
        <div>
          <dt>页面任务</dt>
          <dd>{contract.pageTask}</dd>
        </div>
      </dl>
      <div className="decision-evidence-status">
        <StatusIcon size={15} aria-hidden="true" focusable="false" />
        <span>
          <b>证据状态：{presentation.label}</b>
          <small>{presentation.detail}</small>
        </span>
      </div>
      <div className="decision-limitations">
        <b>限制条件</b>
        {contract.claim.limitations.length ? (
          <ul>
            {contract.claim.limitations.map((limitation, index) => (
              <li key={`${index}-${limitation}`}>{limitation}</li>
            ))}
          </ul>
        ) : (
          <p>当前合同未记录限制条件</p>
        )}
      </div>
    </section>
  )
}
