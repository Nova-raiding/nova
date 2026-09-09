import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Space, Table, Typography, Upload } from "antd";
import { UploadOutlined, DownloadOutlined } from "@ant-design/icons";
import JSZip from "jszip";
import { rpc } from "../../api/opsClient.js";
import { spreadsheetFactsToBatchProducts } from "../../../../../packages/application/src/spreadsheet-batch.js";

type Asset = { id: string; scanStatus?: string; parseStatus?: string; extractedFacts?: Record<string, unknown> };
type Product = Record<string, unknown> & { skus?: Array<{ id: string; name: string; price: number; stock: number; attributes?: Record<string, string>; images?: string[]; sourceAssetIds?: string[] }> };
const templateRows = [
  ["平台", "商品货号", "商品名称", "类目", "SKU编码", "SKU名称", "颜色", "尺码", "SKU价格", "SKU库存", "SKU图片链接", "SKU原图素材ID", "素材ID", "店铺账号"],
  ["jd", "JACKET-001", "女士防风冲锋衣", "服装", "JACKET-BLUE-M", "浅蓝色 M码", "浅蓝色", "M", "199", "20", "", "", "", ""],
  ["jd", "JACKET-001", "女士防风冲锋衣", "服装", "JACKET-BLUE-L", "浅蓝色 L码", "浅蓝色", "L", "199", "15", "", "", "", ""],
];
export async function productImportTemplate(): Promise<Blob> {
  const zip = new JSZip();
  const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="商品与SKU" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file("xl/worksheets/sheet1.xml", '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + templateRows.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join("")}</row>`).join("") + '</sheetData></worksheet>');
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function ProductSpreadsheetImport({ workspaceId, canWrite, platformScope }: { workspaceId?: string; canWrite: boolean; platformScope: boolean }) {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [assetId, setAssetId] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileFingerprint, setFileFingerprint] = useState("");
  const [facts, setFacts] = useState<Record<string, unknown>>();
  const [products, setProducts] = useState<Product[]>([]);
  const [imported, setImported] = useState<string[]>([]);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current += 1;
    setAssetId(""); setFileName(""); setFileFingerprint(""); setFacts(undefined); setProducts([]); setImported([]); setError(""); setPhase("");
    return () => { epoch.current += 1; };
  }, [workspaceId]);
  const enabled = Boolean(!platformScope && workspaceId && canWrite);
  const inspect = async (id: string, run: number) => {
    setPhase("正在自动检查文件，通过后解析商品和 SKU…");
    for (let i = 0; i < 40; i += 1) {
      if (run !== epoch.current) return;
      const listing = await rpc<{ assets: Asset[] }>("asset.list");
      const asset = listing?.assets.find(item => item.id === id);
      if (asset?.scanStatus === "blocked") throw new Error("文件未通过安全检查，请检查文件内容后重新上传。");
      if (asset?.scanStatus === "clean") {
        setPhase("正在解析表格…");
        await rpc("asset.parse", { asset_id: id }, { timeoutMs: 120_000 });
        const parsed = (await rpc<{ assets: Asset[] }>("asset.list"))?.assets.find(item => item.id === id);
        if (!parsed?.extractedFacts || parsed.parseStatus !== "succeeded") throw new Error("表格解析尚未完成，请点击继续检查。");
        const preview = spreadsheetFactsToBatchProducts(parsed.extractedFacts) as Product[];
        if (run !== epoch.current) return;
        setFacts(parsed.extractedFacts); setProducts(preview); setPhase("请核对下方商品和 SKU，确认后导入当前客户工作区。"); return;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error("文件仍在自动检查中，已保留上传文件。稍后点击继续检查，无需重复上传。");
  };
  const runInspect = async (id: string) => {
    setBusy(true); setError(""); const run = epoch.current;
    try { await inspect(id, run); } catch (e) { if (run === epoch.current) setError(e instanceof Error ? e.message : "检查失败"); }
    finally { if (run === epoch.current) setBusy(false); }
  };
  const upload = async (file: File) => {
    if (!enabled) return false;
    if (!/\.(xlsx|csv)$/i.test(file.name) || file.size > 10 * 1024 * 1024) { setError("请选择不超过 10MB 的 .xlsx 或 .csv 文件；旧版 .xls 请另存为 .xlsx。"); return false; }
    const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
    if (assetId && fingerprint === fileFingerprint && !imported.length) {
      setError("");
      setPhase("已找到同名上传文件，继续检查现有文件，无需重复上传…");
      await runInspect(assetId);
      return false;
    }
    const run = ++epoch.current; setBusy(true); setError(""); setProducts([]); setFacts(undefined); setImported([]); setAssetId(""); setFileName(file.name); setFileFingerprint(fingerprint); setPhase("正在上传表格…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = ""; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      const asset = await rpc<Asset>("asset.upload", { name: file.name, mime_type: file.name.toLowerCase().endsWith(".csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content_base64: btoa(binary) }, { timeoutMs: 120_000 });
      if (!asset?.id) throw new Error("上传未返回文件编号，尚未导入商品。");
      if (run !== epoch.current) return false;
      setAssetId(asset.id); await inspect(asset.id, run);
    } catch (e) { if (run === epoch.current) setError(e instanceof Error ? e.message : "上传失败"); }
    finally { if (run === epoch.current) setBusy(false); }
    return false;
  };
  const commit = async () => {
    if (!enabled || !facts || !assetId || !products.length || busy) return;
    const run = epoch.current; setBusy(true); setError(""); setPhase("正在导入商品和 SKU…");
    try {
      await rpc("asset.facts.confirm", { asset_id: assetId, facts_json: JSON.stringify(facts), reason: "运营核对 Excel 商品与 SKU 预览后确认导入" });
      const result = await rpc<{ products: Array<{ id: string }> }>("catalog.import.batch", { source_asset_id: assetId }, { timeoutMs: 120_000 });
      if (!result?.products?.length) throw new Error("服务端未返回导入结果，请查询商品后再重试。");
      if (run !== epoch.current) return;
      setImported(result.products.map(item => item.id)); setPhase(`已导入 ${result.products.length} 个商品。同一客户的插件可查询这些商品及 SKU，商品事实仍需确认。`);
    } catch (e) { if (run === epoch.current) setError(e instanceof Error ? e.message : "导入失败"); }
    finally { if (run === epoch.current) setBusy(false); }
  };
  const rows = products.flatMap((p, index) => p.skus?.length ? p.skus.map(sku => ({ key: `${index}:${sku.id}`, title: String(p.title), productKey: String(p.local_product_key ?? p.remote_id ?? ""), sku: sku.id, color: sku.attributes?.color ?? "—", size: sku.attributes?.size ?? "—", price: sku.price, stock: sku.stock, images: (sku.images?.length ?? 0) + (sku.sourceAssetIds?.length ?? 0) })) : [{ key: String(index), title: String(p.title), productKey: String(p.local_product_key ?? p.remote_id ?? ""), sku: "—", color: "—", size: "—", price: p.price as number, stock: p.stock as number, images: Array.isArray(p.images) ? p.images.length : 0 }]);
  return <Card title="商品与 SKU · Excel 导入">
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph style={{ margin: 0 }}>每行填写一个 SKU，相同商品货号自动合并。支持 Excel 和 CSV；先预览，再导入。图片链接和原图素材按 SKU 分别保存，原图素材必须属于当前客户。</Typography.Paragraph>
      {platformScope ? <Alert type="info" showIcon title="请先进入对应客户的授权工作区，再导入该客户商品。平台工作台不能直接向任意用户写入商品。" /> : <Typography.Text>归属工作区：<Typography.Text code>{workspaceId || "未选择"}</Typography.Text></Typography.Text>}
      {!platformScope && !canWrite && <Alert type="warning" showIcon title="当前账号没有商品导入权限，可联系该客户工作区管理员授权。" />}
      <Space wrap><Button icon={<DownloadOutlined />} onClick={async () => { const blob = await productImportTemplate(); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "商品-SKU导入模板.xlsx"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>下载 Excel 模板</Button>
        <Upload accept=".xlsx,.csv" showUploadList={false} beforeUpload={upload} disabled={!enabled || busy}><Button icon={<UploadOutlined />} disabled={!enabled || busy} loading={busy}>上传商品表格</Button></Upload>
        {assetId && !facts && !busy && <Button onClick={() => void runInspect(assetId)}>继续检查</Button>}</Space>
      {fileName && <Typography.Text type="secondary">当前文件：{fileName}</Typography.Text>}
      {error && <div role="alert"><Alert type="error" showIcon title={error} /></div>}
      {phase && <div aria-live="polite"><Alert type={imported.length ? "success" : "info"} showIcon title={phase} /></div>}
      {!!rows.length && <><Typography.Text>预览：{products.length} 个商品，{rows.length} 行 SKU / 商品记录</Typography.Text><Table size="small" dataSource={rows} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }} scroll={{ x: 950 }} columns={[{ title: "商品", dataIndex: "title" }, { title: "货号", dataIndex: "productKey" }, { title: "SKU编码", dataIndex: "sku" }, { title: "颜色", dataIndex: "color" }, { title: "尺码", dataIndex: "size" }, { title: "价格（元）", dataIndex: "price" }, { title: "库存", dataIndex: "stock" }, { title: "图片数", dataIndex: "images" }]} /><Button type="primary" disabled={!enabled || busy || !!imported.length} loading={busy} onClick={() => void commit()}>{imported.length ? "已导入" : "确认预览并导入"}</Button></>}
      {!!imported.length && <Typography.Paragraph copyable>{`在大麦插件中说：查看我的商品，选择需要制作的 SKU。商品编号：${imported.join("、")}`}</Typography.Paragraph>}
    </Space>
  </Card>;
}
