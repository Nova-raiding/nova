import { FileSearchOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Empty, Input, Modal, Row, Statistic, Tag, Typography } from "antd";
import { useState } from "react";
import type { SupportDomainModel } from "../../hooks/useSupportDomain.js";
import { supportSlaReportCutoffAt } from "../../../../../packages/contracts/src/ops/support-sla.js";

function previousMonthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const cutoff = new Date(supportSlaReportCutoffAt(end.toISOString()));
  return { periodStart: start.toISOString(), periodEnd: end.toISOString(), cutoffAt: cutoff.toISOString() };
}

export function SupportSlaReportSection({ model }: { model: SupportDomainModel }) {
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState<"approved" | "rejected">();
  const [reason, setReason] = useState("");
  const report = model.report;
  const load = () => void model.loadReport(previousMonthWindow());
  const rate = report && report.denominator > 0 ? `${((report.met / report.denominator) * 100).toFixed(1)}%` : "—";

  return (
    <Card
      title="SLA 月报"
      extra={<Button icon={report ? <ReloadOutlined aria-hidden="true" /> : <FileSearchOutlined aria-hidden="true" />} loading={model.reportLoading} onClick={load}>{report ? "重新生成上月报告" : "生成上月报告"}</Button>}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        报告由服务端依据不可变工单事件生成；当前按钮生成上一个 UTC 自然月，截止时间由服务端记录。页面不在浏览器侧计算 SLA。
      </Typography.Paragraph>
      {!report ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未生成月报；生成后此处显示服务端快照" />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={6}><Statistic title="SLA 达成率" value={rate} /></Col>
            <Col xs={24} sm={12} lg={6}><Statistic title="统计分母" value={report.denominator} suffix="单" /></Col>
            <Col xs={24} sm={12} lg={6}><Statistic title="达成" value={report.met} suffix="单" /></Col>
            <Col xs={24} sm={12} lg={6}><Statistic title="失败/未解决" value={report.failed} suffix="单" /></Col>
          </Row>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            周期：{new Date(report.periodStart).toLocaleDateString()} 至 {new Date(report.periodEnd).toLocaleDateString()}；截止：{new Date(report.cutoffAt).toLocaleString()}
          </Typography.Paragraph>
          <Tag color={report.failed > 0 ? "red" : "green"}>{report.failed > 0 ? "需要复盘" : "本报告无失败工单"}</Tag>
          {report.excluded > 0 && <Tag color="gold">排除 {report.excluded} 单（按合同/测试/合并规则）</Tag>}
          <Alert style={{ marginTop: 16 }} type="info" showIcon title={`报告 checksum：${report.checksum}`} description="历史报告为不可变证据。迟到事实必须创建 correction run，不得覆盖原报告。" />
          <Typography.Paragraph style={{ marginTop: 16, marginBottom: 8 }}>
            <Button onClick={() => { setReason(""); setCorrectionOpen(true); }}>创建 correction</Button>
            {model.correction && model.correction.status === "pending_review" && !(model.correctionDecision && "decision" in model.correctionDecision) && <>
              <Tag color="gold" style={{ marginLeft: 8 }}>待审批：{model.correction.correctionId}</Tag>
              <Button size="small" type="primary" style={{ marginLeft: 8 }} onClick={() => { setReason(""); setDecisionOpen("approved"); }}>批准</Button>
              <Button size="small" danger style={{ marginLeft: 8 }} onClick={() => { setReason(""); setDecisionOpen("rejected"); }}>拒绝</Button>
            </>}
            {model.correctionDecision && ("decision" in model.correctionDecision ? <Tag color={model.correctionDecision.decision === "approved" ? "green" : "red"} style={{ marginLeft: 8 }}>{model.correctionDecision.decision === "approved" ? "correction 已批准" : "correction 已拒绝"}</Tag> : <Tag color="gold" style={{ marginLeft: 8 }}>已完成 1/2 个独立批准</Tag>)}
          </Typography.Paragraph>
          {model.correction?.status === "pending_review" && !(model.correctionDecision && "decision" in model.correctionDecision) && <Typography.Paragraph type="secondary">已生成 correction 后，需两名不同运营人员独立批准；任一拒绝会立即终止，决策只写入一次，不会修改原报告。</Typography.Paragraph>}
        </>
      )}
      <Modal open={correctionOpen} title="创建 SLA correction" okText="提交 correction" cancelText="取消" confirmLoading={model.correctionLoading ?? false} okButtonProps={{ disabled: reason.trim().length < 3 }} onCancel={() => setCorrectionOpen(false)} onOk={() => model.createCorrection && void model.createCorrection(reason).then(() => setCorrectionOpen(false))}>
        <Typography.Paragraph>服务端会用当前事件重建同一报告周期。只有事实变化时才会生成待审批 correction。</Typography.Paragraph>
        <Input.TextArea aria-label="correction 理由" rows={4} value={reason} onChange={event => setReason(event.target.value)} placeholder="说明迟到事实来源和复核范围（至少 3 个字符）" />
      </Modal>
      <Modal open={Boolean(decisionOpen)} title="确认 correction 决策" okText={decisionOpen === "approved" ? "批准" : "拒绝"} cancelText="取消" confirmLoading={model.correctionLoading ?? false} okButtonProps={{ disabled: reason.trim().length < 3 }} onCancel={() => setDecisionOpen(undefined)} onOk={() => decisionOpen && model.decideCorrection && void model.decideCorrection(decisionOpen, reason).then(() => setDecisionOpen(undefined))}>
        <Typography.Paragraph>该决策将作为不可变审计证据保存，每个 correction 只能决策一次。</Typography.Paragraph>
        <Input.TextArea aria-label="审批理由" rows={4} value={reason} onChange={event => setReason(event.target.value)} placeholder="填写审批或拒绝理由（至少 3 个字符）" />
      </Modal>
    </Card>
  );
}
