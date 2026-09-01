import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  ShieldAlert,
} from 'lucide-react'
import './detail-decision-contract.css'
import {
  moduleDecisionPresentation,
  type DetailModuleDecisionPresentation,
} from './detail-decision-contract'

const dispositionIcon = {
  ready: {
    Icon: CheckCircle2,
  },
  omitted: {
    Icon: AlertCircle,
  },
  blocked: {
    Icon: Clock3,
  },
  legacy_review_required: {
    Icon: ShieldAlert,
  },
} as const

export function DetailDecisionContract({
  module,
}: {
  module: unknown
}) {
  const presentation: DetailModuleDecisionPresentation = moduleDecisionPresentation(module)
  const contract = presentation.contract
  const StatusIcon = dispositionIcon[presentation.disposition].Icon

  return (
    <section
      className="detail-decision-contract"
      aria-label={`详情页决策合同：${presentation.label}`}
      data-disposition={presentation.disposition}
      data-evidence-status={presentation.evidenceStatus ?? 'legacy'}
    >
      <b className="decision-contract-title">详情页决策合同</b>
      {contract && (
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
      )}
      <div className="decision-evidence-status">
        <StatusIcon size={15} aria-hidden="true" focusable="false" />
        <span>
          <b>展示状态：{presentation.label}</b>
          <small>{presentation.detail}</small>
        </span>
      </div>
      {contract && <div className="decision-limitations">
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
      </div>}
      {presentation.recovery && (
        <p className="decision-recovery" role="note" aria-label="恢复提示">
          <b>下一步：</b>{presentation.recovery}
        </p>
      )}
    </section>
  )
}
