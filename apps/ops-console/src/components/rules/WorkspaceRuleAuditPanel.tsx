import { useState } from "react";
import { Alert, Button, Card, Input, Space, Typography } from "antd";
import { rpc } from "../../api/opsClient.js";

export function WorkspaceRuleAuditPanel() {
  const [packId, setPackId] = useState(""); const [result, setResult] = useState<unknown>(); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const run = async () => { if (!packId.trim() || loading) return; setLoading(true); setError(""); try { setResult(await rpc("ops.rules.workspace.audit", { pack_id: packId.trim() })); } catch (cause) { setError(cause instanceof Error ? cause.message : "规则审计失败"); } finally { setLoading(false); } };
  return <Card size="small" title="Workspace 规则审计" extra={<Typography.Text type="secondary">只读，不改变规则状态</Typography.Text>}><Space.Compact style={{ width: "100%" }}><Input aria-label="规则包 ID" placeholder="输入 pack_id" value={packId} onChange={event => setPackId(event.target.value)} /><Button type="primary" loading={loading} disabled={!packId.trim()} onClick={() => void run()}>审计</Button></Space.Compact>{result !== undefined && <Alert type="info" showIcon title="规则审计结果" description={<Typography.Text code>{JSON.stringify(result)}</Typography.Text>} style={{ marginTop: 12 }} />}{error && <Alert type="error" showIcon title="规则审计失败" description={error} style={{ marginTop: 12 }} />}</Card>;
}
