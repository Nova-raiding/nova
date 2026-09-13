import { useEffect, useState } from "react";
import { Alert, Button, Card, Input, Space, Table, Tag, Typography } from "antd";
import { rpc } from "../../api/opsClient.js";

type FlagRow = {
  id: string;
  key: string;
  environment: string;
  description?: string;
  enabled?: boolean;
  emergencyDisabled?: boolean;
  revision?: number;
};

/**
 * Compact platform control-plane surface.  Feature flags remain a server-side
 * capability; this panel deliberately renders explicit unavailable/error
 * states instead of treating an empty response as "no flags".
 */
export function FeatureFlagControlPanel() {
  const [environment, setEnvironment] = useState("production");
  const [items, setItems] = useState<FlagRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>();
  const [flagKey, setFlagKey] = useState("");
  const [evaluation, setEvaluation] = useState<unknown>();

  const load = async () => {
    setLoading(true);
    setMessage(undefined);
    try {
      const result = await rpc<{ items?: FlagRow[] }>("ops.feature-flags.list", {
        environment,
        limit: "20",
      });
      setItems(result?.items ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "功能开关加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [environment]);

  const evaluate = async () => {
    if (!flagKey.trim()) return;
    try {
      setEvaluation(await rpc("ops.feature-flag.evaluate", {
        flag_key: flagKey.trim(),
        environment,
      }));
    } catch (error) {
      setEvaluation({ error: error instanceof Error ? error.message : "评估失败" });
    }
  };

  const emergencyToggle = async (flag: FlagRow) => {
    const reason = window.prompt("请输入紧急操作原因（至少 3 个字符）", "平台运营变更")?.trim();
    if (!reason || reason.length < 3) return;
    try {
      await rpc("ops.feature-flag.emergency.set", {
        id: flag.id,
        disabled: String(!flag.emergencyDisabled),
        expected_revision: String(flag.revision ?? 0),
        idempotency_key: crypto.randomUUID(),
        reason,
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "紧急开关操作失败");
    }
  };

  const createFlag = async () => {
    const key = window.prompt("请输入新开关键", "platform.demo.enabled")?.trim();
    if (!key) return;
    const reason = window.prompt("请输入变更原因", "平台运营创建功能开关")?.trim();
    if (!reason || reason.length < 3) return;
    try {
      await rpc("ops.feature-flag.upsert", {
        key,
        environment,
        description: "平台运营创建",
        enabled: "false",
        default_value_json: JSON.stringify({ type: "boolean", value: false }),
        targets_json: "[]",
        idempotency_key: crypto.randomUUID(),
        reason,
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "功能开关保存失败");
    }
  };

  const showEvents = async (flag: FlagRow) => {
    try {
      const events = await rpc("ops.feature-flag.events", { flag_id: flag.id, limit: "20" });
      setEvaluation(events);
    } catch (error) {
      setEvaluation({ error: error instanceof Error ? error.message : "审计事件加载失败" });
    }
  };

  return (
    <Card title="平台功能开关" extra={<Button onClick={() => void load()} loading={loading}>刷新</Button>}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input aria-label="功能开关环境" value={environment} onChange={(event) => setEnvironment(event.target.value)} style={{ width: 180 }} />
        <Button type="primary" onClick={() => void createFlag()}>新建开关</Button>
        <Input aria-label="评估开关键" placeholder="输入 flag key 评估" value={flagKey} onChange={(event) => setFlagKey(event.target.value)} style={{ width: 240 }} />
        <Button onClick={() => void evaluate()} disabled={!flagKey.trim()}>评估</Button>
      </Space>
      {message ? <Alert type="warning" showIcon title="功能开关数据不可用" description={message} style={{ marginBottom: 12 }} /> : null}
      {evaluation ? <Alert type="info" showIcon title="评估/审计结果" description={<Typography.Text code>{JSON.stringify(evaluation)}</Typography.Text>} style={{ marginBottom: 12 }} /> : null}
      <Table<FlagRow>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: message ? "功能开关数据尚未取得" : "暂无功能开关" }}
        columns={[
          { title: "开关键", dataIndex: "key", render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
          { title: "环境", dataIndex: "environment" },
          { title: "状态", render: (_: unknown, row) => <Tag color={row.emergencyDisabled ? "red" : row.enabled ? "green" : "default"}>{row.emergencyDisabled ? "紧急关闭" : row.enabled ? "启用" : "停用"}</Tag> },
          { title: "操作", render: (_: unknown, row) => <Space><Button size="small" onClick={() => void showEvents(row)}>审计</Button><Button size="small" danger={!row.emergencyDisabled} onClick={() => void emergencyToggle(row)}>{row.emergencyDisabled ? "恢复" : "紧急关闭"}</Button></Space> },
        ]}
      />
    </Card>
  );
}
