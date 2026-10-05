import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag } from "antd";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { commercialOperationsClient, type CommercialCatalogItem, type CommercialBenefitBundle, type CommercialCatalogManagementInput } from "../../api/commercialOperationsClient.js";
import { yuanToFen } from "../../utils/currency.js";

import { readableBenefitItems } from "./benefitLabels.js";
import { platformCatalogGovernanceTarget } from "./CommercialOperationsWorkspace.js";
import { approvalLabels, catalogPriceYuan, catalogProductRows, loadAllBenefitBundlePages, mergeBenefitBundleVersions, saleStateLabels, type CatalogProductRow } from "./catalogManagementModel.js";
import { BenefitBundleManagementPanel } from "./BenefitBundleManagementPanel.js";
import { encodeBenefits, RegisteredBenefitFields, type BenefitEditorValue } from "./RegisteredBenefitFields.js";
import "./catalogManagement.css";

type Action = Parameters<typeof commercialOperationsClient.mutateCatalog>[0]["action"];
type Tab = "plans" | "bundles" | "onboarding";
const kindsByTab: Record<Tab, NonNullable<CommercialCatalogManagementInput["kind"]>[]> = { plans: ["monthly", "private_trial"], bundles: ["point_pack"], onboarding: ["onboarding"] };
interface EditorValues { code: string; name: string; kind: string; visibility: string; priceYuan: number; cycleKind: string; cycleCount: number; validityDays?: number; purchasePolicyVersion?: string; purchaseExpiresInSeconds?: number; upgradeEnabled?: boolean; upgradePolicyVersion?: string; giftCount?: number; giftPoints?: number; onboardingPolicyVersion?: string; recoveryEnabled?: boolean; recoveryVersion?: string; recoveryEffect?: string; reason: string; blockers?: string; family?: string; tierRank?: number; bundleRefs?: string[]; benefits?: BenefitEditorValue[]; }
interface Confirmation { row: CatalogProductRow; version: CommercialCatalogItem; action: Action; key: string; }
const actionLabels: Partial<Record<Action, string>> = { approve: "审批通过", publish: "上架", retire: "下架", archive: "归档", create: "保存草稿", submit: "提交审批", reject: "拒绝审批", delete_draft: "删除草稿" };
const requestKey = () => `ops_catalog_${crypto.randomUUID()}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求结果未确认，请刷新原商品版本后核对；不要另建重复商品。";
export async function mutateCatalogAndStartRefresh(mutate: () => Promise<unknown>, refresh: () => void): Promise<void> {
  await mutate();
  refresh();
}

export function catalogPolicyPatch(payload: Record<string, unknown>, values: Pick<EditorValues, "kind" | "validityDays" | "giftCount" | "giftPoints" | "onboardingPolicyVersion" | "recoveryEnabled" | "recoveryVersion" | "recoveryEffect">) {
  if (values.recoveryEnabled && (!values.recoveryVersion?.trim() || !["cancel_contract", "unused_points_only"].includes(values.recoveryEffect ?? ""))) throw new Error("开启退款恢复须填写批准政策版本及恢复方式");
  if (values.recoveryEnabled && values.recoveryEffect === "unused_points_only" && values.kind !== "point_pack") throw new Error("仅退未消费点数只适用于独立点数包，合同退款须取消来源合同");
  const recovery = payload.sourceRecoveryPolicy as Record<string, unknown> | undefined;
  const sourceRecoveryPolicy = { ...recovery, approved: values.recoveryEnabled === true && Boolean(values.recoveryVersion?.trim()) && ["cancel_contract", "unused_points_only"].includes(values.recoveryEffect ?? ""), version: values.recoveryVersion?.trim() ?? "", effect: values.recoveryEffect ?? "" };
  if (values.kind === "point_pack") return { sourceRecoveryPolicy, expiryRule: values.validityDays === 30 ? "purchase_plus_30_natural_days" : null, expiryDays: values.validityDays ?? null };
  if (values.kind !== "onboarding") return { sourceRecoveryPolicy };
  if (!Number.isSafeInteger(values.giftCount) || values.giftCount! < 1 || values.giftCount! > 24 || !Number.isSafeInteger(values.giftPoints) || values.giftPoints! < 1) throw new Error("开通赠点须为1至24期，每期正整数创意点");
  const policyRef = values.onboardingPolicyVersion === "v2" ? { policyId: "commercial.onboarding", version: "v2", permission: "commercial.onboarding.purchase" } : payload.policyRef ?? null;
  return { sourceRecoveryPolicy, policyRef, grantSchedule: { ...(payload.grantSchedule as Record<string, unknown> ?? {}), policyRef, grantCount: values.giftCount, pointsPerGrant: values.giftPoints, cadence: "monthly", startsAt: "payment_verified", grantExpiresAtRule: "next_monthly_anniversary", schedulingStatus: "resolved", timezone: "UTC" } };
}
function giftSummary(item: CommercialCatalogItem) { const schedule = item.payload?.grantSchedule as Record<string, unknown> | undefined; return item.type === "onboarding" ? `开通费不含首期；赠点：${schedule?.grantCount ?? "待确认"}期，每期${schedule?.pointsPerGrant ?? "待确认"}点，按UTC月周年履约。` : null; }

export function PlatformCatalogManagementPanel({ model }: { model: OpsConsoleModel }) {
  const [tab, setTab] = useState<Tab>("plans");
  const [catalogItems, setCatalogItems] = useState<CommercialCatalogItem[]>(model.platformCommercialCatalog);
  const [catalogTotals, setCatalogTotals] = useState<Record<string, number>>({});
  const [nextCursors, setNextCursors] = useState<Record<string, string | null>>({});
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogReadReady, setCatalogReadReady] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [searchText, setSearchText] = useState("");
  const catalogRequest = useRef(0);
  const [definitions, setDefinitions] = useState<Record<string, unknown>[]>([]);
  const [definitionError, setDefinitionError] = useState("");
  const [bundles, setBundles] = useState<CommercialBenefitBundle[]>([]);
  const [bundlesLoading, setBundlesLoading] = useState(true);
  const [bundlesReady, setBundlesReady] = useState(false);
  const [bundlesError, setBundlesError] = useState("");
  const refreshBundleOptions = useCallback(async (signal?: AbortSignal) => {
    setBundlesLoading(true); setBundlesReady(false); setBundlesError("");
    try {
      const values = await loadAllBenefitBundlePages((input, requestSignal) => commercialOperationsClient.benefitBundles(input, requestSignal), signal);
      if (!signal?.aborted) { setBundles(values); setBundlesReady(true); }
    } catch (failure) {
      if (!signal?.aborted) setBundlesError(errorText(failure));
    } finally { if (!signal?.aborted) setBundlesLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void commercialOperationsClient.benefitDefinitions(controller.signal).then(setDefinitions).catch(failure => { if (!controller.signal.aborted) setDefinitionError(errorText(failure)); }); void refreshBundleOptions(controller.signal); return () => controller.abort(); }, [refreshBundleOptions]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [details, setDetails] = useState<CatalogProductRow>();
  const [editor, setEditor] = useState<{ row?: CatalogProductRow; source?: CommercialCatalogItem; key: string }>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form] = Form.useForm<EditorValues>();
  const resultRef = useRef<HTMLDivElement>(null);
  const readError = catalogError || (!catalogReadReady ? model.dataSetError("ops.commercial.catalog-v2.list") : undefined);
  const allRows = useMemo(() => catalogProductRows(catalogItems), [catalogItems]);
  const catalogComplete = !Object.values(nextCursors).some(Boolean);
  const rows = allRows.filter(row => tab === "onboarding" ? row.latest.type === "onboarding" : tab === "plans" ? ["monthly", "private_trial"].includes(row.latest.type) : !["monthly", "private_trial", "onboarding"].includes(row.latest.type));
  const canDraft = model.authorization.can("commercial.catalog.draft");
  const canApprove = model.authorization.can("commercial.catalog.approve");
  const canPublish = model.authorization.can("commercial.catalog.publish");
  const blocked = busy || Boolean(readError) || catalogLoading || !catalogReadReady || !catalogComplete;
  const loadCatalogPage = async (options: { tab: Tab; query: string; filter: string; append: boolean }) => {
    const request = ++catalogRequest.current;
    const kinds = kindsByTab[options.tab];
    const activeKinds = options.append ? kinds.filter(kind => nextCursors[kind]) : kinds;
    if (!activeKinds.length) return;
    setCatalogLoading(true); setCatalogError("");
    try {
      const pages = await Promise.all(activeKinds.map(async kind => {
        const page = await commercialOperationsClient.catalogManagement({
          limit: 100,
          kind,
          ...(options.append && nextCursors[kind] ? { cursor: nextCursors[kind]! } : {}),
          ...(options.filter !== "all" ? { saleState: options.filter as NonNullable<CommercialCatalogManagementInput["saleState"]> } : {}),
          ...(options.query.trim() ? { search: options.query.trim() } : {}),
        });
        return { kind, page };
      }));
      if (request !== catalogRequest.current) return;
      const cursorUpdates = options.append ? { ...nextCursors } : {};
      const totalUpdates = options.append ? { ...catalogTotals } : {};
      for (const { kind, page } of pages) { cursorUpdates[kind] = page.nextCursor ?? null; totalUpdates[kind] = page.total; }
      const fetched = pages.flatMap(({ page }) => page.items);
      setCatalogItems(current => {
        const base = options.append ? current : [];
        const byId = new Map(base.map(item => [item.id, item]));
        for (const item of fetched) byId.set(item.id, item);
        return [...byId.values()];
      });
      setNextCursors(cursorUpdates); setCatalogTotals(totalUpdates); setCatalogReadReady(true);
    } catch (failure) {
      if (request === catalogRequest.current) setCatalogError(errorText(failure));
    } finally {
      if (request === catalogRequest.current) setCatalogLoading(false);
    }
  };
  const resetCatalogQuery = (next: { tab: Tab; query: string; filter: string }) => {
    setCatalogItems([]); setCatalogTotals({}); setNextCursors({}); setCatalogReadReady(false);
    void loadCatalogPage({ ...next, append: false });
  };
  useEffect(() => { resetCatalogQuery({ tab: "plans", query: "", filter: "all" }); }, []);
  const refreshCatalog = () => resetCatalogQuery({ tab, query, filter });
  const openEditor = (row?: CatalogProductRow, source = row?.latest) => {
    setError(""); setNotice("");
    form.resetFields();
    const payload = source?.payload ?? {};
    const purchasePolicy = payload.purchasePolicy && typeof payload.purchasePolicy === "object" ? payload.purchasePolicy as Record<string, unknown> : {};
    const upgradePolicy = payload.upgradePolicy && typeof payload.upgradePolicy === "object" ? payload.upgradePolicy as Record<string, unknown> : {};
    const schedule = payload.grantSchedule as Record<string, unknown> | undefined;
    const recovery = payload.sourceRecoveryPolicy as Record<string, unknown> | undefined;
    const onboardingPolicy = payload.policyRef as Record<string, unknown> | undefined;
    const cycle = payload.cycle && typeof payload.cycle === "object" ? payload.cycle as Record<string, unknown> : {};
    form.setFieldsValue({ code: source?.skuCode ?? "", name: source?.name ?? "", kind: source?.type ?? (tab === "onboarding" ? "onboarding" : tab === "bundles" ? "point_pack" : "monthly"), visibility: source?.visibility ?? "public", priceYuan: source ? catalogPriceYuan(source) : 0, cycleKind: typeof cycle.unit === "string" ? cycle.unit : source?.type === "onboarding" || source?.type === "point_pack" || tab !== "plans" ? "once" : "month", cycleCount: typeof cycle.count === "number" ? cycle.count : 1, validityDays: source?.durationDays ?? undefined, purchasePolicyVersion: typeof purchasePolicy.version === "string" ? purchasePolicy.version : "", purchaseExpiresInSeconds: typeof purchasePolicy.expiresInSeconds === "number" ? purchasePolicy.expiresInSeconds : undefined, upgradeEnabled: upgradePolicy.approved === true, upgradePolicyVersion: typeof upgradePolicy.version === "string" ? upgradePolicy.version : "", family: typeof payload.planFamily === "string" ? payload.planFamily : "", tierRank: typeof payload.tierRank === "number" ? payload.tierRank : undefined, blockers: Array.isArray(payload.blockers) ? payload.blockers.join("\n") : source?.unresolved.join("\n") ?? "", bundleRefs: Array.isArray(payload.bundleRefs) ? payload.bundleRefs.map(ref => { const item = ref as Record<string, unknown>; return `${item.code}|${item.versionId}`; }) : [], giftCount: source ? typeof schedule?.grantCount === "number" ? schedule.grantCount : undefined : 6, giftPoints: source ? typeof schedule?.pointsPerGrant === "number" ? schedule.pointsPerGrant : undefined : 500, onboardingPolicyVersion: source ? typeof onboardingPolicy?.version === "string" ? onboardingPolicy.version : undefined : "v2", recoveryEnabled: recovery?.approved === true, recoveryVersion: typeof recovery?.version === "string" ? recovery.version : "", recoveryEffect: typeof recovery?.effect === "string" ? recovery.effect : "", reason: "", benefits: source?.benefits?.map(item => ({ code: item.code, value: item.code === "cloud_storage" && typeof item.normalizedValue === "number" ? item.normalizedValue : item.rawValue ?? String(item.quantity ?? ""), unit: item.code === "cloud_storage" && typeof item.normalizedValue === "number" ? "byte" : item.rawUnit ?? String(definitions.find(definition => definition.code === item.code)?.unit ?? ""), boundVersionId: typeof item.metadata?.bundleVersionId === "string" ? item.metadata.bundleVersionId : undefined, policyRef: typeof (item as unknown as Record<string, unknown>).policyRef === "string" ? String((item as unknown as Record<string, unknown>).policyRef) : "" })) ?? [] });
    setEditor({ row, source, key: requestKey() });
  };
  useEffect(() => { if (notice) resultRef.current?.focus(); }, [notice]);
  const save = async () => {
    if (!editor || blocked) return;
    let values: EditorValues;
    try { values = await form.validateFields(); } catch { return; }
    if (!bundlesReady && (values.bundleRefs?.length ?? 0) > 0) { setError("权益包目录未完整读取；不能保存含权益包绑定的套餐，请重试读取后再保存。"); return; }
    setBusy(true); setError("");
    try {
      const benefits = encodeBenefits(values.benefits, editor.source?.benefits ?? []);
      await mutateCatalogAndStartRefresh(() => commercialOperationsClient.mutateCatalog({ action: "create", code: values.code.trim(), kind: values.kind, visibility: values.visibility, versionId: editor.source?.id, expectedRevision: editor.row?.saleRevision ?? 0, idempotencyKey: editor.key, priceFen: yuanToFen(values.priceYuan), priceMode: "fixed", durationDays: values.kind === "point_pack" ? values.validityDays : values.cycleKind === "day" ? values.cycleCount : undefined, cycle: { unit: values.cycleKind, count: values.cycleKind === "once" ? 1 : values.cycleCount }, family: values.family || undefined, tierRank: values.tierRank, bundleRefs: (values.bundleRefs ?? []).map(ref => { const [code, versionId] = ref.split("|"); return { code, versionId }; }), payload: { ...(editor.source?.payload ?? {}), blockers: (values.blockers ?? "").split("\n").map(value => value.trim()).filter(Boolean), name: values.name.trim(), upgradePolicy: { ...(editor.source?.payload?.upgradePolicy as Record<string, unknown> ?? {}), approved: values.upgradeEnabled === true && Boolean(values.upgradePolicyVersion?.trim()), version: values.upgradePolicyVersion?.trim() ?? "" }, purchasePolicy: { ...(editor.source?.payload?.purchasePolicy as Record<string, unknown> ?? {}), version: values.purchasePolicyVersion || "", expiresInSeconds: values.purchaseExpiresInSeconds ?? null, approved: Boolean(values.purchasePolicyVersion?.trim() && values.purchaseExpiresInSeconds && values.purchaseExpiresInSeconds > 0) }, ...catalogPolicyPatch(editor.source?.payload ?? {}, values), cycle: { unit: values.cycleKind, count: values.cycleKind === "once" ? 1 : values.cycleCount }, planFamily: values.family || null, tierRank: values.tierRank ?? null }, benefits, reason: values.reason.trim() }), refreshCatalog);
      setEditor(undefined); setNotice("新版本草稿已保存。当前在售价格与历史合同不变；审批并上架后才用于新购买。");
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  const startAction = (row: CatalogProductRow, version: CommercialCatalogItem, action: Action) => {
    setError(""); setReason(""); setConfirmation({ row, version, action, key: requestKey() });
  };
  const execute = async () => {
    if (!confirmation || blocked || !reason.trim()) return;
    setBusy(true); setError("");
    try {
      await mutateCatalogAndStartRefresh(() => commercialOperationsClient.mutateCatalog({ action: confirmation.action, code: confirmation.row.code, versionId: confirmation.version.id, expectedRevision: confirmation.row.saleRevision ?? 0, idempotencyKey: confirmation.key, reason: reason.trim() }), refreshCatalog);
      setNotice(`${actionLabels[confirmation.action] ?? confirmation.action}已提交成功：${confirmation.version.name} ${confirmation.version.version}。历史订单及有效权益保留。`);
      setConfirmation(undefined);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  const versionActions = (row: CatalogProductRow, version: CommercialCatalogItem) => <Space wrap>
    <Button disabled={!canDraft || blocked || row.saleRevision === null || ["archived", "deleted"].includes(row.saleState)} onClick={() => openEditor(row, version)}>编辑新版本</Button>
    {version.approvalState === "pending_business_approval" && <Button disabled={!canApprove || blocked || row.saleRevision === null} onClick={() => startAction(row, version, "approve")}>审批通过</Button>}
    {version.approvalState === "draft" && <><Button disabled={!canDraft || blocked || row.saleRevision === null || ["archived", "deleted"].includes(row.saleState)} onClick={() => startAction(row, version, "submit")}>提交审批</Button><Button danger disabled={!canDraft || blocked || row.saleRevision === null || row.versions.some(item => item.approvalState === "approved" || item.executable)} onClick={() => startAction(row, version, "delete_draft")}>删除草稿</Button></>}
    {version.approvalState === "pending_business_approval" && <Button danger disabled={!canApprove || blocked || row.saleRevision === null} onClick={() => startAction(row, version, "reject")}>拒绝审批</Button>}
    {version.approvalState === "approved" && <Button disabled={!canPublish || blocked || row.saleRevision === null || row.saleState === "unknown" || ["archived", "deleted"].includes(row.saleState) || Boolean(version.unresolved.length)} onClick={() => startAction(row, version, "publish")}>上架此版本</Button>}
  </Space>;
  return <section id={platformCatalogGovernanceTarget.id} className="commercial-catalog-management" aria-labelledby="commercial-catalog-heading">
    <div className="commercial-catalog-heading"><div><h3 id="commercial-catalog-heading">商品目录</h3><p>价格按版本修改。当前在售、草稿审批与历史合同分别保留。</p></div><Space><Button disabled={busy || catalogLoading} onClick={refreshCatalog}>刷新目录</Button><Button type="primary" disabled={!canDraft || blocked} onClick={() => openEditor()}>新增{tab === "plans" ? "套餐" : tab === "onboarding" ? "开通费" : "权益包"}草稿</Button></Space></div>
    <Tabs activeKey={tab} onChange={key => { const nextTab = key as Tab; setTab(nextTab); resetCatalogQuery({ tab: nextTab, query, filter }); }} items={[{ key: "plans", label: "套餐管理" }, { key: "bundles", label: "权益包管理" }, { key: "onboarding", label: "开通费" }]} />
    {tab === "bundles" && <BenefitBundleManagementPanel model={model} definitions={definitions} definitionError={definitionError} onChange={items => setBundles(current => mergeBenefitBundleVersions(current, items))} />}
    {bundlesLoading && <Typography.Text role="status">正在读取完整权益包目录…</Typography.Text>}
    {bundlesError && <Alert type="error" showIcon title="权益包目录读取不完整" description={<>{bundlesError}<Button onClick={() => void refreshBundleOptions()}>重新读取全部权益包</Button></>} />}
    {tab === "bundles" && <h4>独立销售商品（价格与周期）</h4>}
    <div ref={resultRef} tabIndex={-1}>{notice && <Alert type="success" showIcon title={notice} role="status" />}</div>
    {readError && <Alert type="error" showIcon title="目录读取失败，旧数据可能已过期，不能据此变更商品" description={readError} action={<Button disabled={catalogLoading} onClick={refreshCatalog}>重试读取</Button>} role="alert" />}
    {error && <Alert type="error" showIcon title="操作未完成，请核对原商品状态" description={error} role="alert" />}
    <div className="commercial-catalog-toolbar"><Input.Search value={searchText} onChange={event => { setSearchText(event.target.value); if (!event.target.value) { setQuery(""); resetCatalogQuery({ tab, query: "", filter }); } }} onSearch={value => { setQuery(value); resetCatalogQuery({ tab, query: value, filter }); }} allowClear placeholder="搜索名称、编码或描述" aria-label="搜索商品目录" /><Select aria-label="销售状态筛选" value={filter} onChange={value => { setFilter(value); resetCatalogQuery({ tab, query, filter: value }); }} options={[{ value: "all", label: "全部销售状态" }, ...Object.entries(saleStateLabels).filter(([value]) => value !== "unknown").map(([value, label]) => ({ value, label }))]} /><span role="status">{readError ? "数量暂不可确认" : catalogLoading ? "正在读取目录" : `已载入 ${catalogItems.length} / ${Object.values(catalogTotals).reduce((sum, value) => sum + value, 0)} 个商品版本；当前 ${rows.length} 个商品`}</span></div>
    {!catalogComplete && <Alert type="info" showIcon title="目录仍在分页读取" description="商品多个价格版本可能分布在不同页；加载完当前搜索和筛选结果后才允许提交商品变更，避免基于不完整历史创建错误版本。" />}
    <Table<CatalogProductRow> rowKey="code" loading={catalogLoading} dataSource={rows} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 1180 }} locale={{ emptyText: readError ? "读取失败，不代表没有商品" : query || filter !== "all" ? <Empty description="没有匹配商品"><Button onClick={() => { setSearchText(""); setQuery(""); setFilter("all"); resetCatalogQuery({ tab, query: "", filter: "all" }); }}>清除筛选</Button></Empty> : <Empty description="尚无商品，可新增草稿；草稿不会自动对商家出售" /> }} columns={[
      { title: "商品", key: "name", fixed: "left", width: 210, render: (_, row) => <div><strong>{row.current?.name ?? row.latest.name}</strong><div>{row.code}</div><Button type="link" onClick={() => setDetails(row)}>查看详情与版本历史</Button></div> },
      { title: "当前在售价格 / 周期", key: "price", width: 190, align: "right", render: (_, row) => row.current ? <div className="commercial-catalog-money"><strong>{row.current.priceLabel}</strong><div>{row.current.cycleLabel ?? "周期待确认"}</div><div>{row.current.version}</div></div> : "无已确认在售版本" },
      { title: "销售状态", key: "sale", width: 150, render: (_, row) => <Tag color={row.saleState === "on_sale" ? "green" : undefined}>{saleStateLabels[row.saleState] ?? "销售状态未确认"}</Tag> },
      { title: "最新编辑版本", key: "draft", width: 230, render: (_, row) => <div><strong>{row.latest.version} · {approvalLabels[row.latest.approvalState] ?? row.latest.approvalState}</strong><p>{row.latest.priceLabel} / {row.latest.cycleLabel ?? "周期待确认"}</p>{versionActions(row, row.latest)}</div> },
      { title: "销售操作", key: "actions", fixed: "right", width: 300, render: (_, row) => <Space wrap><Button aria-label="下架" style={{ whiteSpace: "nowrap" }} disabled={!canPublish || blocked || !row.current} onClick={() => row.current && startAction(row, row.current, "retire")}>下架</Button><Button aria-label="归档" danger style={{ whiteSpace: "nowrap" }} disabled={!canPublish || blocked || row.saleRevision === null || row.saleState === "unknown" || row.saleState === "on_sale" || row.saleState === "archived"} onClick={() => startAction(row, row.latest, "archive")}>归档</Button></Space> },
    ]} />
    <Space aria-label="商品目录分页"><Button disabled={catalogLoading || busy || catalogComplete} onClick={() => void loadCatalogPage({ tab, query, filter, append: true })}>加载更多商品版本</Button><span role="status">{catalogComplete ? "当前筛选结果已全部载入" : "仍有服务器游标可继续读取"}</span></Space>
    {allRows.some(row => row.saleState === "unknown") && <Alert type="warning" title="部分商品销售状态未确认" description="缺少当前销售投影时仅展示版本记录；不会根据历史批准或可执行字段推断上架。刷新或请管理员核对迁移。" />}
    <Drawer title="商品详情与版本历史" open={Boolean(details)} onClose={() => setDetails(undefined)} size={780} className="commercial-catalog-dialog" destroyOnHidden>{details && <><Descriptions column={1} bordered items={[{ key: "code", label: "商品编码", children: details.code }, { key: "sale", label: "当前销售", children: saleStateLabels[details.saleState] ?? "未确认" }, { key: "current", label: "在售版本", children: details.current?.version ?? "无已确认在售版本" }]} />{details.versions.map(version => <section key={version.id} className="commercial-catalog-version"><h4>{version.name} · {version.version} · {approvalLabels[version.approvalState] ?? version.approvalState}</h4><p>{version.priceLabel} / {version.cycleLabel ?? "周期待确认"} · {version.visibility === "private" ? "限定可见" : "公开"}</p><p>{giftSummary(version)}</p><ul>{readableBenefitItems(version).map(benefit => <li key={benefit}>{benefit}</li>)}</ul>{version.unresolved.length > 0 && <Alert type="warning" title="发布阻断项" description={version.unresolved.join("；")} />}{versionActions(details, version)}</section>)}</>}</Drawer>
    <Modal title="确认商品变更" open={Boolean(confirmation)} onCancel={() => { if (!busy) setConfirmation(undefined); }} footer={<Space><Button autoFocus disabled={busy} onClick={() => setConfirmation(undefined)}>取消</Button><Button type="primary" danger={confirmation?.action === "retire" || confirmation?.action === "archive"} disabled={!reason.trim() || blocked} loading={busy} onClick={() => void execute()}>确认{confirmation ? actionLabels[confirmation.action] ?? confirmation.action : ""}</Button></Space>} className="commercial-catalog-dialog" destroyOnHidden>{confirmation && <><Descriptions column={1} items={[{ key: "product", label: "商品 / 版本", children: `${confirmation.version.name} ${confirmation.version.version}` }, { key: "price", label: "该版本价格 / 周期", children: `${confirmation.version.priceLabel} / ${confirmation.version.cycleLabel ?? "未确认"}` }, { key: "previous", label: "当前在售金额 / 周期", children: confirmation.row.current ? `${confirmation.row.current.priceLabel} / ${confirmation.row.current.cycleLabel ?? "待确认"}` : "无当前在售" }, { key: "sale", label: "当前销售版本", children: confirmation.row.current?.version ?? "未上架" }]} /><h4>本次版本权益</h4><p>{giftSummary(confirmation.version)}</p><ul>{readableBenefitItems(confirmation.version).map(item => <li key={item}>{item}</li>)}</ul><p>发布将使用该版本的价格、周期、政策及包引用；当前在售版本和新版本的差异须核实后再确认。</p><Alert type="info" title={confirmation.action === "publish" ? "上架切换新购版本，并产生商品通知；有效旧订单仍按原快照履约。" : "本次操作保留历史合同与客户已购权益。"} /><label htmlFor="catalog-action-reason">操作原因</label><Input.TextArea id="catalog-action-reason" value={reason} onChange={event => setReason(event.target.value)} rows={3} />{error && <Alert type="error" title={error} role="alert" />}</>}</Modal>
    <Modal title={editor?.source ? "编辑新版本草稿" : "新增商品草稿"} open={Boolean(editor)} onCancel={() => { if (!busy) setEditor(undefined); }} onOk={() => void save()} okText="保存草稿" confirmLoading={busy} width={800} className="commercial-catalog-dialog" destroyOnHidden><Form form={form} layout="vertical">
      <h4>基本资料</h4><Form.Item name="code" label="商品编码（创建后固定）" rules={[{ required: true, pattern: /^[a-z0-9_-]+$/u, message: "使用小写字母、数字、下划线或短横线" }]}><Input disabled={Boolean(editor?.source)} /></Form.Item><Form.Item name="name" label="商品名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="kind" label="商品类别（创建后固定）" rules={[{ required: true }]}><Select disabled={Boolean(editor?.source)} options={[{ value: "monthly", label: "正式订阅套餐" }, { value: "point_pack", label: "独立创意点包" }, { value: "onboarding", label: "一次性开通费" }]} /></Form.Item><Form.Item name="visibility" label="商品可见范围"><Select disabled={Boolean(editor?.source)} options={[{ value: "public", label: "公开（仍需资格校验）" }, { value: "private", label: "限定客户（服务端授权）" }]} /></Form.Item>
      <h4>价格与周期</h4><Form.Item name="priceYuan" label="人民币价格（元）" extra="零价可保存草稿，付费商品须批准正价格后发布；不改历史订单。" rules={[{ required: true, type: "number", min: 0 }]}><InputNumber min={0} precision={2} style={{ width: "100%" }} /></Form.Item><Form.Item name="cycleKind" label="购买周期类型"><Select options={[{ value: "once", label: "一次性" }, { value: "month", label: "自然月（UTC周年、月末截断）" }, { value: "day", label: "固定天数" }]} /></Form.Item><Form.Item name="cycleCount" label="周期数量（月数或天数）" rules={[{ required: true, type: "integer", min: 1 }]}><InputNumber min={1} precision={0} /></Form.Item><Form.Item noStyle shouldUpdate={(previous, next) => previous.kind !== next.kind}>{({ getFieldValue }) => getFieldValue("kind") === "point_pack" ? <Form.Item name="validityDays" label="点数包权益有效期（天，独立于购买周期）" extra="按批准政策填写；当前消费器仅支持30天到期，其他规则保持发布阻断。" rules={[{ required: true, type: "integer", min: 1 }]}><InputNumber min={1} precision={0} /></Form.Item> : null}</Form.Item><Form.Item name="family" label="套餐系列（创建后身份固定）"><Input disabled={Boolean(editor?.source?.payload?.planFamily)} /></Form.Item><Form.Item name="tierRank" label="系列内等级（基础1、成长2、尊享3）"><InputNumber disabled={Boolean(editor?.source?.payload?.tierRank)} min={1} precision={0} /></Form.Item>
      <h4>订单有效期政策</h4><Form.Item name="purchasePolicyVersion" label="已核实政策版本引用" extra="填写已核实的批准政策；草稿须经独立审批，不自动生成批准记录。"><Input /></Form.Item><Form.Item name="purchaseExpiresInSeconds" label="成功到账窗口（秒）" extra="由批准政策决定，不默认猜测；缺失时不能发布。"><InputNumber min={1} precision={0} /></Form.Item><Form.Item noStyle shouldUpdate={(previous, next) => previous.kind !== next.kind || previous.giftCount !== next.giftCount || previous.giftPoints !== next.giftPoints}>{({ getFieldValue }) => getFieldValue("kind") === "onboarding" ? <><h4>开通赠点政策</h4><Form.Item name="onboardingPolicyVersion" label="注册开通政策版本" extra="仅配置已注册的 commercial.onboarding v2；仍需商品审批和服务端发布校验。"><Select options={[{ value: "v2", label: "commercial.onboarding · v2" }]} /></Form.Item><Form.Item name="giftCount" label="赠点发放期数" rules={[{ required: true, type: "integer", min: 1, max: 24 }]}><InputNumber min={1} max={24} precision={0} /></Form.Item><Form.Item name="giftPoints" label="每期赠送创意点" rules={[{ required: true, type: "integer", min: 1, max: Number.MAX_SAFE_INTEGER }]}><InputNumber min={1} max={Number.MAX_SAFE_INTEGER} precision={0} /></Form.Item><Alert type="info" title={`开通费不含首期费；当前草稿赠点为${getFieldValue("giftCount") ?? "待确认"}期，每期${getFieldValue("giftPoints") ?? "待确认"}点`} description="核验发首笔，其余按UTC月周年发放，每笔下个周年到期。仅修改价格会保留原赠点；赠点修改只影响新版本。" /></> : null}</Form.Item><h4>升级权益政策</h4><Form.Item name="upgradeEnabled" valuePropName="checked"><Checkbox>该版本已核实升级政策，支持按剩余有效期补差</Checkbox></Form.Item><Form.Item name="upgradePolicyVersion" label="升级政策版本引用" extra="须指向已批准规则；缺失或未开启则禁止升级报价。这里只保存草稿配置，仍须独立审批、上架及服务端校验。"><Input /></Form.Item><h4>退款来源恢复政策</h4><Form.Item name="recoveryEnabled" valuePropName="checked"><Checkbox>该版本已核实退款来源恢复政策</Checkbox></Form.Item><Form.Item name="recoveryVersion" label="退款恢复政策版本引用"><Input /></Form.Item><Form.Item name="recoveryEffect" label="退款时的来源恢复方式"><Select options={[{ value: "cancel_contract", label: "整单退款取消来源合同（部分金额受控阻断）" }, { value: "unused_points_only", label: "仅退未消费点数（只适用于点数包）" }]} /></Form.Item><Alert type="info" title="未配置批准政策时，已履约退款会受控阻断" description="配置只保存草稿；对应目录审批后固化到新订单，退款仍核对来源、消费和政策版本，不承诺自动退款。" /><h4>权益配置</h4><Alert type="info" title="草稿不授予权限" description="权益必须由服务端注册且有消费器；未知项目、周期或政策只可保存草稿，不可直接上架。开通赠点与套餐点数分别履约。" /><RegisteredBenefitFields definitions={definitions} error={definitionError} /><Form.Item name="bundleRefs" label="绑定已批准权益包版本（旧版本不自动升级）"><Select mode="multiple" options={bundles.filter(bundle => bundle.lifecycle === "approved" && bundle.state === "active").map(bundle => ({ value: `${bundle.code}|${bundle.versionId}`, label: `${bundle.name} v${bundle.version} · ${bundle.usage === "included" ? "套餐内含" : "独立销售"}` }))} /></Form.Item><h4>变更预览与政策阻断</h4><p>当前在售：{editor?.row?.current ? `${editor.row.current.priceLabel} / ${editor.row.current.cycleLabel ?? "周期待确认"}` : "未确认在售版本"}。本表仅保存新草稿，审批和上架分别执行；仅调价保留赠点设置；赠点修改只进入新版本，历史订单不改价或改赠点。</p><Form.Item name="blockers" label="未决政策阻断项（每行一项）" extra="原阻断项保留；只有已核实批准政策才可在新草稿中解除，仍须重新审批和消费器校验。"><Input.TextArea rows={3} /></Form.Item><Form.Item name="reason" label="变更原因" rules={[{ required: true, min: 3 }]}><Input.TextArea rows={3} /></Form.Item>{error && <Alert type="error" showIcon title={error} role="alert" />}
    </Form></Modal>
  </section>;
}
