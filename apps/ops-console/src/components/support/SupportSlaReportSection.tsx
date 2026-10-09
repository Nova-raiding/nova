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

export function supportSlaActionErrorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "提交失败，请检查网络或权限后重试。";
}

export function SupportSlaReportSection({ model }: { model: SupportDomainModel }) {
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState<"approved" | "rejected">();
  const [reason, setReason] = useState("");
  const [correctionError, setCorrectionError] = useState("");
  const [decisionError, setDecisionError] = useState("");
  // The approver's server-issued token lives only in this component's state for
  // the lifetime of one decision: it is never persisted to browser storage, and
  // the success path clears it. Holding it here is deliberate rather than
  // keeping it in a form: the retry control must resubmit the same evidence
  // after a failed decision, so the value has to outlive the first attempt.
  const [approvalToken, setApprovalToken] = useState("");
  const report = model.report;
  const reportMatchesWorkspace = Boolean(report && report.workspaceId === model.workspaceId);
  const visibleReport = reportMatchesWorkspace ? report : undefined;
  const reportStale = Boolean(model.reportStale || model.reportLoading || (report && !reportMatchesWorkspace));
  const load = () => void model.loadReport(previousMonthWindow());
  const rate = visibleReport && visibleReport.denominator > 0 ? `${((visibleReport.met / visibleReport.denominator) * 100).toFixed(1)}%` : "—";

  return (
    <Card
      className="ops-support-sla"
      title="SLA 月报"
      extra={<Button icon={visibleReport ? <ReloadOutlined aria-hidden="true" /> : <FileSearchOutlined aria-hidden="true" />} loading={model.reportLoading} disabled={model.reportLoading} onClick={load}>{visibleReport ? "重新生成上月报告" : "生成上月报告"}</Button>}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        报告由服务端依据不可变工单事件生成；当前按钮生成上一个 UTC 自然月，截止时间由服务端记录。页面不在浏览器侧计算 SLA。
      </Typography.Paragraph>
      {!visibleReport ? (
        <>
          {model.reportError && <Alert role="alert" type="error" showIcon title="月报生成失败" description={model.reportError} />}
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={report && !reportMatchesWorkspace ? "工作区已切换；旧工作区月报已隐藏，正在等待当前工作区报告" : model.reportLoading ? "正在生成月报…" : "尚未生成月报；生成后此处显示服务端快照"} />
        </>
      ) : (
        <>
          {reportStale && <Alert
            role={model.reportError ? "alert" : "status"}
            style={{ marginBottom: 16 }}
            type={model.reportError ? "error" : "warning"}
            showIcon
            title={model.reportError ? "月报刷新失败，当前显示的是历史快照" : "月报正在刷新或工作区切换，当前显示的是历史快照"}
            description={model.reportError || "刷新完成前，此快照不能用于创建 correction。历史数据仍保留供核对。"}
          />}
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={6}><Statistic title="SLA 达成率" value={rate} /></Col>
            <Col xs={24} sm={12} lg={6}><Statistic title="统计分母" value={visibleReport.denominator} suffix="单" /></Col>
            <Col xs={24} sm={12} lg={6}><Statistic title="达成" value={visibleReport.met} suffix="单" /></Col>
            <Col xs={24} sm={12} lg={6}><Statistic title="失败/未解决" value={visibleReport.failed} suffix="单" /></Col>
          </Row>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            周期：{new Date(visibleReport.periodStart).toLocaleDateString()} 至 {new Date(visibleReport.periodEnd).toLocaleDateString()}；截止：{new Date(visibleReport.cutoffAt).toLocaleString()}
          </Typography.Paragraph>
          <Tag color={visibleReport.failed > 0 ? "red" : "green"}>{visibleReport.failed > 0 ? "需要复盘" : "本报告无失败工单"}</Tag>
          {visibleReport.excluded > 0 && <Tag color="gold">排除 {visibleReport.excluded} 单（按合同/测试/合并规则）</Tag>}
          <Alert style={{ marginTop: 16 }} type="info" showIcon title={`报告 checksum：${visibleReport.checksum}`} description="历史报告为不可变证据。迟到事实必须创建 correction run，不得覆盖原报告。" />
          <Typography.Paragraph style={{ marginTop: 16, marginBottom: 8 }}>
            <Button disabled={reportStale} onClick={() => { setReason(""); setCorrectionError(""); setCorrectionOpen(true); }}>创建 correction</Button>
            {model.correction && model.correction.status === "pending_review" && !(model.correctionDecision && "decision" in model.correctionDecision) && <>
              <Tag color="gold" style={{ marginLeft: 8 }}>待审批：{model.correction.correctionId}</Tag>
              <Button size="small" type="primary" style={{ marginLeft: 8 }} onClick={() => { setReason(""); setDecisionError(""); setApprovalToken(""); setDecisionOpen("approved"); }}>批准</Button>
              <Button size="small" danger style={{ marginLeft: 8 }} onClick={() => { setReason(""); setDecisionError(""); setApprovalToken(""); setDecisionOpen("rejected"); }}>拒绝</Button>
            </>}
            {model.correctionDecision && ("decision" in model.correctionDecision ? <Tag color={model.correctionDecision.decision === "approved" ? "green" : "red"} style={{ marginLeft: 8 }}>{model.correctionDecision.decision === "approved" ? "correction 已批准" : "correction 已拒绝"}</Tag> : <Tag color="gold" style={{ marginLeft: 8 }}>已完成 1/2 个独立批准</Tag>)}
          </Typography.Paragraph>
          {model.correction?.status === "pending_review" && !(model.correctionDecision && "decision" in model.correctionDecision) && <Typography.Paragraph type="secondary">已生成 correction 后，需两名不同运营人员独立批准；任一拒绝会立即终止，决策只写入一次，不会修改原报告。</Typography.Paragraph>}
        </>
      )}
      <Modal
        open={correctionOpen}
        title="创建 SLA correction"
        okText="提交 correction"
        cancelText="取消"
        confirmLoading={model.correctionLoading ?? false}
        okButtonProps={{ disabled: reason.trim().length < 3 || reportStale }}
        onCancel={() => { setCorrectionError(""); setCorrectionOpen(false); }}
        onOk={() => {
          if (!model.createCorrection || reportStale) return;
          setCorrectionError("");
          void model.createCorrection(reason)
            .then(() => { setCorrectionOpen(false); })
            .catch(error => { setCorrectionError(supportSlaActionErrorMessage(error)); });
        }}
      >
        <Typography.Paragraph>服务端会用当前事件重建同一报告周期。只有事实变化时才会生成待审批 correction。</Typography.Paragraph>
        {correctionError && <Alert role="alert" aria-live="assertive" type="error" showIcon title={correctionError} description="请修正后再次提交；原窗口仍保持打开，已填写的理由不会清空。" action={<Button
          size="small"
          style={{ minHeight: 44 }}
          loading={model.correctionLoading ?? false}
          disabled={Boolean(model.correctionLoading || reportStale)}
          aria-busy={model.correctionLoading || undefined}
          aria-label={model.correctionLoading ? "正在重试提交 correction" : "重试提交 correction"}
          onClick={() => { if (!model.createCorrection || model.correctionLoading || reportStale) return; setCorrectionError(""); void model.createCorrection(reason).then(() => setCorrectionOpen(false)).catch(error => setCorrectionError(supportSlaActionErrorMessage(error))); }}
        >重试提交</Button>} />}
        <Input.TextArea aria-label="correction 理由" rows={4} value={reason} onChange={event => setReason(event.target.value)} placeholder="说明迟到事实来源和复核范围（至少 3 个字符）" />
      </Modal>
      {/* The approval act is proven by the token the approver holds, not by a
          typed name: the API reads x-authorization-approval-token only, so a
          body claim is not evidence. The token input is required for submit
          because the server resolves the approver from the token grant alone —
          without one, the decision is rejected under requiresStrictAuth()
          (AUTHZ_OBLIGATION_REQUIRED) after the operator has filled a reason. */}
      <Modal
        open={Boolean(decisionOpen)}
        title="确认 correction 决策"
        okText={decisionOpen === "approved" ? "批准" : "拒绝"}
        cancelText="取消"
        confirmLoading={model.correctionLoading ?? false}
        okButtonProps={{ disabled: reason.trim().length < 3 || !approvalToken.trim() }}
        onCancel={() => { setDecisionError(""); setApprovalToken(""); setDecisionOpen(undefined); }}
        onOk={() => {
          if (!decisionOpen || !model.decideCorrection) return;
          setDecisionError("");
          void model.decideCorrection(decisionOpen, reason, approvalToken)
            .then(() => { setDecisionOpen(undefined); setApprovalToken(""); })
            .catch(error => { setDecisionError(supportSlaActionErrorMessage(error)); });
        }}
      >
        <Typography.Paragraph>该决策将作为不可变审计证据保存，每个 correction 只能决策一次。</Typography.Paragraph>
        <Alert showIcon type="warning" role="status" title="审批证据来自审批人令牌，而不是表单里的姓名" description="服务端只从 x-authorization-approval-token 请求头解析审批人；令牌由平台签发方发放给审批人本人，只随本次决策请求提交，不写入浏览器存储，审批成功后自动清空。" style={{ marginBottom: 16 }} />
        <Input.Password
          aria-label="审批人令牌"
          aria-describedby="sla-approval-token-help"
          autoComplete="off"
          value={approvalToken}
          onChange={event => setApprovalToken(event.target.value)}
          placeholder="由审批人提供的令牌"
        />
        <Typography.Paragraph id="sla-approval-token-help" type="secondary" style={{ marginTop: 8 }}>
          令牌由审批人本人提供，不由操作者代填；只随本次决策请求提交，不写入浏览器本地存储，审批成功后自动清空。
        </Typography.Paragraph>
        {decisionError && <Alert role="alert" aria-live="assertive" type="error" showIcon title={decisionError} description="请确认理由和权限后再次提交；当前决策窗口仍保持打开，已填写的理由不会清空。" action={<Button
          size="small"
          style={{ minHeight: 44 }}
          loading={model.correctionLoading ?? false}
          disabled={model.correctionLoading ?? false}
          aria-busy={model.correctionLoading || undefined}
          aria-label={model.correctionLoading ? "正在重试提交 correction 决策" : "重试提交 correction 决策"}
          onClick={() => { if (!decisionOpen || !model.decideCorrection || model.correctionLoading) return; setDecisionError(""); void model.decideCorrection(decisionOpen, reason, approvalToken).then(() => { setDecisionOpen(undefined); setApprovalToken(""); }).catch(error => setDecisionError(supportSlaActionErrorMessage(error))); }}
        >重试提交</Button>} />}
        <Input.TextArea aria-label="审批理由" rows={4} value={reason} onChange={event => setReason(event.target.value)} placeholder="填写审批或拒绝理由（至少 3 个字符）" />
      </Modal>
    </Card>
  );
}
