import type { ReactNode } from "react";
import { Space, Typography } from "antd";

interface OpsPageProps {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}

export function OpsPage({
  eyebrow,
  title,
  description,
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
      </header>
      <Space orientation="vertical" size={20} className="content-stack">
        {children}
      </Space>
    </section>
  );
}
