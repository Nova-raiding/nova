import { AuditCenterSection } from '../components/audit/AuditCenterSection.js'
import { OpsPage } from '../components/OpsPage.js'
import { auditCenterClient } from '../api/opsDomainClients.js'
import { useAuditCenter } from '../hooks/useAuditCenter.js'
import type { OpsDomainPageProps } from '../navigation/opsPageRegistry.js'
import { Alert, Button, Select, Space } from 'antd'

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
  const canSelectWorkspace = model.authorization.scope.kind === 'platform'
    && model.authorization.can('workspace.directory.read')
  const workspaceDirectoryError = model.workspaceDirectoryError || model.dataSetError('ops.workspaces.list') || ''
  const workspaceDirectoryUnavailable = model.workspaceDirectoryLoading || Boolean(workspaceDirectoryError) || model.workspaceRows.length === 0
  const workspaceDirectoryMessage = model.workspaceDirectoryLoading
    ? '正在加载已授权企业主体；加载完成后可切换到具体企业主体。'
    : workspaceDirectoryError
      ? `企业主体目录读取失败：${workspaceDirectoryError}`
      : model.workspaceRows.length === 0
        ? '暂无可选择的企业主体；当前仅可查看平台聚合记录。'
        : ''
  const workspaceOptions = [
    { value: '', label: '平台聚合（仅查看）' },
    ...model.workspaceRows.map(workspace => ({
      value: workspace.workspaceId,
      label: `${workspace.enterpriseName?.trim() || '未命名企业主体'} · ${workspace.workspaceId}`,
      disabled: workspace.status !== 'active',
    })),
  ]

  return (
    <OpsPage
      eyebrow="AUDIT TRAIL"
      title="审计中心"
      description={platformScope ? (canSelectWorkspace ? "平台范围检索各授权企业主体的不可变审计事实；详情采用最小化、脱敏投影。选择具体企业主体后可查看该主体详情并导出。" : "平台范围检索各授权企业主体的不可变审计事实；详情采用最小化、脱敏投影，平台聚合结果仅供查看。") : "检索已选择企业主体的不可变审计事实；详情和导出均采用最小化、脱敏投影。"}
      actions={<Space wrap>
        {canSelectWorkspace ? <Select
          aria-label="审计目标企业主体"
          showSearch
          optionFilterProp="label"
          value={model.authorizationTargetWorkspaceId?.trim() ?? ''}
          options={workspaceOptions}
          disabled={workspaceDirectoryUnavailable}
          onChange={value => model.setAuthorizationTargetWorkspaceId(value)}
          style={{ minWidth: 280, maxWidth: 380 }}
        /> : null}
        <Button type="primary" loading={controller.loading} onClick={() => void controller.reload()}>刷新审计</Button>
      </Space>}
    >
      {canSelectWorkspace && workspaceDirectoryMessage ? <Alert
        role="status"
        type={workspaceDirectoryError ? 'error' : 'info'}
        showIcon
        message={workspaceDirectoryMessage}
        action={workspaceDirectoryError ? <Button size="small" onClick={() => void model.loadWorkspaceDirectory({ merchantOnly: true })}>重试读取企业主体</Button> : undefined}
        style={{ marginBottom: 16 }}
      /> : null}
      <div className="ops-audit-page"><AuditCenterSection controller={controller} canExport={canExport} platformScope={platformScope} fixtureDataPresent={model.dataSource?.fixtureDataPresent} /></div>
    </OpsPage>
  )
}
