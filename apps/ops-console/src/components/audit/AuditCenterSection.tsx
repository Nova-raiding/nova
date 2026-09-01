import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Flex, Grid, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useRef } from 'react'
import type { ColumnsType } from 'antd/es/table'
import type { AuditCenterRecord } from '../../../../../packages/contracts/src/ops/audit-center.js'
import type { useAuditCenter } from '../../hooks/useAuditCenter.js'
import { AuditDetailDrawer } from './AuditDetailDrawer.js'
import { AuditFilters } from './AuditFilters.js'

type Controller = ReturnType<typeof useAuditCenter>

const sourceLabels = {
  operation: '运营操作',
  rule: '规则中心',
  incident: '事故',
  support: '客服工单',
} as const

export function AuditCenterSection({ controller, canExport, platformScope = false }: { controller: Controller; canExport: boolean; platformScope?: boolean }) {
  const screens = Grid.useBreakpoint()
  // The full table is intentionally reserved for wide screens; 844px landscape stays operable as cards.
  const compact = !screens.lg
  const selected = controller.selected
  const errorRef = useRef<HTMLDivElement>(null)
  const exportErrorRef = useRef<HTMLDivElement>(null)
  const initialLoadFailed = Boolean(controller.error && !controller.loading && controller.records.length === 0)
  const canViewDetails = !platformScope
  const exportDisabled = !canExport || platformScope || !controller.records.length || controller.exporting
  const exportUnavailableReason = !canExport
    ? platformScope ? '平台聚合视图暂不支持跨租户导出，请切换到具体工作区。' : '当前会话没有 audit.export 能力，无法导出审计记录。'
    : !controller.records.length ? '当前筛选条件没有可导出的审计记录。' : undefined
  useEffect(() => {
    if (controller.error) errorRef.current?.focus()
  }, [controller.error])
  useEffect(() => {
    if (controller.exportError) exportErrorRef.current?.focus()
  }, [controller.exportError])
  const openDetail = (record: AuditCenterRecord, target: HTMLElement) =>
    void controller.openDetail(record, target)
  const columns: ColumnsType<AuditCenterRecord> = [
    { title: '时间', dataIndex: 'occurredAt', width: 180, fixed: 'left', render: value => new Date(value).toLocaleString() },
    { title: '来源', dataIndex: 'source', width: 110, render: value => <Tag>{sourceLabels[value as AuditCenterRecord['source']]}</Tag> },
    { title: '操作者', dataIndex: 'actorId', width: 170 },
    { title: '动作', dataIndex: 'action', width: 200 },
    { title: '资源', width: 260, render: (_, row) => <Typography.Text ellipsis={{ tooltip: `${row.resourceType} / ${row.resourceId}` }}>{row.resourceType} / {row.resourceId}</Typography.Text> },
    { title: '原因', dataIndex: 'reason', width: 260, render: value => value || '—' },
    { title: '操作', width: 90, fixed: 'right', render: (_, row) => <Button type="link" style={{ minHeight: 44 }} disabled={!canViewDetails} title={canViewDetails ? undefined : '平台聚合视图不开放跨租户详情'} onClick={event => openDetail(row, event.currentTarget)} aria-label={`查看审计事件 ${row.id} 详情`}>详情</Button> },
  ]

  return <Card aria-busy={controller.loading} styles={{ body: { overflow: 'hidden' } }}>
    <Flex vertical={compact} gap={12} justify="space-between" align={compact ? 'stretch' : 'center'} style={{ marginBottom: 16 }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>不可变审计记录</Typography.Title>
        <Typography.Text type="secondary">所有详情均为服务端脱敏投影</Typography.Text>
      </div>
      <Space wrap size={8}>
        <Button icon={<ReloadOutlined aria-hidden />} loading={controller.loading} onClick={() => void controller.reload()} style={{ minHeight: 44 }}>刷新</Button>
        <Button icon={<DownloadOutlined aria-hidden />} loading={controller.exporting}
          aria-disabled={exportDisabled || undefined} aria-busy={controller.exporting}
          aria-describedby="audit-export-help" tabIndex={0}
          title={exportUnavailableReason}
          onClick={() => { if (!exportDisabled) void controller.downloadCsv() }} style={{ minHeight: 44 }}>
          导出当前筛选
        </Button>
      </Space>
    </Flex>
    <Typography.Text id="audit-export-help" type="secondary" style={{ display: 'block', marginBottom: 12 }}>
      {exportUnavailableReason ?? '导出仅使用当前工作区和筛选条件，并受服务端 audit.export 能力控制。'}
    </Typography.Text>

    <AuditFilters value={controller.filters} onChange={controller.setFilters} />
    {controller.error ? <div ref={errorRef} tabIndex={-1} role="alert" aria-labelledby="audit-load-error-title">
      <Alert type="error" showIcon message={<span id="audit-load-error-title">审计记录加载失败</span>} description={controller.error}
        action={<Button onClick={() => void controller.reload()} style={{ minHeight: 44 }}>重试</Button>} />
    </div> : null}
    {controller.exportError ? <div ref={exportErrorRef} tabIndex={-1} role="alert" aria-labelledby="audit-export-error-title">
      <Alert type="error" showIcon message={<span id="audit-export-error-title">审计导出失败</span>} description={controller.exportError}
        action={<Button onClick={() => void controller.downloadCsv()} style={{ minHeight: 44 }}>重试导出</Button>} />
    </div> : null}
    {!initialLoadFailed && !controller.loading ? <Alert type={controller.truncated ? "info" : "success"} showIcon title={controller.truncated ? `已加载 ${controller.records.length} / ${controller.totalRecords} 条审计记录` : `已加载全部 ${controller.totalRecords} 条审计记录`} description={controller.truncated ? platformScope ? "平台聚合结果按服务端上限返回；请缩小时间或租户筛选范围，记录内容为服务端脱敏投影。" : "当前结果按服务端游标分页，点击“加载更多”继续查看；总量来自同一租户和筛选条件。" : "当前结果已完整覆盖同一租户和筛选条件，记录内容为服务端脱敏投影。"} /> : null}
    <div aria-live="polite" aria-atomic="true" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
      {controller.loading ? '正在加载审计记录' : initialLoadFailed ? '审计记录不可用，当前空列表不代表没有审计事件' : controller.truncated ? `已加载 ${controller.records.length} 条，共 ${controller.totalRecords} 条，仍有未加载记录` : `已加载全部 ${controller.totalRecords} 条审计记录`}
    </div>

    {compact ? <div role="list" aria-busy={controller.loading}>
      {controller.loading && !controller.records.length ? <Card loading aria-label="正在加载审计记录" /> : null}
      {!controller.loading && !controller.error && !controller.records.length ? <Empty description="当前筛选条件下没有审计记录" /> : null}
      {controller.records.map(record => <div role="listitem" key={`${record.source}:${record.id}`} style={{ paddingBlock: 8 }}>
        <Card size="small" style={{ width: '100%', overflow: 'hidden' }}>
          <Space wrap size={8} style={{ marginBottom: 12 }}>
            <Tag>{sourceLabels[record.source]}</Tag>
            <Typography.Text strong style={{ overflowWrap: 'anywhere' }}>{record.action}</Typography.Text>
          </Space>
          <Typography.Paragraph style={{ overflowWrap: 'anywhere' }}>{record.resourceType} / {record.resourceId}</Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ overflowWrap: 'anywhere' }}>{record.actorId} · {new Date(record.occurredAt).toLocaleString()}</Typography.Paragraph>
          <Typography.Paragraph>{record.reason || '未提供操作原因'}</Typography.Paragraph>
          <Button block style={{ minHeight: 44 }} disabled={!canViewDetails} title={canViewDetails ? undefined : '平台聚合视图不开放跨租户详情'} onClick={event => openDetail(record, event.currentTarget)} aria-label={`查看审计事件 ${record.id} 详情`}>查看脱敏详情</Button>
        </Card>
      </div>)}
    </div> : initialLoadFailed ? <Typography.Text type="secondary" role="status">审计数据尚未取得，请重试；当前状态不能解释为没有审计记录。</Typography.Text> : <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
        <Table rowKey={record => `${record.source}:${record.id}`} size="small" loading={controller.loading}
          dataSource={controller.records} columns={columns} pagination={false} scroll={{ x: 1270 }}
          locale={{ emptyText: controller.loading ? '正在加载' : '当前筛选条件下没有审计记录' }} />
      </div>}

    {controller.nextCursor ? <Button block style={{ minHeight: 44, marginTop: 16 }} loading={controller.loadingMore}
      disabled={controller.loading} onClick={() => void controller.loadMore()}>加载更多审计记录</Button> : null}
    <AuditDetailDrawer selected={selected} detail={controller.detail} loading={controller.detailLoading}
      error={controller.detailError} onRetry={selected ? () => void controller.openDetail(selected) : undefined}
      onClose={controller.closeDetail} />
  </Card>
}
