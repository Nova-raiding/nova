import { useState } from "react";
import { Alert, Button, Card, Input, Space, Typography } from "antd";
import { rpc } from "../../../api/opsClient.js";

export function ImageAuditPanel() {
  const [jobId, setJobId] = useState(""); const [result, setResult] = useState<unknown>(); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const run = async (method: string, params: Record<string, string>) => { if (loading) return; setLoading(true); setError(""); try { setResult(await rpc(method, params)); } catch (cause) { setError(cause instanceof Error ? cause.message : "图片审计失败"); } finally { setLoading(false); } };
  return <Card size="small" title="图片归档与计费审计" extra={<Typography.Text type="secondary">只读审计，不自动修复</Typography.Text>}><Space wrap><Button loading={loading} onClick={() => void run("ops.marketing.image.archive.audit", { limit: "100" })}>审计归档证据</Button><Input aria-label="图片任务 ID" placeholder="job_id" value={jobId} onChange={event => setJobId(event.target.value)} /><Button loading={loading} disabled={!jobId.trim()} onClick={() => void run("ops.marketing.image.billing.audit", { job_id: jobId.trim() })}>审计任务计费</Button></Space>{result !== undefined && <Alert type="info" showIcon title="图片审计结果" description={<Typography.Text code>{JSON.stringify(result)}</Typography.Text>} style={{ marginTop: 12 }} />}{error && <Alert type="error" showIcon title="图片审计失败" description={error} style={{ marginTop: 12 }} />}</Card>;
}
