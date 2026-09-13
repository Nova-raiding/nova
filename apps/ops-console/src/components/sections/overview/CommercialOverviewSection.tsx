import {
  ArrowRightOutlined,
  DollarOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Button, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../../../navigation/opsNavigation";
import type { WorkspaceSummary } from "../../../types/ops";
import type { CommercialCatalogItem } from "../../../api/commercialOperationsClient";
import { EnterpriseIdentity } from "../../EnterpriseIdentity";
import { readableBenefitItems } from "../../commercial/benefitLabels.js";
import { packageDisplayName } from "../../commercial/packageLabels.js";

interface OverviewSectionProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

export const formatOverviewMoney = (value: number | undefined): string =>
  value === undefined ? "—" : `¥${value.toFixed(2)}`;

export function planDistribution(rows: readonly WorkspaceSummary[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const name = row.planName || "未配置";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

export function currentCommercialCatalog(
  items: readonly CommercialCatalogItem[],
): CommercialCatalogItem[] {
  const bySku = new Map<string, CommercialCatalogItem[]>();
  items.forEach((item) => {
    const existing = bySku.get(item.skuCode) ?? [];
    existing.push(item);
    bySku.set(item.skuCode, existing);
  });
  return [...bySku.values()]
    .map((versions) => [...versions].sort((left, right) => {
      const executableDifference = Number(right.approvalState === "approved" && right.unresolved.length === 0)
        - Number(left.approvalState === "approved" && left.unresolved.length === 0);
      if (executableDifference !== 0) return executableDifference;
      const rightVersion = Number.parseInt(right.version.replace(/^v/u, ""), 10);
      const leftVersion = Number.parseInt(left.version.replace(/^v/u, ""), 10);
      return (Number.isFinite(rightVersion) ? rightVersion : 0) - (Number.isFinite(leftVersion) ? leftVersion : 0);
    })[0]!)
    .sort((left, right) => left.skuCode.localeCompare(right.skuCode));
}

const catalogStatusLabels: Record<string, string> = {
  draft: "草稿",
  pending_business_approval: "待业务审批",
  approved: "已批准待生效",
  active: "生效可售",
  retired: "已停售",
};

export function readableCatalogStatus(item: CommercialCatalogItem): string {
  if (item.approvalState === "retired") return catalogStatusLabels.retired;
  if (item.approvalState === "draft") return catalogStatusLabels.draft;
  if (item.approvalState === "pending_business_approval") return catalogStatusLabels.pending_business_approval;
  if (item.approvalState === "approved" && item.unresolved.length === 0 && item.validFrom) return catalogStatusLabels.active;
  return catalogStatusLabels.approved;
}

/**
 * Commercial health metrics stay grouped with the commercial ledger rather
 * than competing with the platform incident and queue KPIs above the fold.
 * Workspace counts and local test fixtures are intentionally not repeated
 * here; this surface is reserved for business-facing finance metrics.
 */
export function CommercialOverviewKpis({ model }: { model: OpsConsoleModel }) {
  const finance = model.platformFinanceSummary;
  const financeAvailable = Boolean(finance);

  return (
    <Row gutter={[12, 12]} className="ops-overview-kpi-grid" aria-label="平台商业化指标">
      <Col xs={24} sm={12} xl={6}>
        <Card className="ops-overview-kpi-card ops-overview-kpi-cyan">
          <Statistic title="充值到账（已核验）" value={financeAvailable ? (finance!.verifiedRechargeOrderCny ?? "—") : "—"} precision={2} prefix={financeAvailable ? "¥" : <DollarOutlined />} />
          <span>{financeAvailable ? "已核验的真实支付到账" : "账务汇总尚未取得"}</span>
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card className="ops-overview-kpi-card ops-overview-kpi-amber">
          <Statistic title="订阅收入（已核验）" value={financeAvailable ? finance!.subscriptionOrderCny : "—"} precision={2} prefix={financeAvailable ? "¥" : <DollarOutlined />} />
          <span>{financeAvailable ? "已支付且完成核验的订阅订单" : "账务汇总尚未取得"}</span>
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card className="ops-overview-kpi-card ops-overview-kpi-violet">
          <Statistic title="创意点核销" value="—" prefix={<DollarOutlined />} />
          <span>服务端暂未提供平台级创意点核销汇总</span>
        </Card>
      </Col>
    </Row>
  );
}

const subscriptionLabels: Record<string, string> = {
  active: "订阅有效",
  trialing: "试用中",
  past_due: "待处理",
  canceled: "已取消",
  inactive: "未开通",
};

export function CommercialOverviewSection({ model, onNavigate }: OverviewSectionProps) {
  const finance = model.platformFinanceSummary;
  const financeAvailable = Boolean(finance);
  const rows = model.workspaceRows;
  const plans = planDistribution(rows);
  const catalog = model.platformCommercialCatalog;
  const skuRows = currentCommercialCatalog(catalog.filter((item) => item.visibility !== "private"));
  const openAuthorization = (workspaceId?: string) => {
    model.setAuthorizationTargetWorkspaceId(workspaceId ?? "");
    onNavigate("users");
  };
  const workspaceColumns: ColumnsType<WorkspaceSummary> = [
    {
      title: "企业主体",
      dataIndex: "workspaceId",
      width: 230,
      render: (value: string, row: WorkspaceSummary) => (
        <Space orientation="vertical" size={0}>
          <EnterpriseIdentity name={row.enterpriseName} workspaceId={value} />
        </Space>
      ),
    },
    { title: "套餐", dataIndex: "planName", width: 140, render: (value: string) => value || "未配置" },
    {
      title: "订阅状态",
      dataIndex: "subscriptionStatus",
      width: 130,
      render: (value: string) => (
        <Tag color={value === "active" ? "green" : "gold"}>
          {subscriptionLabels[value] ?? (value || "未确认")}
        </Tag>
      ),
    },
    {
      title: "月费",
      dataIndex: "monthlyPriceCny",
      width: 110,
      align: "right",
      render: (value: number) => formatOverviewMoney(value),
    },
    { title: "成员", dataIndex: "memberCount", width: 90, align: "right" },
    {
      title: "操作",
      key: "action",
      width: 120,
      render: (_value: unknown, row: WorkspaceSummary) => (
        <Button type="link" icon={<ArrowRightOutlined />} onClick={() => openAuthorization(row.workspaceId)}>
          查看该企业授权
        </Button>
      ),
    },
  ];

  return (
    <div className="ops-overview-commercial">
      <CommercialOverviewKpis model={model} />
      <Card
        title="商业套餐目录"
        style={{ marginTop: 16 }}
        extra={
          <Space wrap>
            <Button onClick={() => onNavigate("finance")}>查看订单与权益</Button>
            <Button type="primary" icon={<SafetyCertificateOutlined />} onClick={() => onNavigate("finance")}>
              套餐管理（新增 / 编辑 / 删除）
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          这里维护“卖什么”：价格、周期、面向用户的套餐权益和商业生效状态。订单与实际授予的工作区权益请在“订单与权益”中查看；同一套餐可以对应多笔订单。
        </Typography.Paragraph>
        <Table
          rowKey="id"
          size="small"
          dataSource={skuRows}
          pagination={false}
          scroll={{ x: 980 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="商业 SKU 尚未取得" /> }}
          columns={[
            { title: "套餐", dataIndex: "skuCode", width: 220, render: (value: string, row: CommercialCatalogItem) => <Space orientation="vertical" size={0}><Typography.Text strong>{packageDisplayName(value, row.name)}</Typography.Text><Typography.Text type="secondary" code>{value}</Typography.Text></Space> },
            { title: "类型", dataIndex: "type", width: 120, render: (value: string) => ({ onboarding: "正式开通", monthly: "月度订阅", point_pack: "点数包", private_trial: "私测试用" }[value] ?? value) },
            { title: "价格", dataIndex: "priceLabel", width: 150 },
            { title: "套餐权益（中文明细）", dataIndex: "benefitsSummary", width: 390, render: (_value: string, row: CommercialCatalogItem) => <Space direction="vertical" size={2}>{readableBenefitItems(row).map((benefit) => <Typography.Text key={benefit} style={{ fontSize: 12 }}>• {benefit}</Typography.Text>)}</Space> },
            { title: "操作", key: "catalog-action", width: 170, render: () => <Button type="link" onClick={() => onNavigate("finance")}>进入套餐管理</Button> },
            { title: "生效周期", dataIndex: "cycleLabel", width: 130, render: (value: string | null) => value || "按合同" },
            { title: "商业状态", dataIndex: "approvalState", width: 140, render: (_value: string, row: CommercialCatalogItem) => <Tag color={readableCatalogStatus(row) === "生效可售" ? "green" : readableCatalogStatus(row) === "已停售" ? "default" : "gold"}>{readableCatalogStatus(row)}</Tag> },
          ]}
        />
      </Card>

      <Card
        title="商家经营台账"
        style={{ marginTop: 16 }}
        extra={
          <Space wrap>
            <Button icon={<TeamOutlined />} onClick={() => openAuthorization()}>
              管理企业授权
            </Button>
            <Button type="primary" icon={<SafetyCertificateOutlined />} onClick={() => onNavigate("finance")}>
              配置套餐
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          查看企业主体当前套餐和订阅状态；授权变更统一在用户中心完成，服务端 SKU 价格、权益和订单统一在账务与退款中维护。企业名称作为主识别信息，Workspace ID 只用于技术范围和审计。
        </Typography.Paragraph>
        <Table<WorkspaceSummary>
          rowKey="workspaceId"
          size="small"
          dataSource={rows}
          columns={workspaceColumns}
          pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 820 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无商家数据" /> }}
        />
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={10}>
          <Card title="当前页套餐分布" extra={<Typography.Text type="secondary">台账页 {rows.length} 家</Typography.Text>}>
            {plans.length ? (
              <Space orientation="vertical" style={{ width: "100%" }} size="middle">
                {plans.map((plan) => (
                  <div key={plan.name} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                    <Typography.Text>{plan.name}</Typography.Text>
                    <Typography.Text strong>{plan.count} 个企业主体</Typography.Text>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无套餐分布" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="运营动作">
            <Space wrap>
              <Button icon={<TeamOutlined />} onClick={() => openAuthorization()}>
                给企业授权
              </Button>
              <Button icon={<SafetyCertificateOutlined />} onClick={() => onNavigate("finance")}>
                管理套餐
              </Button>
              <Button icon={<DollarOutlined />} onClick={() => onNavigate("finance")}>
                查看财务流水
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 16 }}>
              总览只保留经营决策需要的数据。模型、平台连接、规则、存储和系统风险请在各自工作台处理。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      <Typography.Text type="secondary" style={{ display: "block", marginTop: 12 }}>
        财务口径：充值、订阅与创意点核销分开核算；仅展示已支付且完成核验的业务收入。
        {financeAvailable ? " 金额来自跨企业主体财务汇总。" : " 财务汇总尚未取得，金额不解释为 0。"}
        {!catalog.length ? " 套餐目录尚未取得，SKU 数量不解释为 0。" : ""}
      </Typography.Text>
    </div>
  );
}
