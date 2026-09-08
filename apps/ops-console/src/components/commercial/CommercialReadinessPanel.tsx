import { Alert, Button, Card, Col, Descriptions, List, Row, Skeleton, Space, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import type { AuthorizationProjection } from "../../authz/authorization.js";
import { describeOpsError } from "../../api/opsClient.js";
import { commercialCapabilities, commercialOperationsClient, type CommercialOperationsClient, type CommercialReadinessReport } from "../../api/commercialOperationsClient.js";

type ReadinessEvidence = Record<string, unknown>;
type Check = { ready: boolean; reason: string };

const expectedSkus = [
  { key: "onboarding", label: "5000 元正式开通" },
  { key: "trial", label: "1999 元 / 7 天试用" },
  { key: "monthly_basic", label: "基础版 2000 元 / 月" },
  { key: "monthly_growth", label: "成长版 5000 元 / 月" },
  { key: "monthly_custom", label: "定制版 10000 元起 / 月" },
  { key: "points_500", label: "500 创意点 / 300 元" },
  { key: "points_2000", label: "2000 创意点 / 1000 元" },
] as const;

const commercialPolicies = [
  { label: "试用抵扣正式开通费", aliases: ["trial_credit", "trial_offset", "private_trial_credit"] },
  { label: "5000 元方案点数发放", aliases: ["point_grant", "creative_point_grant", "onboarding_point_grant", "grant_schedule"] },
  { label: "点数次月到期 / 6 个月后停止赠送", aliases: ["point_expiry", "creative_point_expiry", "grant_expiry"] },
  { label: "退款规则", aliases: ["refund", "refund_policy", "commercial_refund"] },
  { label: "到期停服与权益关闭", aliases: ["suspension", "service_stop", "entitlement_stop", "subscription_stop"] },
] as const;

const displayName: Record<string, string> = { image: "标准图片", image_edit: "图片标注 / 编辑", video: "15 秒视频", text: "文本生成" };
const isRecord = (value: unknown): value is ReadinessEvidence => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function findEvidence(report: CommercialReadinessReport, aliases: readonly string[]): ReadinessEvidence | null {
  const sources: ReadinessEvidence[] = [report.catalog, report.policies, report.capabilities, report.provider, report.creativePoints];
  for (const source of sources) for (const alias of aliases) if (isRecord(source[alias])) return source[alias];
  return null;
}

function reasonOf(evidence: ReadinessEvidence | null, fallback: string): string {
  if (!evidence) return fallback;
  for (const key of ["blocking_reason", "blockingReason", "reason", "detail", "message"]) if (typeof evidence[key] === "string" && evidence[key]) return evidence[key] as string;
  for (const key of ["reasons", "errors", "unresolved"]) if (Array.isArray(evidence[key]) && evidence[key].some(item => typeof item === "string")) return (evidence[key] as unknown[]).filter((item): item is string => typeof item === "string").join("、");
  return fallback;
}

function checkSku(report: CommercialReadinessReport, key: string): Check {
  const evidence = findEvidence(report, [key, `sku_${key}`, `${key}_sku`]);
  if (!evidence) return { ready: false, reason: "就绪报告未返回该 SKU 的可执行证据" };
  if (evidence.executable === true && evidence.blocking_reason == null && evidence.blockingReason == null) return { ready: true, reason: "已返回可执行证据" };
  return { ready: false, reason: reasonOf(evidence, "SKU 未达到可执行状态") };
}

function checkPolicy(report: CommercialReadinessReport, aliases: readonly string[], label: string): Check {
  const evidence = findEvidence(report, aliases);
  if (!evidence) return { ready: false, reason: `就绪报告未返回“${label}”配置证据` };
  const configured = evidence.configured === true || evidence.ready === true || evidence.executable === true;
  if (configured && evidence.blocking_reason == null && evidence.blockingReason == null) return { ready: true, reason: "已返回配置证据" };
  return { ready: false, reason: reasonOf(evidence, "规则未达到可执行状态") };
}

export function evaluateCommercialReadiness(report: CommercialReadinessReport) {
  const skuChecks = expectedSkus.map(item => ({ key: item.key, label: item.label, check: checkSku(report, item.key) }));
  const policyChecks = commercialPolicies.map(item => ({ label: item.label, check: checkPolicy(report, item.aliases, item.label) }));
  const enabledOperations = report.registry.filter(item => item.enabled).length;
  const registryCheck: Check = report.registry.length === 0 ? { ready: false, reason: "就绪报告未返回计费操作注册表" } : enabledOperations > 0 ? { ready: true, reason: `${enabledOperations} 个计费操作已启用` } : { ready: false, reason: "没有启用的计费操作" };
  return { skuChecks, policyChecks, registryCheck };
}

function StatusTag({ check }: { check: Check }) { return <Tag color={check.ready ? "success" : "error"}>{check.ready ? "已配置" : "阻断"}</Tag>; }

function CheckList({ title, items }: { title: string; items: Array<{ label: string; check: Check }> }) {
  const blocked = items.filter(item => !item.check.ready).length;
  return <Card size="small" type="inner" title={<Space><span>{title}</span><Tag color={blocked ? "error" : "success"}>{blocked ? `${blocked} 项阻断` : "全部已配置"}</Tag></Space>}>
    <List size="small" dataSource={items} renderItem={item => <List.Item><List.Item.Meta title={<Space><StatusTag check={item.check} /><Typography.Text>{item.label}</Typography.Text></Space>} description={<Typography.Text type={item.check.ready ? "secondary" : "danger"}>{item.check.reason}</Typography.Text>} /></List.Item>} />
  </Card>;
}

export function CommercialReadinessPanel({ authorization, client = commercialOperationsClient }: { authorization: AuthorizationProjection; client?: CommercialOperationsClient }) {
  const canRead = authorization.can(commercialCapabilities.rateRead);
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "error" | "forbidden"; data?: CommercialReadinessReport; error?: string }>({ status: "idle" });
  const load = useCallback(async () => {
    if (!canRead) { setState({ status: "forbidden" }); return; }
    setState({ status: "loading" });
    try { setState({ status: "ready", data: await client.readiness() }); } catch (error) { setState({ status: "error", error: describeOpsError(error) }); }
  }, [canRead, client]);
  useEffect(() => { void load(); }, [load]);

  if (state.status === "forbidden") return <Alert type="info" showIcon title="商业生产就绪状态只读" description="当前会话缺少 commercial.rate.read，未发起报告请求。" />;
  if (state.status === "idle" || (state.status === "loading" && !state.data)) return <Card title="商业化开通准备" size="small"><Skeleton active paragraph={{ rows: 2 }} /></Card>;
  if (state.status === "error" && !state.data) return <Alert type="error" showIcon title="商业化开通准备报告不可用" description={state.error} action={<Button icon={<ReloadOutlined />} onClick={() => void load()}>重试</Button>} />;
  const report = state.data;
  if (!report) return null;

  const { skuChecks, policyChecks, registryCheck } = evaluateCommercialReadiness(report);
  const capabilityEntries = Object.entries(report.capabilities);

  return <Card size="small" title="商业化开通准备" extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} loading={state.status === "loading"}>刷新</Button>}>
    {state.status === "error" ? <Alert type="warning" showIcon title="以下为上次成功报告" description={state.error} style={{ marginBottom: 16 }} /> : null}
    <Alert type={report.ready ? "success" : "warning"} showIcon title={report.ready ? "READY · 可进入生产门禁" : "BLOCKED · 商业化开通仍被阻断"} description={report.message} />
    <Descriptions size="small" column={3} style={{ marginTop: 16 }} items={[{ key: "environment", label: "环境", children: <Tag>{report.environment || "未知"}</Tag> }, { key: "blockers", label: "全局阻断项", children: report.blockers.length || "未知" }, { key: "generated", label: "报告时间", children: report.generatedAt ? new Date(report.generatedAt).toLocaleString() : <Typography.Text type="danger">未知 · 阻断</Typography.Text> }]} />
    <Row gutter={[12, 12]} style={{ marginTop: 16 }}><Col xs={24} xl={12}><CheckList title="可执行 SKU" items={skuChecks} /></Col><Col xs={24} xl={12}><CheckList title="方案规则" items={[...policyChecks, { label: "计费操作注册表", check: registryCheck }]} /></Col></Row>
    <Card size="small" type="inner" title="已返回的创意点能力费率" style={{ marginTop: 12 }}>
      {capabilityEntries.length ? <Row gutter={[8, 8]}>{capabilityEntries.map(([name, raw]) => { const evidence = isRecord(raw) ? raw : null; const check: Check = evidence?.executable === true && evidence.blocking_reason == null && evidence.blockingReason == null ? { ready: true, reason: "已返回可执行费率" } : { ready: false, reason: reasonOf(evidence, "费率未返回可执行证据") }; return <Col key={name} xs={24} sm={12} md={6}><Card size="small" title={displayName[name] ?? name}><StatusTag check={check} /><Typography.Text type={check.ready ? "secondary" : "danger"} style={{ display: "block", marginTop: 6 }}>{check.reason}</Typography.Text></Card></Col>; })}</Row> : <Alert type="error" showIcon title="未知 · 阻断" description="就绪报告未返回任何商业能力费率。" />}
    </Card>
    <Card size="small" type="inner" title="底层结算证据" style={{ marginTop: 12 }}><Descriptions size="small" column={3} items={[{ key: "balance", label: "点数账本", children: report.creativePoints.point_balance_repository === true ? <Tag color="success">已配置</Tag> : <Tag color="error">未知 / 阻断</Tag> }, { key: "settlement", label: "预占与结算", children: report.creativePoints.reservation_and_settlement_repository === true ? <Tag color="success">已配置</Tag> : <Tag color="error">未知 / 阻断</Tag> }, { key: "audit", label: "可审计结算", children: report.creativePoints.auditable === true ? <Tag color="success">已配置</Tag> : <Tag color="error">未知 / 阻断</Tag> }]} /></Card>
    {report.blockers.length ? <List size="small" header={<Typography.Text strong>需要处理的全局阻断项</Typography.Text>} dataSource={report.blockers} renderItem={(blocker) => <List.Item><List.Item.Meta title={<><Tag color="error">{blocker.scope}</Tag><Typography.Text code>{blocker.code}</Typography.Text></>} description={<><div>{blocker.detail}</div><Typography.Text type="secondary">下一步：{blocker.nextAction}</Typography.Text></>} /></List.Item>} style={{ marginTop: 16 }} /> : null}
  </Card>;
}
