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
import { Button, Card, Col, Row, Space, Statistic, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../../../navigation/opsNavigation";
import { modelReadinessRows } from "./modelReadiness";

interface PlatformOverviewSnapshotProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

const money = (value: number | undefined) => value === undefined ? "—" : `¥${value.toFixed(2)}`;

export function PlatformOverviewSnapshot({ model, onNavigate }: PlatformOverviewSnapshotProps) {
  const finance = model.platformFinanceSummary;
  const merchantWorkspaceCount = (model.workspaceDirectory as typeof model.workspaceDirectory & { merchantWorkspaceCount?: number }).merchantWorkspaceCount;
  const tasks = model.platformTaskSummary;
  const marketing = model.platformMarketingSummary;
  const usage = model.platformModelUsageSummary;
  const readiness = modelReadinessRows(model.modelStatus);
  const readyModels = readiness.filter((row) => row.ready).length;
  const openAlerts = model.alerts.filter((alert) => alert.status === "open").length;
  const connectedPlatforms = new Set(
    model.platformOperations
      .filter((operation) => operation.connectedAccountCount || operation.state === "connected")
      .map((operation) => operation.platform),
  ).size;
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
            <Statistic title="模型能力" value={model.modelStatus ? `${readyModels}/${readiness.length}` : "—"} prefix={<RobotOutlined />} />
            <span>{model.modelStatus ? `${readiness.length - readyModels} 项能力被阻断` : "模型状态尚未取得"}</span>
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

      <Row gutter={[12, 12]} className="ops-overview-status-grid">
        <Col xs={24} xl={14}>
          <Card
            size="small"
            title={<span><RobotOutlined /> 模型能力门禁</span>}
            extra={<Button type="link" onClick={() => onNavigate("models")}>查看模型详情</Button>}
          >
            <div className="ops-overview-readiness-list">
              {readiness.length ? readiness.map((row) => (
                <div className="ops-overview-readiness-row" key={row.key}>
                  <span className={`ops-overview-status-dot ${row.ready ? "ready" : "blocked"}`} />
                  <strong>{row.label}</strong>
                  <Tag color={row.ready ? "green" : "red"}>{row.ready ? "可用" : "阻断"}</Tag>
                  <Typography.Text type="secondary">{row.ready ? "已通过最终运行时门禁" : row.reasons[0] ?? "等待服务端确认"}</Typography.Text>
                </div>
              )) : <Typography.Text type="secondary">模型状态尚未取得，不能把配置状态解释为可用。</Typography.Text>}
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card
            size="small"
            title={<span><ExclamationCircleOutlined /> 运营待办</span>}
            extra={<Button type="link" onClick={() => onNavigate("users")}>进入用户中心</Button>}
          >
            <div className="ops-overview-action-list">
              <div><span className="ops-overview-action-number">{openAlerts || "—"}</span><span><strong>开放告警</strong><small>{openAlerts ? "需要平台运营确认或分派" : "告警数据尚未取得"}</small></span></div>
              <div><span className="ops-overview-action-number">{tasks ? totalQueue : "—"}</span><span><strong>执行队列</strong><small>{tasks ? "生成和发布任务等待处理" : "任务汇总尚未取得"}</small></span></div>
              <div><span className="ops-overview-action-number">{model.platformBrandUnitSummary?.unboundBrandCount ?? "—"}</span><span><strong>未绑定品牌</strong><small>{model.platformBrandUnitSummary ? "需要补齐品牌与店铺关系" : "品牌汇总尚未取得"}</small></span></div>
            </div>
            <Space wrap className="ops-overview-quick-actions">
              <Button onClick={() => onNavigate("users")}>管理商家授权</Button>
              <Button onClick={() => onNavigate("finance")}>查看平台账务</Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </section>
  );
}
