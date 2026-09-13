import { CommercialOperationsWorkspace } from "../components/commercial/CommercialOperationsWorkspace.js";
import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { commercialViewCapability, useCommercialOperations } from "../hooks/useCommercialOperations.js";
import { CommercialReadinessPanel } from "../components/commercial/CommercialReadinessPanel.js";
import { FinanceSearchSection } from "../components/finance/FinanceSearchSection.js";
import { ReconciliationSection } from "../components/finance/ReconciliationSection.js";
import { RechargeOrdersSection } from "../components/finance/RechargeOrdersSection.js";
import { RefundSection } from "../components/finance/RefundSection.js";
import { ModelMarkupPanel } from "../components/finance/ModelMarkupPanel.js";
import { financeSearchClient } from "../api/opsDomainClients.js";
import { useFinanceSearch } from "../hooks/useFinanceSearch.js";
import { ReloadOutlined, SettingOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { readableCatalogStatus } from "../components/sections/overview/CommercialOverviewSection.js";
import { readableBenefits } from "../components/commercial/benefitLabels.js";
import { packageCodeLabel, packageDisplayName } from "../components/commercial/packageLabels.js";
import type { CommercialCatalogItem } from "../api/commercialOperationsClient.js";
import { commercialOperationsClient } from "../api/commercialOperationsClient.js";

function latestCatalogVersions(items: readonly CommercialCatalogItem[]): CommercialCatalogItem[] {
  const bySku = new Map<string, CommercialCatalogItem>();
  for (const item of items) {
    const current = bySku.get(item.skuCode);
    const version = Number.parseInt(item.version.replace(/^v/u, ""), 10);
    const currentVersion = current ? Number.parseInt(current.version.replace(/^v/u, ""), 10) : -1;
    if (!current || (Number.isFinite(version) ? version : -1) > currentVersion) bySku.set(item.skuCode, item);
  }
  return [...bySku.values()].sort((left, right) => left.skuCode.localeCompare(right.skuCode));
}

function PlatformCatalogManagementPanel({ model }: { model: OpsConsoleModel }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CommercialCatalogItem | null>(null);
  const [editor, setEditor] = useState<CommercialCatalogItem | null | false>(false);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const rows = latestCatalogVersions(model.platformCommercialCatalog.filter(item => item.visibility !== "private"))
    .filter(item => !query.trim() || [item.name, item.skuCode, item.priceLabel, readableBenefits(item)].some(value => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const canWrite = model.authorization.can("commercial.catalog.draft");
  const canPublish = model.authorization.can("commercial.catalog.publish");
  const openEditor = (row?: CommercialCatalogItem) => {
    setEditor(row ?? null);
    form.setFieldsValue({ code: row?.skuCode ?? "", name: row?.name ?? "", kind: row?.type ?? "monthly", priceFen: row ? Number((row.priceLabel.match(/[0-9.]+/)?.[0] ?? "0")) * 100 : 0 });
  };
  const saveDraft = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      await commercialOperationsClient.mutateCatalog({ action: "create", code: values.code.trim(), kind: values.kind, priceFen: Math.round(Number(values.priceFen)), payload: { name: values.name.trim(), blockers: [] }, reason: editor ? "运营后台编辑套餐并创建新版本" : "运营后台新增套餐草稿", benefits: [] });
      message.success(editor ? "已创建套餐新版本草稿" : "已创建套餐草稿");
      setEditor(false);
      await model.load();
    } catch (error) { message.error(error instanceof Error ? error.message : "套餐写入失败"); }
    finally { setBusy(false); }
  };
  const retire = async (row: CommercialCatalogItem) => {
    setBusy(true);
    try { await commercialOperationsClient.mutateCatalog({ action: "retire", code: row.skuCode, reason: "运营后台下架套餐", benefits: [] }); message.success("已创建套餐退休版本"); await model.load(); }
    catch (error) { message.error(error instanceof Error ? error.message : "套餐下架失败"); }
    finally { setBusy(false); }
  };
  const transition = async (row: CommercialCatalogItem, action: "approve" | "publish") => {
    setBusy(true);
    try {
      await commercialOperationsClient.mutateCatalog({ action, code: row.skuCode, reason: action === "approve" ? "运营后台审批套餐版本" : "运营后台发布套餐版本", benefits: [] });
      message.success(action === "approve" ? "套餐版本已审批通过" : "套餐版本已发布生效");
      await model.load();
    } catch (error) { message.error(error instanceof Error ? error.message : "套餐状态变更失败"); }
    finally { setBusy(false); }
  };
  return (
    <Card
      className="ops-finance-secondary-panel"
      title="套餐管理"
      extra={<Space wrap>
        <Button onClick={() => void model.load()}>刷新目录</Button>
        <Button type="primary" disabled={!canWrite} onClick={() => openEditor()}>{canWrite ? "新增套餐" : "新增套餐（无权限）"}</Button>
      </Space>}
    >
      <Alert
        type="warning"
        showIcon
        title="目录采用版本化生命周期"
        description="新增和编辑会创建新版本草稿；审批通过、发布生效与下架都会追加不可变版本并写入审计事件。"
        style={{ marginBottom: 16 }}
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索套餐名称、SKU、价格或权益" aria-label="搜索套餐目录" style={{ width: 320 }} />
        <Typography.Text type="secondary">当前显示 {rows.length} 个公开套餐版本</Typography.Text>
      </Space>
      {rows.length ? <Table
        rowKey="id"
        size="small"
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 1120 }}
        columns={[
          { title: "套餐", fixed: "left", width: 210, render: (_: unknown, row: CommercialCatalogItem) => <Space orientation="vertical" size={0}><Typography.Text strong>{packageDisplayName(row.skuCode, row.name)}</Typography.Text><Typography.Text type="secondary" code>{packageCodeLabel(row.skuCode)}</Typography.Text></Space> },
          { title: "类型", dataIndex: "type", width: 110, render: (value: string) => ({ monthly: "月度订阅", point_pack: "点数包", onboarding: "正式开通", private_trial: "私测" }[value] ?? value) },
          { title: "价格", dataIndex: "priceLabel", width: 130 },
          { title: "套餐权益", width: 380, render: (_: unknown, row: CommercialCatalogItem) => <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>{readableBenefits(row)}</Typography.Paragraph> },
          { title: "商业状态", dataIndex: "approvalState", width: 120, render: (_: string, row: CommercialCatalogItem) => <Tag color={row.executable ? "green" : row.approvalState === "approved" ? "blue" : "gold"}>{readableCatalogStatus(row)}</Tag> },
          { title: "操作", fixed: "right", width: 360, render: (_: unknown, row: CommercialCatalogItem) => <Space wrap><Button size="small" onClick={() => setSelected(row)}>详情</Button><Button size="small" disabled={!canWrite} onClick={() => openEditor(row)}>编辑新版本</Button>{row.approvalState === "draft" && <Button size="small" type="primary" disabled={!canPublish || busy} onClick={() => void transition(row, "approve")}>审批通过</Button>}{row.approvalState === "approved" && !row.executable && <Button size="small" type="primary" disabled={!canPublish || busy} onClick={() => void transition(row, "publish")}>发布生效</Button>}<Tooltip title="删除采用不可变目录的退休语义"><Button danger size="small" disabled={!canPublish || busy || readableCatalogStatus(row) === "已停售"} onClick={() => void retire(row)}>下架</Button></Tooltip></Space> },
        ]}
      /> : <Empty description={model.platformCommercialCatalog.length ? "没有匹配的套餐" : "服务端尚未返回套餐目录"} />}
      <Drawer title="套餐详情" open={Boolean(selected)} onClose={() => setSelected(null)} destroyOnHidden>
        {selected ? <Descriptions bordered size="small" column={1} items={[
          { key: "sku", label: "套餐 / SKU", children: <Space orientation="vertical" size={0}><Typography.Text strong>{packageDisplayName(selected.skuCode, selected.name)}</Typography.Text><Typography.Text code>{selected.skuCode}</Typography.Text></Space> },
          { key: "type", label: "售卖类型", children: selected.type },
          { key: "price", label: "价格 / 周期", children: `${selected.priceLabel} / ${selected.cycleLabel ?? "一次性"}` },
          { key: "benefits", label: "套餐权益", children: readableBenefits(selected) },
          { key: "status", label: "商业状态", children: readableCatalogStatus(selected) },
          { key: "validity", label: "生效窗口", children: `${selected.validFrom ?? "未开始"}${selected.validTo ? ` 至 ${selected.validTo}` : " / 无截止"}` },
          { key: "unresolved", label: "未决项", children: selected.unresolved.length ? selected.unresolved.join("、") : "无" },
        ]} /> : null}
      </Drawer>
      <Modal title={editor ? "编辑套餐（创建新版本草稿）" : "新增套餐草稿"} open={editor !== false} onCancel={() => setEditor(false)} onOk={() => void saveDraft()} okText="保存草稿" confirmLoading={busy} destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="SKU 编码" rules={[{ required: true, pattern: /^[a-z0-9_\-]+$/, message: "仅允许小写字母、数字、下划线和短横线" }]}><Input disabled={Boolean(editor)} /></Form.Item>
          <Form.Item name="name" label="套餐名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="kind" label="套餐类型" rules={[{ required: true }]}><Select options={[{ value: "monthly", label: "月度订阅" }, { value: "point_pack", label: "点数包" }, { value: "onboarding", label: "正式开通" }, { value: "private_trial", label: "私测套餐" }]} /></Form.Item>
          <Form.Item name="priceFen" label="价格（分）" rules={[{ required: true, type: "number", min: 0 }]}><InputNumber min={0} precision={0} style={{ width: "100%" }} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

interface FinancePageProps { model: OpsConsoleModel; }
export function FinancePage({ model }: FinancePageProps) {
  const isPlatformWorkbench = model.opsSession?.workbench
    ? model.opsSession.workbench === "platform"
    : model.authorization.scope.kind === "platform";
  const commercial = useCommercialOperations(model.authorization, undefined, !isPlatformWorkbench);
  const [workspaceDraft, setWorkspaceDraft] = useState(commercial.targetWorkspaceId);
  useEffect(() => setWorkspaceDraft(commercial.targetWorkspaceId), [commercial.targetWorkspaceId]);
  const canRefresh = model.authorization.can("commercial.access.read") && model.authorization.can(commercialViewCapability[commercial.view]);
  const canSearchFinance = model.authorization.can("billing.platform.read");
  const isWorkspaceWorkbench = !isPlatformWorkbench;
  const financeSearch = useFinanceSearch(financeSearchClient, { limit: 20 }, canSearchFinance);
  const [showBillingControl, setShowBillingControl] = useState(false);
  const [showCommercialReadiness, setShowCommercialReadiness] = useState(false);
  useEffect(() => {
    // Platform sessions must not hydrate workspace-scoped recharge orders.
    // The API correctly rejects that request, but issuing it from the page
    // creates a misleading 403 in the platform walk and can mask real errors.
    if (isWorkspaceWorkbench && !canSearchFinance) void model.loadRechargeOrders();
  }, [canSearchFinance, isWorkspaceWorkbench]);
  return (
    <OpsPage
      eyebrow="COMMERCIAL OPERATIONS"
      title={isPlatformWorkbench ? "平台财务中心" : "账务与商业配置"}
      headingLevel={2}
      description={isPlatformWorkbench ? "查看全平台财务记录、企业主体商业化开通状态和成本证据，平台范围由服务端权限投影决定。" : "处理企业主体商业准入、权益、创意点账本、版本化目录、支付、费率与服务履约。"}
      actions={isPlatformWorkbench ? (
        <Space wrap>
          <Tag color="blue">平台工作台</Tag>
          <Button type="primary" icon={<ReloadOutlined />} loading={financeSearch.loading} disabled={!canSearchFinance} onClick={() => void Promise.all([financeSearch.search(), model.load()])}>刷新平台账务</Button>
        </Space>
      ) : (
        <Space wrap>
          <Typography.Text type="secondary">目标企业主体</Typography.Text>
          <Input aria-label="商业目标企业主体 Workspace ID" placeholder="例如 ws_demo" value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} onPressEnter={() => commercial.setTargetWorkspace(workspaceDraft)} style={{ width: 180 }} />
          <Button onClick={() => commercial.setTargetWorkspace(workspaceDraft)} disabled={!workspaceDraft.trim()}>应用范围</Button>
          <Button type="primary" disabled={!canRefresh} loading={commercial.summary.status === "loading" || commercial.data[commercial.view].status === "loading"} onClick={() => void Promise.all([commercial.loadSummary(), commercial.loadView()])}>刷新账务</Button>
        </Space>
      )}
      nextStep={isPlatformWorkbench ? "先核对跨企业主体财务记录和成本证据，再进入对应企业主体处理具体订单或权益。" : "先处理阻断与待对账事项；支付成功后仍需核验权益发放与新的访问版本。"}
    >
      <div className="ops-finance-page">
        {isPlatformWorkbench ? <>
          {model.canModelMarkup ? (
            <Card
              size="small"
              className="ops-finance-secondary-panel"
              title={<Space><SettingOutlined aria-hidden="true" />模型计费倍率<Tag color="gold">高影响配置</Tag></Space>}
              extra={<Button type="link" onClick={() => setShowBillingControl((visible) => !visible)}>{showBillingControl ? "收起配置" : "调整计费"}</Button>}
            >
              <Space wrap size={12}>
                <Typography.Text type="secondary">平台统一控制模型成本加价；每次变更保留原因、revision 与审计记录。</Typography.Text>
                <Tag color={model.modelMarkup ? "blue" : "default"}>当前倍率 {model.modelMarkup ? `${model.modelMarkup.multiplier}×` : "读取中"}</Tag>
              </Space>
              {showBillingControl ? <div style={{ marginTop: 12 }}><ModelMarkupPanel model={model} /></div> : null}
            </Card>
          ) : null}
          {canSearchFinance ? <FinanceSearchSection controller={financeSearch} showProviderStatementStatus={false} compactSummary /> : (
            <Alert
              type="info"
              showIcon
              title="平台财务检索未授权"
              description="当前会话未获得服务端投影的 billing.platform.read 能力，因此没有发起跨企业主体财务查询。请由平台管理员更新权限后重新登录。"
            />
          )}
          {model.authorization.can("commercial.catalog.read") ? <PlatformCatalogManagementPanel model={model} /> : null}
          <Card
            size="small"
            className="ops-finance-secondary-panel"
            title="商业化生产门禁"
            extra={<Button type="link" onClick={() => setShowCommercialReadiness((visible) => !visible)}>{showCommercialReadiness ? "收起证据" : "查看证据"}</Button>}
          >
            <Typography.Text type="secondary">仅在核对 SKU、商业规则和费率证据时展开；它不会影响平台账务检索。</Typography.Text>
            {showCommercialReadiness ? <div style={{ marginTop: 12 }}><CommercialReadinessPanel authorization={model.authorization} /></div> : null}
          </Card>
        </> : <>
          <ReconciliationSection model={model} />
          <RechargeOrdersSection model={model} />
          <RefundSection model={model} />
          <CommercialOperationsWorkspace controller={commercial} />
        </>}
      </div>
    </OpsPage>
  );
}
