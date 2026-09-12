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

const subscriptionLabels: Record<string, string> = {
  active: "订阅有效",
  trialing: "试用中",
  past_due: "待处理",
  canceled: "已取消",
  inactive: "未开通",
};

export function CommercialOverviewSection({ model, onNavigate }: OverviewSectionProps) {
  const finance = model.platformFinanceSummary;
  const rows = model.workspaceRows;
  const plans = planDistribution(rows);
  const workspaceCount = model.workspaceDirectory.total || rows.length;
  const merchantWorkspaceCount = (model.workspaceDirectory as typeof model.workspaceDirectory & { merchantWorkspaceCount?: number }).merchantWorkspaceCount;
  const financeAvailable = Boolean(finance);
  const catalog = model.platformCommercialCatalog;
  const skuRows = currentCommercialCatalog(catalog
    .filter((item) => item.visibility !== "private"))
    .map((item) => ({
      ...item,
      orderCount: finance?.commercialOrderBySku?.[item.skuCode]?.orderCount ?? 0,
      workspaceCount: finance?.commercialOrderBySku?.[item.skuCode]?.workspaceCount ?? 0,
    }));
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
      <Row gutter={[16, 16]} aria-label="平台经营指标">
        <Col xs={24} md={6}>
          <Card>
            <Statistic title="有效商家" value={merchantWorkspaceCount ?? "—"} suffix={merchantWorkspaceCount !== undefined ? " 家" : undefined} prefix={<SafetyCertificateOutlined />} />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card>
            <Statistic
              title="工作区记录"
              value={workspaceCount ?? "—"}
              suffix={workspaceCount !== undefined ? " 条" : undefined}
              prefix={<TeamOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card>
            <Statistic
              title="月度套餐收入（已核验）"
              value={financeAvailable ? finance!.subscriptionOrderCny : "—"}
              precision={2}
              prefix={financeAvailable ? "¥" : <DollarOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card>
            <Statistic
              title="创意点包收入（已核验）"
              value={financeAvailable ? (finance!.pointPackOrderCny ?? "—") : "—"}
              precision={2}
              prefix={financeAvailable ? "¥" : <DollarOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card>
            <Statistic
              title="真实充值到账"
              value={financeAvailable ? (finance!.verifiedRechargeOrderCny ?? "—") : "—"}
              precision={2}
              prefix={financeAvailable ? "¥" : <DollarOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card>
            <Statistic
              title="本地测试充值"
              value={financeAvailable ? (finance!.fixtureRechargeOrderCny ?? "—") : "—"}
              precision={2}
              prefix={financeAvailable ? "¥" : <DollarOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Card title="商业化 SKU 与订购情况" style={{ marginTop: 16 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          价格和权益来自服务端 V2 SKU 快照；订单按月度订阅、创意点包和开通服务分别统计，只有已支付且有核验支付事件的订单才进入收入。
        </Typography.Paragraph>
        <Table
          rowKey="id"
          size="small"
          dataSource={skuRows}
          pagination={false}
          scroll={{ x: 980 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="商业 SKU 尚未取得" /> }}
          columns={[
            { title: "SKU", dataIndex: "skuCode", width: 180, render: (value: string, row: CommercialCatalogItem) => <Space orientation="vertical" size={0}><Typography.Text strong>{row.name}</Typography.Text><Typography.Text code>{value}</Typography.Text></Space> },
            { title: "类型", dataIndex: "type", width: 120, render: (value: string) => ({ onboarding: "正式开通", monthly: "月度订阅", point_pack: "点数包", private_trial: "私测试用" }[value] ?? value) },
            { title: "价格", dataIndex: "priceLabel", width: 150 },
            { title: "权益", dataIndex: "benefitsSummary", width: 360, render: (value: string) => <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>{value}</Typography.Paragraph> },
            { title: "已付订单", dataIndex: "orderCount", width: 100, align: "right" },
            { title: "已付商家", dataIndex: "workspaceCount", width: 100, align: "right" },
            { title: "状态", dataIndex: "approvalState", width: 110, render: (value: string) => <Tag color={value === "approved" ? "green" : "gold"}>{value === "approved" ? "已批准" : value === "draft" ? "草稿" : value}</Tag> },
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
        财务口径：月度订阅、创意点包、开通服务和充值分开核算；本地 fixture 充值单独展示，不计入真实收入。
        {financeAvailable ? " 金额来自跨企业主体财务汇总。" : " 财务汇总尚未取得，金额不解释为 0。"}
        {!catalog.length ? " 套餐目录尚未取得，SKU 数量不解释为 0。" : ""}
      </Typography.Text>
    </div>
  );
}
