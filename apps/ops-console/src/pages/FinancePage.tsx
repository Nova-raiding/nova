import { CommercialOperationsWorkspace } from "../components/commercial/CommercialOperationsWorkspace.js";
import { OpsPage } from "../components/OpsPage";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { commercialViewCapability, useCommercialOperations } from "../hooks/useCommercialOperations.js";
import { CommercialReadinessPanel } from "../components/commercial/CommercialReadinessPanel.js";
import { FinanceSearchSection } from "../components/finance/FinanceSearchSection.js";
import { ReconciliationSection } from "../components/finance/ReconciliationSection.js";
import { RechargeOrdersSection } from "../components/finance/RechargeOrdersSection.js";
import { RefundSection } from "../components/finance/RefundSection.js";
import { financeSearchClient } from "../api/opsDomainClients.js";
import { useFinanceSearch } from "../hooks/useFinanceSearch.js";
import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { readableCatalogStatus } from "../components/sections/overview/CommercialOverviewSection.js";
import { commercialBenefitDescriptions, commercialBenefitOptions, readableBenefitItems, readableBenefits } from "../components/commercial/benefitLabels.js";
import { packageCodeLabel, packageDisplayName } from "../components/commercial/packageLabels.js";
import type { CommercialCatalogItem } from "../api/commercialOperationsClient.js";
import { commercialOperationsClient } from "../api/commercialOperationsClient.js";
import { fenToYuan, yuanToFen } from "../utils/currency.js";

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

/**
 * Keep the editable amount tied to the server's integer-fen value. Display
 * labels are localized presentation and may contain thousands separators; the
 * old `match(/[0-9.]+/)` fallback turned `¥1,999.00` into `1` yuan.
 */
export function catalogPriceYuan(item: Pick<CommercialCatalogItem, "priceFen" | "priceLabel">): number {
  if (typeof item.priceFen === "number" && Number.isFinite(item.priceFen) && item.priceFen >= 0)
    return fenToYuan(item.priceFen);
  const normalized = item.priceLabel.replace(/[,_\s]/gu, "");
  const matched = normalized.match(/\d+(?:\.\d+)?/u)?.[0];
  return matched ? Number(matched) : 0;
}

/**
 * What the public-catalog count line is allowed to claim.
 *
 * `platformCommercialCatalog` seeds as `[]` and is only replaced by a read that
 * landed, so `rows.length` measures nothing until `ops.commercial.catalog-v2.list`
 * answers. The line printed a confident 「当前显示 0 个公开套餐版本」 both before
 * that read came back and after it failed — a measured zero over a catalog
 * nobody had read. A failed refresh leaves the previous rows in place
 * (`applyLoadedValue` skips an undefined result), so a count that survives one
 * is marked as possibly stale rather than reprinted as freshly measured.
 */
function catalogVersionCountPresentation(
  rowCount: number,
  { error, loading }: { error?: string; loading: boolean },
): { type: "secondary" | "danger"; label: string } {
  if (error) {
    return rowCount
      ? { type: "danger", label: `当前显示 ${rowCount} 个公开套餐版本（最近一次目录读取失败，可能已过期）` }
      : { type: "danger", label: "套餐目录读取失败，公开套餐版本数量不可用（不是 0）" };
  }
  if (loading && !rowCount) return { type: "secondary", label: "套餐目录读取中，公开套餐版本数量暂不可用" };
  return { type: "secondary", label: `当前显示 ${rowCount} 个公开套餐版本` };
}

