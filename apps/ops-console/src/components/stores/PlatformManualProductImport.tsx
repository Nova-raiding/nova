import { useEffect, useState } from "react";
import { Alert, Button, Card, Input, Select, Space, Table, Typography, Upload } from "antd";
import { DownloadOutlined, UploadOutlined } from "@ant-design/icons";
import { rpcForWorkspace } from "../../api/opsClient.js";
import type { WorkspaceSummary } from "../../types/ops.js";
import { productImportTemplate } from "./ProductSpreadsheetImport.js";
import { parseManualProductFile } from "./manualProductFile.js";

type ManualStore = { platform: string; account_id: string; store_alias: string | null };
type Product = Record<string, unknown>;

export function PlatformManualProductImport({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [stores, setStores] = useState<ManualStore[]>([]);
  const [storeKey, setStoreKey] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [sha256, setSha256] = useState("");
  const [fileName, setFileName] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  useEffect(() => {
    let cancelled = false;
    setStores([]); setStoreKey(""); setProducts([]); setSha256(""); setFileName(""); setError(""); setSuccess("");
    if (workspaceId) void rpcForWorkspace<{ items: ManualStore[] }>(workspaceId, "ops.platform.manual-stores.list", { workspace_id: workspaceId })
      .then(value => { if (!cancelled) setStores(value?.items ?? []); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "读取人工店铺失败"); });
    return () => { cancelled = true; };
  }, [workspaceId]);
  const chosen = stores.find(store => `${store.platform}:${store.account_id}` === storeKey);
  const upload = async (file: File) => {
    setBusy(true); setError(""); setSuccess(""); setProducts([]); setSha256("");
    try {
      const parsed = await parseManualProductFile(file);
      if (JSON.stringify(parsed.products).length > 33000) throw new Error("商品数据超过单次导入大小，请拆分表格");
      setProducts(parsed.products); setSha256(parsed.sha256); setFileName(file.name);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "解析表格失败"); }
    finally { setBusy(false); }
    return false;
  };
  const mismatched = products.filter(product => chosen && (product.platform !== chosen.platform || product.account_id !== chosen.account_id));
  const assetRefs = products.some(product => product.asset_ids !== undefined || product.source_asset_id !== undefined
    || Array.isArray(product.skus) && product.skus.some(sku => sku && typeof sku === "object" && "sourceAssetIds" in sku));
  const commit = async () => {
    if (!workspaceId || !chosen || !products.length || !sha256 || !sourceRef.trim() || !reason.trim() || mismatched.length || assetRefs || busy) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const response = await rpcForWorkspace<{ result: { count: number; products: Array<{ id: string }> } }>(workspaceId, "ops.platform.product.import.batch", {
        workspace_id: workspaceId, platform: chosen.platform, account_id: chosen.account_id,
        products_json: JSON.stringify(products), source_ref: sourceRef.trim(), source_sha256: sha256, reason: reason.trim(),
      }, { timeoutMs: 120_000 });
      if (response?.result?.count !== products.length || response.result.products?.length !== products.length) throw new Error("服务端未确认完整导入，请先查询商品记录，不要重复提交");
      setSuccess(`已导入 ${response.result.count} 个商品到所选商家店铺，商品事实待商家核对。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "导入失败"); }
    finally { setBusy(false); }
  };
  return <Card title="运营代商家上传店铺商品">
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph>选择商家和人工登记的店铺，上传商家提供的商品表格。先核对预览，再记录资料来源和操作原因。导入后商家可在商品库查看，商品事实仍需确认。</Typography.Paragraph>
      <Select showSearch optionFilterProp="label" placeholder="选择商家工作区" value={workspaceId || undefined} onChange={setWorkspaceId} options={workspaces.map(item => ({ value: item.workspaceId, label: `${item.enterpriseName || item.workspaceId} · ${item.workspaceId}` }))} style={{ width: "100%" }} />
      {workspaceId && <Select placeholder="选择已登记的人工店铺" value={storeKey || undefined} onChange={value => { setStoreKey(value); setSuccess(""); }} options={stores.map(item => ({ value: `${item.platform}:${item.account_id}`, label: `${item.store_alias || item.account_id} · ${item.platform}` }))} style={{ width: "100%" }} />}
      {workspaceId && !stores.length && <Alert type="warning" title="这个商家工作区没有人工登记的店铺，请先在上方登记。" />}
      <Space wrap><Button icon={<DownloadOutlined />} onClick={async () => { const blob = await productImportTemplate(); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "商品-SKU导入模板.xlsx"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>下载模板</Button>
        <Upload accept=".xlsx,.csv" showUploadList={false} beforeUpload={upload} disabled={!chosen || busy}><Button icon={<UploadOutlined />} loading={busy} disabled={!chosen || busy}>上传 Excel / CSV</Button></Upload></Space>
      {fileName && <Typography.Text>当前文件：{fileName}</Typography.Text>}
      {products.length > 0 && <><Typography.Text>预览：{products.length} 个商品</Typography.Text>
        <Table size="small" rowKey={(_, index) => String(index)} dataSource={products} pagination={{ pageSize: 10 }} columns={[{ title: "商品名称", dataIndex: "title" }, { title: "货号", dataIndex: "local_product_key" }, { title: "平台", dataIndex: "platform" }, { title: "店铺账号", dataIndex: "account_id" }, { title: "价格", dataIndex: "price" }, { title: "库存", dataIndex: "stock" }]} />
        {!!mismatched.length && <Alert type="error" title={`${mismatched.length} 个商品的平台或店铺账号与所选店铺不一致，请修正表格。`} />}
        {assetRefs && <Alert type="error" title="运营代传表格暂不支持素材 ID，请删除这些列的数据后重传。" />}
        <Input value={sourceRef} onChange={event => setSourceRef(event.target.value)} maxLength={1000} placeholder="资料来源，例如商家提供的文件编号或公开链接" />
        <Input.TextArea value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} rows={2} placeholder="填写本次代商家上传的原因" />
        <Button type="primary" loading={busy} disabled={!!success || !!mismatched.length || assetRefs || !sourceRef.trim() || !reason.trim()} onClick={() => void commit()}>{success ? "已导入" : "确认预览并导入所选商家店铺"}</Button></>}
      {error && <Alert type="error" title={error} />}{success && <Alert type="success" title={success} />}
    </Space>
  </Card>;
}
