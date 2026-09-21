import { Alert, Button, Card, Col, Row, Skeleton, Statistic, Tag, Typography } from "antd";
import { useEffect, useRef } from "react";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { ModelReadinessTable } from "./ModelReadinessTable";

interface ModelStatusSectionProps {
  model: OpsConsoleModel;
}

export function ModelStatusSection({ model }: ModelStatusSectionProps) {
  const { modelStatus, modelStatusLoading } = model;
  const modelError = model.dataSetError("platform.model.status");
  const fixtureData = model.dataSource?.fixtureDataPresent === true;
  // The hook retains the last value after a failed refresh, but readiness is
  // a launch gate: stale data must not be presented as current evidence.
  const displayStatus = modelError ? undefined : modelStatus;
  const errorRef = useRef<HTMLDivElement>(null);
  const statusLabel = displayStatus?.state ?? (modelStatusLoading ? "加载中" : "不可用");
  // `platform.model.status` is a model-service diagnostic. Even when it says
  // ready, it does not carry the immutable identity returned by `/api/releasez`.
  // Blue means this endpoint reports model runtime ready; green is reserved
  // for evidence that can actually establish production release readiness.
  const statusColor = !displayStatus ? (modelStatusLoading ? "processing" : "red") : fixtureData ? "orange" : displayStatus.state === "ready" ? "blue" : "red";

  useEffect(() => {
    if (modelError) errorRef.current?.focus({ preventScroll: true });
  }, [modelError]);

  return (
    <Card
      title="模型服务诊断"
      aria-busy={modelStatusLoading}
      extra={
        <Tag color={statusColor} aria-live="polite">
          {statusLabel}
        </Tag>
      }
    >
      {modelStatusLoading ? (
        <div role="status" aria-live="polite" aria-label="正在加载平台模型状态">
          <Skeleton active paragraph={{ rows: 3 }} />
        </div>
      ) : null}
      {!modelStatusLoading ? <>
      {fixtureData ? <Alert type="warning" showIcon title="当前含演示数据，模型 readiness 不可视为真实生产就绪" description="请先切换到无 fixture 的真实 API/数据源；本页面不会把演示配置标记为可用。" /> : null}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Statistic title="模型归属" value="平台统一" />
        </Col>
        <Col xs={24} sm={12} xl={6}>
            <Statistic title="自有中转站" value={displayStatus?.relay?.configured ? "已配置" : "未配置"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
            <Statistic title="文案模型" value={displayStatus?.text_model ?? "-"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
            <Statistic title="图片模型" value={displayStatus?.image_model ?? "-"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
            <Statistic title="OCR 模型" value={displayStatus?.vision_model ?? "-"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
            <Statistic title="视频模型" value={displayStatus?.video_model ?? "-"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
            <Statistic title="RPM" value={displayStatus?.quotas.rpm ?? "-"} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
            <Statistic title="日成本上限（元）" value={displayStatus?.quotas.daily_cny_limit ?? "-"} />
        </Col>
      </Row>
      <Typography.Paragraph type="secondary">
        用户不能填写或绑定模型 Key；平台负责模型费用，商家通过充值和套餐额度使用插件能力。中转站{" "}
        {displayStatus?.relay?.host ?? "-"}，TPM {displayStatus?.quotas.tpm ?? "-"}，模型状态接口中的插件构建字段标记{" "}
        {displayStatus?.release_metadata_ready ? "已返回" : "未通过"}；该标记不是 /api/releasez 发布身份，全局生产发布状态尚未由本页核验。
      </Typography.Paragraph>
      <Alert
        type="warning"
        showIcon
        title="模型运行门禁不等于生产发布就绪"
        description={!fixtureData && displayStatus?.release_metadata_ready && displayStatus.state === "ready"
          ? "五模态运行状态均返回 ready，但这不是生产门禁通过。本响应没有 /api/releasez 的 release_id、git_sha、manifest_sha256 和 image_set_digest；全局发布身份未核验前，不得标记为生产通过。"
          : "中转站已配置不等于生产可用。模型运行门禁和全局 release evidence 必须分别通过；任一项缺失时生成与生产写入保持阻断。"}
      />
      <ModelReadinessTable status={displayStatus} />
      {modelError ? (
        <div ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive" aria-atomic="true">
          <Alert
            type="error"
            showIcon
            title="平台模型状态读取失败：状态不可用"
            description="当前状态不能视为配置完成。请重试读取平台模型状态；中转站未确认前，生成能力保持阻断。"
            action={(
              <Button type="primary" size="small" style={{ minHeight: 44 }} aria-label="重试加载平台模型状态" onClick={() => void model.load()}>
                重试
              </Button>
            )}
          />
        </div>
      ) : null}
      {!modelError ? (
        !modelStatus ? (
          <Alert
            type="info"
            role="status"
            aria-live="polite"
            showIcon
            title="平台模型状态不可用"
            description="请检查页面顶部错误并重试，当前状态不能视为配置完成。"
          />
        ) : modelStatus.next_actions.length ? (
          <Alert type="warning" showIcon title="模型上线门禁" description={modelStatus.next_actions.join("；")} />
        ) : modelStatus.state === "ready" ? (
          <Alert type="info" showIcon title="模型运行状态为 ready，生产发布身份未核验" description="请以 /api/releasez 的完整不可变发布身份和 ready=true 作为生产发布结论。" />
        ) : (
          <Alert type="warning" showIcon title="模型状态未达到就绪" description={`服务端模型状态为 ${modelStatus.state}，且未返回可执行的修复建议；不得按空建议推断为通过。`} />
        )
      ) : null}
      </> : null}
    </Card>
  );
}
