import type { ReactNode } from "react";
import { Space } from "antd";
import { PageHeader } from "./PageHeader.js";

interface OpsPageProps {
  eyebrow: string;
  title: string;
  description: string;
  nextStep?: string;
  headingLevel?: 1 | 2 | 3 | 4 | 5;
  children: ReactNode;
}

export function OpsPage({
  eyebrow,
  title,
  description,
  nextStep,
  headingLevel = 3,
  children,
}: OpsPageProps) {
  const pageId = `ops-page-${eyebrow.toLowerCase().replaceAll(" ", "-")}`;
  const descriptionId = `${pageId}-description`;
  return (
    <section className="ops-page" aria-labelledby={pageId} aria-describedby={descriptionId} tabIndex={-1}>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        nextStep={nextStep}
        headingLevel={headingLevel}
        headingId={pageId}
        descriptionId={descriptionId}
      />
      <Space orientation="vertical" size={20} className="content-stack">
        {children}
      </Space>
    </section>
  );
}
