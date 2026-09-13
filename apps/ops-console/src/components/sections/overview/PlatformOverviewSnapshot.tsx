import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  ExclamationCircleOutlined,
  ProjectOutlined,
  RobotOutlined,
  ShopOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Button, Card, Col, Row, Statistic, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../../../navigation/opsNavigation";
import { modelReadinessRows } from "./modelReadiness";

interface PlatformOverviewSnapshotProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

const money = (value: number | undefined) => value === undefined ? "—" : `¥${value.toFixed(2)}`;

export function PlatformOverviewSnapshot({ model }: PlatformOverviewSnapshotProps) {
  const merchantWorkspaceCount = model.workspaceDirectory.merchantWorkspaceCount;
  const tasks = model.platformTaskSummary;
  const marketing = model.platformMarketingSummary;
  const usage = model.platformModelUsageSummary;
  // A failed refresh must not leave the overview presenting stale readiness as
  // current evidence. The models page follows the same fail-closed rule.
  const modelStatusError = model.dataSetError("platform.model.status");
  const displayModelStatus = modelStatusError ? undefined : model.modelStatus;
  const readiness = modelReadinessRows(displayModelStatus);
  const blockedReadiness = readiness.filter((row) => !row.ready);
  const readyModels = readiness.filter((row) => row.ready).length;
  const connectedPlatforms = new Set(
    model.platformOperations
      .filter((operation) => operation.connectedAccountCount || operation.state === "connected")
      .map((operation) => operation.platform),
  ).size;
  const openAlerts = model.alerts.filter((alert) => alert.status === "open").length;
  const totalQueue = (tasks?.generationQueueCount ?? 0) + (tasks?.publishQueueCount ?? 0);
  const taskValue = tasks ? tasks.taskCount : undefined;
  const modelUsageValue = usage ? usage.customerChargeCny : undefined;

  return (
    <section className="ops-overview-snapshot" aria-labelledby="ops-overview-snapshot-title">
      <div className="ops-overview-snapshot-heading">
        <div>
          <span className="ops-overview-section-kicker">PLATFORM PULSE</span>
          <Typography.Title level={2} id="ops-overview-snapshot-title">平台运营实时概况</Typography.Title>
          <Typography.Text type="secondary">
            先看平台整体状态，再进入对应工作台处理异常、商家、模型或账务。
          </Typography.Text>
        </div>
        <Tag color={model.loading ? "processing" : "green"} icon={model.loading ? <ClockCircleOutlined /> : <CheckCircleOutlined />}>
          {model.loading ? "正在刷新" : "数据已读取"}
        </Tag>
      </div>

      <Row gutter={[12, 12]} className="ops-overview-kpi-grid" aria-label="平台核心运营指标">
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-overview-kpi-card ops-overview-kpi-blue">
            <Statistic title="有效商家" value={merchantWorkspaceCount ?? "—"} suffix={merchantWorkspaceCount !== undefined ? " 家" : undefined} prefix={<ShopOutlined />} />
            <span>{merchantWorkspaceCount !== undefined ? "有有效商家账号绑定的工作区" : "目录汇总尚未取得，不解释为 0"}</span>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-overview-kpi-card ops-overview-kpi-green">
            <Statistic title="工作区记录" value={model.workspaceDirectory.total ?? "—"} prefix={<TeamOutlined />} />
            <span>含历史、测试和未绑定记录，不作为商家数量</span>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-overview-kpi-card ops-overview-kpi-violet">
            <Statistic title="平台任务" value={taskValue ?? "—"} prefix={<ProjectOutlined />} />
            <span>{marketing ? `生成 ${marketing.generationByState?.running ?? 0} · 发布 ${marketing.publishByState?.running ?? 0} 处理中` : "任务汇总尚未取得"}</span>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-overview-kpi-card ops-overview-kpi-amber">
            <Statistic title="待处理队列" value={tasks ? totalQueue : "—"} prefix={<ThunderboltOutlined />} />
            <span>{tasks ? `生成队列 ${tasks.generationQueueCount} · 发布队列 ${tasks.publishQueueCount}` : "队列汇总尚未取得"}</span>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-overview-kpi-card ops-overview-kpi-purple">
            <Statistic title="模型能力" value={displayModelStatus ? `${readyModels}/${readiness.length}` : "—"} prefix={<RobotOutlined />} />
            <span>{displayModelStatus ? `${blockedReadiness.length} 项能力被阻断` : modelStatusError ? "模型状态读取失败，不能沿用旧状态" : "模型状态尚未取得"}</span>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-overview-kpi-card ops-overview-kpi-red">
            <Statistic title="开放告警" value={model.loading ? "—" : openAlerts} prefix={<ExclamationCircleOutlined />} />
            <span>{model.loading ? "告警数据尚未取得" : model.alerts.length ? `当前共 ${model.alerts.length} 条平台告警` : "已读取，当前没有平台告警"}</span>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-overview-kpi-card ops-overview-kpi-slate">
            <Statistic title="平台连接" value={model.loading ? "—" : connectedPlatforms} suffix={model.loading ? undefined : " 个"} prefix={<ShopOutlined />} />
            <span>{model.loading ? "连接数据尚未取得" : connectedPlatforms ? "至少存在一个已连接账号的平台" : "已读取，当前没有平台连接"}</span>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card className="ops-overview-kpi-card ops-overview-kpi-cyan">
            <Statistic title="模型客户计费" value={modelUsageValue === undefined ? "—" : money(modelUsageValue)} prefix={<DollarOutlined />} />
            <span>{usage ? `${usage.recordCount} 条用量记录 · ${usage.unsettledRecordCount} 条未结算` : "用量汇总尚未取得"}</span>
          </Card>
        </Col>
      </Row>

    </section>
  );
}