function PlatformCatalogManagementPanel({ model }: { model: OpsConsoleModel }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CommercialCatalogItem | null>(null);
  const [editor, setEditor] = useState<CommercialCatalogItem | null | false>(false);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const rows = latestCatalogVersions(model.platformCommercialCatalog.filter(item => item.visibility !== "private"))
    .filter(item => !query.trim() || [item.name, item.skuCode, item.priceLabel, readableBenefits(item)].some(value => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const catalogCount = catalogVersionCountPresentation(rows.length, { error: model.dataSetError("ops.commercial.catalog-v2.list"), loading: model.loading });
  const canWrite = model.authorization.can("commercial.catalog.draft");
  const canPublish = model.authorization.can("commercial.catalog.publish");
  const openEditor = (row?: CommercialCatalogItem) => {
    setEditor(row ?? null);
    form.setFieldsValue({ code: row?.skuCode ?? "", name: row?.name ?? "", kind: row?.type ?? "monthly", priceYuan: row ? catalogPriceYuan(row) : 0, benefits: row?.benefits?.map((benefit) => ({ code: benefit.code, value: benefit.rawValue ?? (benefit.quantity === null ? "" : String(benefit.quantity)), unit: benefit.rawUnit ?? "" })) ?? [] });
  };
  const saveDraft = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      const benefits = (values.benefits ?? []).filter((benefit: { code?: string; value?: string }) => benefit.code?.trim() && benefit.value?.trim()).map((benefit: { code: string; value: string; unit?: string }) => {
        const value = benefit.value.trim();
        const numeric = /^-?\d+(?:\.\d+)?$/u.test(value) ? Number(value) : null;
        return { code: benefit.code.trim(), quantity: numeric, rawValue: numeric === null ? value : null, rawUnit: benefit.unit?.trim() || null, normalizedValue: null, policyRef: null, metadata: {} };
      });
      await commercialOperationsClient.mutateCatalog({ action: "create", code: values.code.trim(), kind: values.kind, priceFen: yuanToFen(values.priceYuan), payload: { name: values.name.trim(), blockers: [] }, reason: editor ? "运营后台编辑套餐并创建新版本" : "运营后台新增套餐草稿", benefits });
      message.success(editor ? "已创建套餐新版本草稿" : "已创建套餐草稿");
      setEditor(false);
      await model.load();
    } catch (error) { message.error(error instanceof Error ? error.message : "套餐写入失败"); }
    finally { setBusy(false); }
  };
  const retire = async (row: CommercialCatalogItem) => {
    setBusy(true);
    try { await commercialOperationsClient.mutateCatalog({ action: "retire", code: row.skuCode, reason: "运营后台删除套餐（版本化停售）", benefits: [] }); message.success("已创建套餐停售版本"); await model.load(); }
    catch (error) { message.error(error instanceof Error ? error.message : "套餐下架失败"); }
    finally { setBusy(false); }
  };
  const confirmRetire = (row: CommercialCatalogItem) => {
    Modal.confirm({
      title: `确认删除 / 停售“${packageDisplayName(row.skuCode, row.name)}”？`,
      content: "停售后新用户不能再购买该套餐；历史订单、已授予权益和审计记录会继续保留。",
      okText: "确认停售",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => retire(row),
    });
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
        description="新增和编辑会创建新版本草稿；审批通过、发布生效与删除/停售都会追加不可变版本并写入审计事件，历史订单不会被破坏。"
        style={{ marginBottom: 16 }}
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索套餐名称、SKU、价格或权益" aria-label="搜索套餐目录" style={{ width: 320 }} />
        <Typography.Text type={catalogCount.type}>{catalogCount.label}</Typography.Text>
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
          { title: "套餐权益（中文）", width: 380, render: (_: unknown, row: CommercialCatalogItem) => <Space direction="vertical" size={2}>{readableBenefitItems(row).map((benefit) => <Typography.Text key={benefit} style={{ fontSize: 12 }}>• {benefit}</Typography.Text>)}</Space> },
          { title: "商业状态", dataIndex: "approvalState", width: 120, render: (_: string, row: CommercialCatalogItem) => <Tag color={row.executable ? "green" : row.approvalState === "approved" ? "blue" : "gold"}>{readableCatalogStatus(row)}</Tag> },
          { title: "操作", fixed: "right", width: 390, render: (_: unknown, row: CommercialCatalogItem) => <Space wrap><Button size="small" onClick={() => setSelected(row)}>查看权益</Button><Button size="small" disabled={!canWrite} onClick={() => openEditor(row)}>编辑新版本</Button>{row.approvalState === "draft" && <Button size="small" type="primary" disabled={!canPublish || busy} onClick={() => void transition(row, "approve")}>审批通过</Button>}{row.approvalState === "approved" && !row.executable && <Button size="small" type="primary" disabled={!canPublish || busy} onClick={() => void transition(row, "publish")}>发布生效</Button>}<Tooltip title="目录采用不可变版本，删除会生成停售版本并保留历史订单引用"><Button danger size="small" disabled={!canPublish || busy || readableCatalogStatus(row) === "已停售"} onClick={() => confirmRetire(row)}>删除 / 停售</Button></Tooltip></Space> },
        ]}
      /> : <Empty description={model.platformCommercialCatalog.length ? "没有匹配的套餐" : "服务端尚未返回套餐目录"} />}
      <Drawer title="套餐详情" open={Boolean(selected)} onClose={() => setSelected(null)} destroyOnHidden>
        {selected ? <Descriptions bordered size="small" column={1} items={[
          { key: "sku", label: "套餐 / SKU", children: <Space orientation="vertical" size={0}><Typography.Text strong>{packageDisplayName(selected.skuCode, selected.name)}</Typography.Text><Typography.Text code>{selected.skuCode}</Typography.Text></Space> },
          { key: "type", label: "售卖类型", children: selected.type },
          { key: "price", label: "价格 / 周期", children: `${selected.priceLabel} / ${selected.cycleLabel ?? "一次性"}` },
          { key: "benefits", label: "套餐权益（中文明细）", children: <Space direction="vertical" size={2}>{readableBenefitItems(selected).map((benefit) => <Typography.Text key={benefit}>• {benefit}</Typography.Text>)}</Space> },
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
          <Form.Item name="priceYuan" label="价格（元）" extra="按元输入，自动保留两位小数并转换为分提交" rules={[{ required: true, type: "number", min: 0 }]}><InputNumber min={0} precision={2} step={0.01} addonAfter="元" style={{ width: "100%" }} /></Form.Item>
          <Typography.Text strong>套餐权益（运营可读中文明细）</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>每行填写一项，例如：创意点 / 2000 / 点；共享存储 / 50 / GB。保存后会同步到套餐目录和用户购买权益。</Typography.Paragraph>
          <Alert type="info" showIcon style={{ marginBottom: 12 }} title="权益含义" description={<Space direction="vertical" size={2}>{commercialBenefitOptions.map((option) => <Typography.Text key={option.code} type="secondary" style={{ fontSize: 12 }}>{option.label}：{commercialBenefitDescriptions[option.code]}</Typography.Text>)}</Space>} />
          <Form.List name="benefits" rules={[{ validator: async (_, benefits: Array<{ code?: string }> = []) => {
            if (!benefits.length) throw new Error("请至少配置一项套餐权益");
            const codes = benefits.map((benefit) => benefit?.code).filter(Boolean);
            if (new Set(codes).size !== codes.length) throw new Error("同一项权益不能重复添加");
          } }] }>
            {(fields, { add, remove }, { errors }) => <Space direction="vertical" style={{ width: "100%" }}>
              {fields.map((field) => <Space key={field.key} align="baseline" style={{ width: "100%" }}>
                <Form.Item {...field} name={[field.name, "code"]} rules={[{ required: true, message: "请选择权益" }]}><Select placeholder="选择权益" style={{ width: 180 }} options={commercialBenefitOptions.map((option) => ({ value: option.code, label: option.label }))} onChange={(code: string) => form.setFieldValue(["benefits", field.name, "unit"], commercialBenefitOptions.find((option) => option.code === code)?.defaultUnit ?? "")} /></Form.Item>
                <Form.Item {...field} name={[field.name, "value"]} rules={[{ required: true, message: "请输入权益数值" }]}><Input placeholder="数值，如 2000" /></Form.Item>
                <Form.Item {...field} name={[field.name, "unit"]}><Input placeholder="单位，如 点 / GB / 月" /></Form.Item>
                <Button type="link" danger onClick={() => remove(field.name)}>移除</Button>
              </Space>)}
              <Form.ErrorList errors={errors} />
              <Button type="dashed" onClick={() => add({ unit: "" })} block>添加一项权益</Button>
            </Space>}
          </Form.List>
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
  const [showCommercialReadiness, setShowCommercialReadiness] = useState(false);
  useEffect(() => {
    // Platform sessions must not hydrate workspace-scoped recharge orders.
    // The API correctly rejects that request, but issuing it from the page
    // creates a misleading 403 in the platform walk and can mask real errors.
    if (isWorkspaceWorkbench && !canSearchFinance) void model.loadRechargeOrders();
  }, [canSearchFinance, isWorkspaceWorkbench]);
  return (
    <OpsPage
      title={isPlatformWorkbench ? "平台财务中心" : "账务与商业配置"}
      headingLevel={2}
      description={isPlatformWorkbench ? undefined : "处理企业主体商业准入、权益、创意点账本、版本化目录、支付、费率与服务履约。"}
      actions={isPlatformWorkbench ? (
        <Space wrap>
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
      nextStep={isPlatformWorkbench ? undefined : "先处理阻断与待对账事项；支付成功后仍需核验权益发放与新的访问版本。"}
    >
      <div className="ops-finance-page">
        {isPlatformWorkbench ? <>
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
