import { useEffect, useRef, type ReactNode } from "react";
import { Space, Typography } from "antd";

interface OpsPageProps {
  eyebrow?: string;
  title: string;
  description?: string;
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
  headingLevel = 1,
  children,
}: OpsPageProps) {
  const pageRef = useRef<HTMLElement>(null);
  const HeadingTag = `h${headingLevel}` as const;

  useEffect(() => {
    // Route pages are lazy-mounted in the workbench. Move focus to the
    // stable page landmark so keyboard and screen-reader operators do not
    // remain on the previous route's control after navigation.
    pageRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      ref={pageRef}
      className="ops-page"
      aria-label={title}
      tabIndex={-1}
    >
      <Space orientation="vertical" size={20} className="content-stack">
        <header className="ops-page-header">
          <div className="ops-page-heading">
            {eyebrow ? <Typography.Text className="ops-page-eyebrow">{eyebrow}</Typography.Text> : null}
            <HeadingTag className="ops-page-title">{title}</HeadingTag>
            {description ? <Typography.Paragraph className="ops-page-description">{description}</Typography.Paragraph> : null}
            {nextStep ? <Typography.Text className="ops-page-next-step">{nextStep}</Typography.Text> : null}
          </div>
          {actions ? <div className="ops-page-actions">{actions}</div> : null}
        </header>
        {children}
      </Space>
    </section>
  );
}
