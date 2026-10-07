import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, Input, Select, Space, Table, Typography, Upload } from "antd";
import { DownloadOutlined, UploadOutlined } from "@ant-design/icons";
import { importManualProducts } from "../../api/manualProductImportClient.js";
import { rpcForWorkspace } from "../../api/opsClient.js";
import type { WorkspaceSummary } from "../../types/ops.js";
import { productImportTemplate } from "./ProductSpreadsheetImport.js";
import { emptyManualProductImportDraft, manualProductStoreSelection, parseManualProductFile, scopeManualProductsToStore } from "./manualProductFile.js";

type ManualStore = { platform: string; account_id: string; store_alias: string | null };
export function PlatformManualProductImport({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [stores, setStores] = useState<ManualStore[]>([]);
  const [storeKey, setStoreKey] = useState("");
  const [draft, setDraft] = useState(emptyManualProductImportDraft);
  const [busy, setBusy] = useState(false);
  const [loadingStores, setLoadingStores] = useState(false);
  const [storeError, setStoreError] = useState("");
  const { products, sha256, fileName, sourceRef, reason, assignmentConfirmed, error, success } = draft;
  const storeRequest = useRef(0);
  const loadStores = useCallback(async (targetWorkspaceId: string) => {
    if (!targetWorkspaceId) return;
    const requestId = ++storeRequest.current;
    setLoadingStores(true); setStoreError(""); setStores([]); setStoreKey("");
    try {
      const value = await rpcForWorkspace<{ items: ManualStore[] }>(targetWorkspaceId, "ops.platform.manual-stores.list", { workspace_id: targetWorkspaceId });
      if (requestId === storeRequest.current) setStores(value?.items ?? []);
    } catch (cause) {
      if (requestId === storeRequest.current) setStoreError(cause instanceof Error ? cause.message : "读取人工店铺失败");
    } finally {
      if (requestId === storeRequest.current) setLoadingStores(false);
    }
  }, []);
  useEffect(() => {
    storeRequest.current += 1;
    setStores([]); setStoreKey(""); setDraft(emptyManualProductImportDraft());
    if (workspaceId) void loadStores(workspaceId);
    return () => { storeRequest.current += 1; };
  }, [workspaceId, loadStores]);
  const chosen = stores.find(store => `${store.platform}:${store.account_id}` === storeKey);
  const scoped = chosen ? scopeManualProductsToStore(products, chosen) : null;
  const upload = async (file: File) => {
    setBusy(true); setDraft(emptyManualProductImportDraft());
    try {
      const parsed = await parseManualProductFile(file);
      if (JSON.stringify(parsed.products).length > 33000) throw new Error("商品数据超过单次导入大小，请拆分表格");
      setDraft(current => ({ ...current, products: parsed.products, sha256: parsed.sha256, fileName: file.name }));
    } catch (cause) { setDraft(current => ({ ...current, error: cause instanceof Error ? cause.message : "解析表格失败" })); }
    finally { setBusy(false); }
    return false;
  };
  const mismatchedCount = scoped?.mismatchedCount ?? 0;
  const assetRefs = products.some(product => product.asset_ids !== undefined || product.source_asset_id !== undefined
    || Array.isArray(product.skus) && product.skus.some(sku => sku && typeof sku === "object" && "sourceAssetIds" in sku));
  const commit = async () => {
    if (!workspaceId || !chosen || !scoped?.products.length || !sha256 || !sourceRef.trim() || !reason.trim() || mismatchedCount || assetRefs || (scoped.confirmationCount > 0 && !assignmentConfirmed) || busy) return;
    setBusy(true); setDraft(current => ({ ...current, error: "", success: "" }));
    try {
      const result = await importManualProducts({
        workspaceId, platform: chosen.platform, accountId: chosen.account_id, products: scoped.products,
        sourceRef, sourceSha256: sha256, reason, mismatchedCount, confirmationCount: scoped.confirmationCount,
        assignmentConfirmed, containsAssetRefs: assetRefs,
      });
      setDraft(current => ({ ...current, success: `已导入 ${result.count} 个商品到所选商家店铺，商品事实待商家核对。` }));
    } catch (cause) { setDraft(current => ({ ...current, error: cause instanceof Error ? cause.message : "导入失败" })); }
    finally { setBusy(false); }
  };
  return <Card title="运营代商家上传店铺商品">
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph>选择商家和人工登记的店铺，上传商家提供的商品表格。先核对预览，再记录资料来源和操作原因。导入后商家可在商品库查看，商品事实仍需确认。</Typography.Paragraph>
      <Select showSearch optionFilterProp="label" placeholder="选择商家工作区" value={workspaceId || undefined} disabled={busy} onChange={setWorkspaceId} options={workspaces.map(item => ({ value: item.workspaceId, label: `${item.enterpriseName || item.workspaceId} · ${item.workspaceId}` }))} style={{ width: "100%" }} />
      {workspaceId && <Select loading={loadingStores} placeholder="选择已登记的人工店铺" value={storeKey || undefined} disabled={busy} onChange={value => { const selection = manualProductStoreSelection(value); setStoreKey(selection.storeKey); setDraft(selection.draft); }} options={stores.map(item => ({ value: `${item.platform}:${item.account_id}`, label: `${item.store_alias || item.account_id} · ${item.platform}` }))} style={{ width: "100%" }} />}
      {workspaceId && <Space wrap><Button size="small" loading={loadingStores} onClick={() => void loadStores(workspaceId)}>刷新店铺列表</Button><Typography.Text type="secondary">仅显示当前所选商家工作区的人工登记店铺。</Typography.Text></Space>}
      {storeError && <Alert type="error" showIcon title="读取人工店铺失败" description={`${storeError}。请确认平台运营权限、当前部署已启用人工店铺运营，并检查所选商家工作区。`} />}
      {workspaceId && !loadingStores && !storeError && !stores.length && <Alert type="warning" showIcon title="该商家工作区暂无可导入的人工登记店铺" description="列表只包含当前工作区、状态为“人工登记（未授权）”的店铺。请核对登记时选择的商家工作区；登记后点“刷新店铺列表”。" />}
      <Space wrap><Button icon={<DownloadOutlined />} onClick={async () => { const blob = await productImportTemplate(); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "商品-SKU导入模板.xlsx"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>下载模板</Button>
        <Upload accept=".xlsx,.csv" showUploadList={false} beforeUpload={upload} disabled={!chosen || busy}><Button icon={<UploadOutlined />} loading={busy} disabled={!chosen || busy}>上传 Excel / CSV</Button></Upload></Space>
      {fileName && <Typography.Text>当前文件：{fileName}</Typography.Text>}
      {products.length > 0 && <><Typography.Text>预览：{products.length} 个商品</Typography.Text>
        <Table size="small" rowKey={(_, index) => String(index)} dataSource={scoped?.products ?? products} pagination={{ pageSize: 10 }} columns={[{ title: "商品名称", dataIndex: "title" }, { title: "货号", dataIndex: "local_product_key" }, { title: "平台", dataIndex: "platform" }, { title: "店铺账号", dataIndex: "account_id" }, { title: "价格", dataIndex: "price" }, { title: "库存", dataIndex: "stock" }]} />
        {!!scoped?.assignedCount && <Alert type="warning" title={`${scoped.assignedCount} 个商品的表格缺少平台或店铺账号；预览已按所选店铺补齐。`} />}
        {!!scoped?.confirmationCount && <><Alert type="warning" title={`${scoped.confirmationCount} 个商品无法仅凭原表格与已登记店铺自动核实归属；请核对文件来源和真实店铺。`} /><Checkbox checked={assignmentConfirmed} onChange={event => setDraft(current => ({ ...current, assignmentConfirmed: event.target.checked }))}>我已核对原始资料，确认这些商品属于所选店铺</Checkbox></>}
        {!!mismatchedCount && <Alert type="error" title={`${mismatchedCount} 个商品的平台、店铺账号或店铺名称与所选店铺不一致，请修正表格。`} />}
        {assetRefs && <Alert type="error" title="运营代传表格暂不支持素材 ID，请删除这些列的数据后重传。" />}
        <Input value={sourceRef} onChange={event => setDraft(current => ({ ...current, sourceRef: event.target.value }))} maxLength={1000} placeholder="资料来源，例如商家提供的文件编号或公开链接" />
        <Input.TextArea value={reason} onChange={event => setDraft(current => ({ ...current, reason: event.target.value }))} maxLength={1000} rows={2} placeholder="填写本次代商家上传的原因" />
        <Button type="primary" loading={busy} disabled={!!success || !!mismatchedCount || assetRefs || !!scoped?.confirmationCount && !assignmentConfirmed || !sourceRef.trim() || !reason.trim()} onClick={() => void commit()}>{success ? "已导入" : "确认预览并导入所选商家店铺"}</Button></>}
      {error && <Alert type="error" title={error} />}{success && <Alert type="success" title={success} />}
    </Space>
  </Card>;
}