/** Detailed model readiness belongs below the first-screen platform pulse. */
export function ModelLaunchRisk({ model, onNavigate }: PlatformOverviewSnapshotProps) {
  const modelStatusError = model.dataSetError("platform.model.status");
  const displayModelStatus = modelStatusError ? undefined : model.modelStatus;
  const readiness = modelReadinessRows(displayModelStatus);
  const blockedReadiness = readiness.filter((row) => !row.ready);

  return (
    <Row gutter={[12, 12]} className="ops-overview-status-grid">
      <Col xs={24}>
        <Card
          size="small"
          title={<span><RobotOutlined /> 模型上线风险</span>}
          extra={<Button type="link" onClick={() => onNavigate?.("finance")}>前往账务中心</Button>}
        >
          <div className="ops-overview-readiness-list" aria-live="polite">
            {modelStatusError ? (
              <Typography.Text type="secondary">模型状态读取失败，当前不能判定能力是否可用；请进入模型详情重试。</Typography.Text>
            ) : blockedReadiness.length ? (
              <>
                <Typography.Text type="secondary">{blockedReadiness.length} 项能力未通过最终运行时门禁，首页仅展示阻断摘要。</Typography.Text>
                {blockedReadiness.slice(0, 2).map((row) => (
                  <div className="ops-overview-readiness-row" key={row.key}>
                    <span className="ops-overview-status-dot blocked" />
                    <strong>{row.label}</strong>
                    <Tag color="red">阻断</Tag>
                    <Typography.Text type="secondary">{row.reasons[0] ?? "等待服务端确认"}</Typography.Text>
                  </div>
                ))}
                {blockedReadiness.length > 2 ? <Typography.Text type="secondary">另有 {blockedReadiness.length - 2} 项阻断，详见平台总览。</Typography.Text> : null}
              </>
            ) : displayModelStatus ? (
              <Typography.Text type="secondary">五模态均已通过最终运行时门禁；具体成本和计费倍率请在账务中心核对。</Typography.Text>
            ) : (
              <Typography.Text type="secondary">模型状态尚未取得，不能把配置状态解释为可用。</Typography.Text>
            )}
          </div>
        </Card>
      </Col>
    </Row>
  );
}
