import { AuditCenterSection } from '../components/audit/AuditCenterSection.js'
import { OpsPage } from '../components/OpsPage.js'
import { auditCenterClient } from '../api/opsDomainClients.js'
import { useAuditCenter } from '../hooks/useAuditCenter.js'
import type { OpsDomainPageProps } from '../navigation/opsPageRegistry.js'
import { Button } from 'antd'

export function auditPageScope(model: Pick<OpsDomainPageProps['model'], 'authorization' | 'authorizationTargetWorkspaceId' | 'opsWorkspaceId'>) {
  const authorizationIsPlatform = model.authorization.scope.kind === 'platform'
  const selectedWorkspaceId = authorizationIsPlatform
    ? model.authorizationTargetWorkspaceId?.trim() ?? ''
    : ''
  const platformScope = authorizationIsPlatform && !selectedWorkspaceId
  const workspaceId = selectedWorkspaceId || model.opsWorkspaceId
  return {
    platformScope,
    workspaceId,
    canExport: Boolean(workspaceId) && !platformScope && model.authorization.can('audit.export'),
  }
}

export function AuditPage({ model }: OpsDomainPageProps) {
  const { platformScope, workspaceId, canExport } = auditPageScope(model)
  const controller = useAuditCenter(auditCenterClient, workspaceId, true, platformScope)

  return (
    <OpsPage
      eyebrow="AUDIT TRAIL"
      title="审计中心"
      description={platformScope ? "平台范围检索各授权企业主体的不可变审计事实；详情采用最小化、脱敏投影。需要详情或导出时，请先在平台总览的商家经营台账中点击“查看该企业授权”，再返回本页。" : "检索已选择企业主体的不可变审计事实；详情和导出均采用最小化、脱敏投影。"}
      actions={<Button type="primary" loading={controller.loading} onClick={() => void controller.reload()}>刷新审计</Button>}
    >
      <div className="ops-audit-page"><AuditCenterSection controller={controller} canExport={canExport} platformScope={platformScope} fixtureDataPresent={model.dataSource?.fixtureDataPresent} /></div>
    </OpsPage>
  )
}
