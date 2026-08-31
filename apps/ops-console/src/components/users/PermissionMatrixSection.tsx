import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Input, Select, Space, Table, Tag, Typography, type TableColumnsType } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { rpc } from "../../api/opsClient";

export type PermissionAccess = "hidden" | "read" | "operate" | "govern";
export type PermissionMatrixItem = {
  method: string;
  capability: string;
  workbench: "platform" | "workspace";
  scope: "self" | "workspace" | "brand" | "account" | "platform";
  data_class: string;
  effect: "read" | "write";
  audit: string;
  obligations: string[];
  role_access: Record<string, PermissionAccess>;
};
type PermissionMatrix = {
  schema_version: 1;
  policy_version: string;
  generated_from: "MCP_METHOD_POLICIES";
  method_count: number;
  role_count: number;
  roles: string[];
  items: PermissionMatrixItem[];
};

const roleLabels: Record<string, string> = {
  platform_admin: "平台管理员", ops_admin: "运营管理员", support_agent: "平台客服", finance_ops: "平台财务",
  security_admin: "安全管理员", auditor: "审计员", rules_admin: "规则管理员", model_admin: "模型管理员",
  release_admin: "发布管理员", workspace_owner: "商家所有者", workspace_admin: "商家管理员", operator: "商家运营",
  workspace_support: "商家客服", reviewer: "审核员", finance: "商家财务", viewer: "只读成员",
  knowledge_editor: "知识编辑", knowledge_reader: "知识只读", competitor_reviewer: "竞品审核员",
};
const defaultRoles = ["platform_admin", "ops_admin", "support_agent", "finance_ops", "security_admin", "workspace_owner", "workspace_admin", "operator", "reviewer", "viewer"];
const accessPresentation: Record<PermissionAccess, { label: string; color?: string }> = {
  hidden: { label: "不可见" }, read: { label: "只读", color: "blue" }, operate: { label: "操作", color: "green" }, govern: { label: "治理", color: "purple" },
};

export function filterPermissionMatrixItems(items: readonly PermissionMatrixItem[], input: { query: string; workbench?: string; effect?: string }) {
  const query = input.query.trim().toLowerCase();
  return items.filter((item) => (!input.workbench || item.workbench === input.workbench)
    && (!input.effect || item.effect === input.effect)
    && (!query || `${item.method} ${item.capability} ${item.scope} ${item.data_class}`.toLowerCase().includes(query)));
}

function AccessTag({ access }: { access: PermissionAccess }) {
  const presentation = accessPresentation[access];
  return <Tag color={presentation.color}>{presentation.label}</Tag>;
}

export function PermissionMatrixSection() {
  const { message } = App.useApp();
  const [matrix, setMatrix] = useState<PermissionMatrix>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [workbench, setWorkbench] = useState<string>();
  const [effect, setEffect] = useState<string>();
  const [visibleRoles, setVisibleRoles] = useState<string[]>(defaultRoles);

  const load = async () => {
    setLoading(true);
    try {
      const value = await rpc<PermissionMatrix>("ops.authorization.matrix.get");
      if (!value || value.method_count !== value.items.length || value.role_count !== value.roles.length) throw new Error("权限矩阵响应不完整");
      setMatrix(value);
      setVisibleRoles((current) => current.filter((role) => value.roles.includes(role)).length ? current.filter((role) => value.roles.includes(role)) : value.roles.slice(0, 10));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "权限矩阵读取失败");
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const items = useMemo(() => filterPermissionMatrixItems(matrix?.items ?? [], { query: deferredQuery, workbench, effect }), [matrix?.items, deferredQuery, workbench, effect]);
  const columns = useMemo<TableColumnsType<PermissionMatrixItem>>(() => [
    { title: "插件方法", dataIndex: "method", key: "method", fixed: "left", width: 240, render: (value: string) => <Typography.Text code copyable>{value}</Typography.Text> },
    { title: "能力", dataIndex: "capability", key: "capability", fixed: "left", width: 220, render: (value: string) => <Typography.Text>{value}</Typography.Text> },
    { title: "边界", key: "boundary", width: 170, render: (_value, row) => <Space size={4} wrap><Tag>{row.workbench === "platform" ? "平台台" : "工作区台"}</Tag><Tag>{row.scope}</Tag></Space> },
    { title: "动作与审计", key: "effect", width: 190, render: (_value, row) => <Space size={4} wrap><Tag color={row.effect === "write" ? "volcano" : "blue"}>{row.effect === "write" ? "写入" : "读取"}</Tag><Tag>{row.audit}</Tag>{row.obligations.map((item) => <Tag key={item} color="gold">{item}</Tag>)}</Space> },
    ...visibleRoles.map((role) => ({ title: roleLabels[role] ?? role, key: role, width: 116, align: "center" as const, render: (_value: unknown, row: PermissionMatrixItem) => <AccessTag access={row.role_access[role] ?? "hidden"} /> })),
  ], [visibleRoles]);

  return <Space orientation="vertical" size="middle" className="full-width">
    <Alert showIcon type="info" title="插件功能权限矩阵" description="数据直接生成自服务端 MCP_METHOD_POLICIES；不可见表示该角色没有对应能力，最终执行仍由当前工作台、资源范围、显式 deny 和义务条件共同决定。" />
    <Space wrap aria-label="权限矩阵筛选">
      <Input.Search allowClear value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索方法、能力或数据类型" aria-label="搜索插件方法或能力" style={{ width: 300 }} />
      <Select allowClear value={workbench} onChange={setWorkbench} placeholder="全部工作台" aria-label="筛选工作台" style={{ width: 140 }} options={[{ value: "platform", label: "平台工作台" }, { value: "workspace", label: "商家工作台" }]} />
      <Select allowClear value={effect} onChange={setEffect} placeholder="全部动作" aria-label="筛选读写动作" style={{ width: 130 }} options={[{ value: "read", label: "读取" }, { value: "write", label: "写入" }]} />
      <Select mode="multiple" value={visibleRoles} onChange={setVisibleRoles} aria-label="选择对比角色" placeholder="选择对比角色" maxTagCount="responsive" style={{ minWidth: 360 }} options={(matrix?.roles ?? []).map((role) => ({ value: role, label: roleLabels[role] ?? role }))} />
      <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>刷新矩阵</Button>
    </Space>
    <Typography.Text type="secondary">策略 {matrix?.policy_version ?? "读取中"} · {items.length}/{matrix?.method_count ?? 0} 个插件方法 · 当前显示 {visibleRoles.length} 个角色</Typography.Text>
    <Table<PermissionMatrixItem> rowKey="method" size="small" loading={loading} dataSource={items} columns={columns} pagination={{ pageSize: 25, showSizeChanger: true, pageSizeOptions: [25, 50, 100], showTotal: (total) => `共 ${total} 个方法` }} scroll={{ x: 830 + visibleRoles.length * 116, y: 560 }} sticky />
  </Space>;
}
