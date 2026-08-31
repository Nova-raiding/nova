import { AuditCenterSection } from '../components/audit/AuditCenterSection.js'
import { OpsPage } from '../components/OpsPage.js'
import { auditCenterClient } from '../api/opsDomainClients.js'
import { useAuditCenter } from '../hooks/useAuditCenter.js'
import type { OpsDomainPageProps } from '../navigation/opsPageRegistry.js'

export function AuditPage({ model }: OpsDomainPageProps) {
  const platformScope = model.authorization.scope.kind === 'platform'
  const controller = useAuditCenter(auditCenterClient, model.opsWorkspaceId, true, platformScope)
  const canExport = !platformScope && model.authorization.can('audit.export')

  return (
    <OpsPage
      eyebrow="AUDIT TRAIL"
      title="审计中心"
      description={platformScope ? "平台范围检索各授权租户的不可变审计事实；详情采用最小化、脱敏投影，跨租户导出请切换到具体工作区。" : "检索当前工作区的不可变审计事实；详情和导出均采用最小化、脱敏投影。"}
    >
      <AuditCenterSection controller={controller} canExport={canExport} platformScope={platformScope} />
    </OpsPage>
  )
}
