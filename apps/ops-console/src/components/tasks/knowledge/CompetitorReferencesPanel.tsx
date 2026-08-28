import { Button, Form, Input, Table, Tag } from "antd";
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
      <Form
        form={competitorForm}
        layout="inline"
        onFinish={createCompetitor}
        disabled={!canCompetitor}
        style={{ marginBottom: 16 }}
      >
        <Form.Item name="competitorName" rules={[{ required: true }]}>
          <Input placeholder="竞品名称" />
        </Form.Item>
        <Form.Item name="sourceJson" rules={[{ required: true }]}>
          <Input placeholder="来源 JSON" />
        </Form.Item>
        <Form.Item name="summary" rules={[{ required: true }]}>
          <Input placeholder="公开信息摘要" />
        </Form.Item>
        <Form.Item name="structureJson" rules={[{ required: true }]}>
          <Input placeholder="结构观察 JSON" />
        </Form.Item>
        <Form.Item name="sellingPointsJson" rules={[{ required: true }]}>
          <Input placeholder="卖点观察 JSON" />
        </Form.Item>
        <Form.Item name="expressionJson" rules={[{ required: true }]}>
          <Input placeholder="表达观察 JSON" />
        </Form.Item>
        <Button disabled={!canCompetitor} type="primary" htmlType="submit">
          录入竞品参考
        </Button>
      </Form>
      <Table
        rowKey="id"
        pagination={{ pageSize: 6 }}
        dataSource={competitors}
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
