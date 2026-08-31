import type { ReactNode } from "react";
import { Space, Typography } from "antd";

interface OpsPageProps {
  eyebrow: string;
  title: string;
  description: string;
  nextStep?: string;
  children: ReactNode;
}

export function OpsPage({
  eyebrow,
  title,
  description,
  nextStep,
  children,
}: OpsPageProps) {
  const pageId = `ops-page-${eyebrow.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section className="ops-page" aria-labelledby={pageId} tabIndex={-1}>
      <header className="ops-page-heading">
        <Typography.Text className="eyebrow">{eyebrow}</Typography.Text>
        <Typography.Title id={pageId} level={3}>
          {title}
        </Typography.Title>
      <Typography.Paragraph type="secondary">
        {description}
      </Typography.Paragraph>
      {nextStep ? (
        <div className="ops-conversation-step" role="status" aria-live="polite">
          <Typography.Text strong>当前下一步</Typography.Text>
          <Typography.Text type="secondary">{nextStep}</Typography.Text>
        </div>
      ) : null}
      </header>
      <Space orientation="vertical" size={20} className="content-stack">
        {children}
      </Space>
    </section>
  );
}
