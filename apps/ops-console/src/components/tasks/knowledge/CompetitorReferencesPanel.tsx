import { Alert, Button, Card, Col, Form, Input, Row, Table, Tag, Typography } from "antd";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import type { CompetitorAnalysis } from "../../../types/ops";

interface CompetitorReferencesPanelProps {
  model: OpsConsoleModel;
}

export function CompetitorReferencesPanel({
  model,
}: CompetitorReferencesPanelProps) {
  const { canCompetitor, competitorForm, competitors, createCompetitor } =
    model;

  return (
    <>
      <Alert
        type="info"
        showIcon
        message="只录入公开、可追溯的竞品观察"
        description="分析结果只能用于结构、主题和趋势参考。请勿粘贴竞品原文、未验证商品事实或受保护素材；提交后仍会经过发布前合规审核。"
        style={{ marginBottom: 16 }}
      />
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        新增竞品参考
      </Typography.Title>
      <Form
        form={competitorForm}
        onFinish={createCompetitor}
        onFinishFailed={({ errorFields }) => {
          const first = errorFields[0]?.name;
          if (first) competitorForm.scrollToField(first, { block: "center", focus: true });
        }}
        disabled={!canCompetitor}
        layout="vertical"
        aria-label="录入竞品参考"
      >
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="competitorName" label="竞品名称" rules={[{ required: true, message: "请输入竞品名称" }]}>
              <Input placeholder="例如：某品牌旗舰店" />
            </Form.Item>
          </Col>
          <Col span={16}>
            <Row gutter={8}>
              <Col span={14}>
                <Form.Item name="sourceUrl" label="公开来源 URL" rules={[{ required: true, type: "url", message: "请输入有效的公开链接" }]}>
                  <Input placeholder="https://example.com/product" />
                </Form.Item>
              </Col>
              <Col span={10}>
                <Form.Item name="sourceTitle" label="页面标题" rules={[{ required: true, message: "请输入页面标题" }]}>
                  <Input placeholder="页面标题" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="accessedAt" label="访问时间" extra="默认使用当前时间，便于审计来源是否新鲜" rules={[{ required: true, message: "请输入访问时间" }]}>
              <Input placeholder="2026-09-03T10:00:00Z" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="summary" label="公开信息摘要" extra="只填写自己的概括，不要复制页面原文" rules={[{ required: true, message: "请输入公开信息摘要" }]}>
          <Input.TextArea rows={3} placeholder="概括竞品公开页面中的定位、场景和可观察趋势" />
        </Form.Item>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="structureJson" label="结构观察 JSON" extra='例如：{"sections":["核心卖点","使用场景"],"layout":["图文交替"]}' rules={[{ required: true, message: "请输入结构观察" }]}>
              <Input.TextArea rows={3} placeholder='{"sections":[],"layout":[]}' />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="sellingPointsJson" label="卖点观察 JSON" extra="数组中的内容请使用自己的概括" rules={[{ required: true, message: "请输入卖点观察" }]}>
              <Input.TextArea rows={3} placeholder='["场景化展示","售后承诺"]' />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="expressionJson" label="表达观察 JSON" extra='例如：{"tone":["专业"],"formats":["对比"]}' rules={[{ required: true, message: "请输入表达观察" }]}>
              <Input.TextArea rows={3} placeholder='{"tone":[],"formats":[]}' />
            </Form.Item>
          </Col>
        </Row>
        <Button disabled={!canCompetitor} type="primary" htmlType="submit">
          保存竞品参考
        </Button>
      </Form>
      <Typography.Title level={5} style={{ margin: "24px 0 12px" }}>
        已录入参考
      </Typography.Title>
      <Table
        rowKey="id"
        pagination={{ pageSize: 6 }}
        dataSource={competitors}
        locale={{ emptyText: "尚无合规竞品参考；只能录入可追溯的公开来源" }}
        scroll={{ x: 720 }}
        columns={[
          { title: "竞品", dataIndex: "competitorName" },
          {
            title: "来源",
            render: (_: unknown, row: CompetitorAnalysis) => (
              <a href={row.source.url} target="_blank" rel="noreferrer">
                {row.source.title}
              </a>
            ),
          },
          {
            title: "合规边界",
            render: () => <Tag color="blue">仅差异化参考</Tag>,
          },
          {
            title: "卖点观察",
            render: (_: unknown, row: CompetitorAnalysis) =>
              row.sellingPoints.join("、") || "-",
          },
        ]}
      />
    </>
  );
}
