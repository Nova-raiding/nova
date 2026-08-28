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
        onFinishFailed={({ errorFields }) => {
          const first = errorFields[0]?.name;
          if (first) competitorForm.scrollToField(first, { block: "center", focus: true });
        }}
        disabled={!canCompetitor}
        style={{ marginBottom: 16 }}
        aria-label="录入竞品参考"
      >
        <Form.Item name="competitorName" label="竞品名称" rules={[{ required: true, message: "请输入竞品名称" }]}> 
          <Input placeholder="竞品名称" />
        </Form.Item>
        <Form.Item name="sourceJson" label="公开来源" rules={[{ required: true, message: "请输入公开来源 JSON" }]}> 
          <Input placeholder="来源 JSON" />
        </Form.Item>
        <Form.Item name="summary" label="公开摘要" rules={[{ required: true, message: "请输入公开信息摘要" }]}> 
          <Input placeholder="公开信息摘要" />
        </Form.Item>
        <Form.Item name="structureJson" label="结构观察" rules={[{ required: true, message: "请输入结构观察 JSON" }]}> 
          <Input placeholder="结构观察 JSON" />
        </Form.Item>
        <Form.Item name="sellingPointsJson" label="卖点观察" rules={[{ required: true, message: "请输入卖点观察 JSON" }]}> 
          <Input placeholder="卖点观察 JSON" />
        </Form.Item>
        <Form.Item name="expressionJson" label="表达观察" rules={[{ required: true, message: "请输入表达观察 JSON" }]}> 
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
