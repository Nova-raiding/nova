import { useEffect, useState } from "react";
import { Alert, Button, Card, Checkbox, Descriptions, Empty, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { ReloadOutlined, ScanOutlined } from "@ant-design/icons";
import { rpc } from "../../api/opsClient.js";
import type { BrandNavigationItem, CanonicalBackfillConflict } from "../../types/ops.js";

const statusMeta = { open: ["待处理", "warning"], claimed: ["处理中", "processing"], resolved: ["已解决", "success"], dismissed: ["已驳回", "default"] } as const;
type ScanState = "idle" | "running" | "success" | "error";

export function canSubmitConflictResolution(input: { canUpdate: boolean; brandId?: string; evidenceConfirmed: boolean; note: string }) {
  return input.canUpdate && Boolean(input.brandId) && input.evidenceConfirmed && input.note.trim().length >= 3;
}

export function conflictEvidenceSummary(row: CanonicalBackfillConflict) {
  return {
    legacyProductId: row.legacyProductId,
    runId: row.runId,
    conflictCode: row.code,
    revision: row.revision,
    canonicalIds: row.canonicalIds,
  };
}

export function CanonicalBackfillConflictSection({ enabled = false, canUpdate = false, brands = [], onScan }: { enabled?: boolean; canUpdate?: boolean; brands?: BrandNavigationItem[]; onScan?: () => Promise<void> | void }) {
  const [rows, setRows] = useState<CanonicalBackfillConflict[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CanonicalBackfillConflict>();
  const [resolution, setResolution] = useState<"resolved" | "dismissed">("resolved");
  const [note, setNote] = useState("");
  const [brandId, setBrandId] = useState("");
  const [evidenceConfirmed, setEvidenceConfirmed] = useState(false);
  const [resolutionError, setResolutionError] = useState("");
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [scanError, setScanError] = useState("");
  const load = async () => { if (!enabled) return; setLoading(true); setError(""); try { setRows((await rpc<CanonicalBackfillConflict[]>("ops.canonical.backfill.conflicts.list", { limit: "100" })) ?? []); } catch (cause) { setError(cause instanceof Error ? cause.message : "冲突队列读取失败"); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, [enabled]);
  const claim = async (row: CanonicalBackfillConflict) => { setLoading(true); try { await rpc("ops.canonical.backfill.conflict.claim", { conflict_id: row.id, expected_revision: String(row.revision), reason: "认领冲突并开始人工核查" }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "认领失败"); setLoading(false); } };
  const resolve = async () => {
    if (!selected) return;
    if (!canSubmitConflictResolution({ canUpdate, brandId, evidenceConfirmed, note })) {
      setResolutionError(!canUpdate ? "当前账号没有 canonical.backfill.update 权限。" : !brandId ? "请选择一个真实品牌范围。" : !evidenceConfirmed ? "请先确认已核对冲突证据。" : "处理说明至少需要 3 个字符。");
      return;
    }
    setLoading(true); setResolutionError("");
    try {
      if (resolution === "resolved" && (selected.code !== "MISSING_BRAND" || selected.sourceProductVersion === undefined)) {
        setResolutionError("只有 MISSING_BRAND 且服务端返回商品版本时才允许安全修复；请刷新队列。");
        setLoading(false);
        return;
      }
      await rpc("ops.canonical.backfill.conflict.resolve", { conflict_id: selected.id, expected_revision: String(selected.revision), status: resolution, reason: `品牌范围：${brands.find(brand => brand.id === brandId)?.title ?? brandId}；${note.trim()}`, resolution_note: note.trim(), ...(resolution === "resolved" ? { remediation_type: "set_legacy_brand", brand_id: brandId, expected_product_version: String(selected.sourceProductVersion) } : {}) });
      setSelected(undefined); setNote(""); setBrandId(""); setEvidenceConfirmed(false); await load();
    } catch (cause) { setResolutionError(cause instanceof Error ? cause.message : "处理失败"); setLoading(false); }
  };
  const openResolution = (row: CanonicalBackfillConflict) => { setSelected(row); setBrandId(""); setEvidenceConfirmed(false); setResolutionError(""); setNote(""); setResolution("resolved"); };
  const closeResolution = () => { if (!loading) { setSelected(undefined); setResolutionError(""); setNote(""); setBrandId(""); setEvidenceConfirmed(false); } };
  const scan = async () => {
    if (!onScan) return;
    setScanState("running");
    setScanError("");
    try {
      await onScan();
      await load();
      setScanState("success");
    } catch (cause) {
      setScanState("error");
      setScanError(cause instanceof Error ? cause.message : "一致性扫描失败");
    }
  };
  if (!enabled) return null;
  return <Card title="Canonical 回填人工冲突队列" extra={<Space><Button icon={<ScanOutlined />} loading={scanState === "running"} onClick={() => void scan()}>扫描并刷新队列</Button><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新队列</Button></Space>}>
    <Typography.Paragraph type="secondary">仅展示服务端入队的冲突；认领和解决均要求最新 revision，不能绕过商品关系校验。</Typography.Paragraph>
    {!canUpdate && <Alert type="info" showIcon title="当前为只读权限" description="你可以查看冲突及其状态，但缺少 canonical.backfill.update，不能认领或处理冲突。" style={{ marginBottom: 12 }} />}
    {scanState === "running" && <Alert type="info" showIcon role="status" title="正在扫描一致性" description="正在读取当前工作区的 canonical 关系并刷新冲突队列；扫描不会修改商品关系。" style={{ marginBottom: 12 }} />}
    {scanState === "success" && <Alert type="success" showIcon role="status" title="一致性扫描已完成" description="队列已按最新服务端结果刷新；空结果不代表全量回填已完成。" style={{ marginBottom: 12 }} />}
    {scanState === "error" && <Alert type="error" showIcon role="alert" title="一致性扫描失败" description={scanError || "服务端未返回可验证结果，当前不应据此判断没有冲突。"} action={<Button size="small" onClick={() => void scan()}>重试扫描</Button>} style={{ marginBottom: 12 }} />}
    {error && <Alert role="alert" type="error" showIcon title="冲突队列操作失败" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} />}
    {rows.length === 0 && !loading ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待处理冲突；空结果不代表全量回填已完成" /> : <Table rowKey="id" loading={loading} size="small" pagination={{ pageSize: 10, showSizeChanger: false }} dataSource={rows} columns={[
      { title: "旧商品", dataIndex: "legacyProductId", ellipsis: true },
      { title: "冲突码", dataIndex: "code", render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
      { title: "状态", dataIndex: "status", render: (value: CanonicalBackfillConflict["status"]) => <Tag color={statusMeta[value][1]}>{statusMeta[value][0]}</Tag> },
      { title: "操作", render: (_: unknown, row: CanonicalBackfillConflict) => !canUpdate ? <Typography.Text type="secondary">只读</Typography.Text> : row.status === "open" ? <Space><Button size="small" onClick={() => void claim(row)}>认领</Button><Button size="small" type="link" onClick={() => openResolution(row)}>处理</Button></Space> : row.status === "claimed" ? <Button size="small" type="link" onClick={() => openResolution(row)}>处理</Button> : <Typography.Text type="secondary">已归档</Typography.Text> },
    ]} />}
    <Modal title="处理 canonical 回填冲突" open={Boolean(selected)} okText="确认并提交处理" cancelText="取消" okButtonProps={{ disabled: !canSubmitConflictResolution({ canUpdate, brandId, evidenceConfirmed, note }), loading }} onCancel={closeResolution} onOk={() => void resolve()}>
      {selected && <Space orientation="vertical" style={{ width: "100%" }} size={12}>
        <Alert type="warning" title="这是人工确认后的受限商品事实修复" description="仅 MISSING_BRAND 会在同一事务中写入明确品牌并重新校验；revision 或商品版本过期时，服务端会拒绝提交。" />
        <Descriptions size="small" bordered column={1} title="冲突证据">
          <Descriptions.Item label="旧商品">{conflictEvidenceSummary(selected).legacyProductId}</Descriptions.Item>
          <Descriptions.Item label="回填批次">{conflictEvidenceSummary(selected).runId}</Descriptions.Item>
          <Descriptions.Item label="冲突码"><Typography.Text code>{conflictEvidenceSummary(selected).conflictCode}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label="当前 revision">{conflictEvidenceSummary(selected).revision}</Descriptions.Item>
          <Descriptions.Item label="候选 canonical">{conflictEvidenceSummary(selected).canonicalIds.length ? conflictEvidenceSummary(selected).canonicalIds.join("、") : "无"}</Descriptions.Item>
        </Descriptions>
        {!canUpdate && <Alert type="info" showIcon title="当前账号无处置权限" description="可查看证据，但不能提交解决或驳回。" />}
        {canUpdate && !brands.length && <Alert type="error" showIcon role="alert" title="没有可验证的品牌范围" description="当前工作区没有返回品牌选择，已阻止提交，避免把冲突归入错误品牌。" />}
        {canUpdate && brands.length > 0 && <Select aria-label="品牌范围" placeholder="请选择真实品牌范围" value={brandId || undefined} onChange={setBrandId} options={brands.map(brand => ({ value: brand.id, label: `${brand.title}（${brand.id}）` }))} />}
        <Select aria-label="处理结果" value={resolution} onChange={setResolution} options={[{ value: "resolved", label: "已解决" }, { value: "dismissed", label: "驳回/不适用" }]} />
        <Checkbox checked={evidenceConfirmed} onChange={(event) => setEvidenceConfirmed(event.target.checked)}>我已核对上述冲突证据，并确认该处置适用于所选品牌范围</Checkbox>
        <Input.TextArea aria-label="处理说明" aria-describedby="conflict-resolution-note-help" value={note} onChange={(event) => setNote(event.target.value)} minLength={3} maxLength={1000} showCount placeholder="请输入至少 3 个字符的处理说明" />
        <Typography.Text id="conflict-resolution-note-help" type={note.trim().length > 0 && note.trim().length < 3 ? "danger" : "secondary"}>处理说明至少 3 个字符；提交前需完成品牌和证据确认。</Typography.Text>
        {resolutionError && <Alert type="error" role="alert" showIcon title="未提交处理结果" description={resolutionError} />}
      </Space>}
    </Modal>
  </Card>;
}
