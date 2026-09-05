import { useEffect, useRef, type ReactNode } from "react";
import { Space } from "antd";
import { PageHeader } from "./PageHeader.js";

interface OpsPageProps {
  eyebrow: string;
  title: string;
  description: string;
  nextStep?: string;
  actions?: ReactNode;
  headingLevel?: 1 | 2 | 3 | 4 | 5;
  children: ReactNode;
}

export function OpsPage({
  eyebrow,
  title,
  description,
  nextStep,
  actions,
  headingLevel = 3,
  children,
}: OpsPageProps) {
  const pageId = `ops-page-${eyebrow.toLowerCase().replaceAll(" ", "-")}`;
  const descriptionId = `${pageId}-description`;
  const pageRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Route pages are lazy-mounted in the workbench. Move focus to the
    // stable page landmark so keyboard and screen-reader operators do not
    // remain on the previous route's control after navigation.
    pageRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section ref={pageRef} className="ops-page" aria-labelledby={pageId} aria-describedby={descriptionId} tabIndex={-1}>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        nextStep={nextStep}
        actions={actions}
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
