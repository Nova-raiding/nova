import type { ReactNode } from "react";
import { Typography } from "antd";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  nextStep?: string;
  headingLevel?: 1 | 2 | 3 | 4 | 5;
  headingId: string;
  descriptionId: string;
  actions?: ReactNode;
}

/**
 * Shared desktop page heading for the operations workbench.
 *
 * The heading and description IDs are supplied by the page shell so the
 * focus target remains stable across lazy route changes. Status guidance is
 * deliberately a polite live region: it explains the next action without
 * stealing focus from the page's primary work.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  nextStep,
  headingLevel = 1,
  headingId,
  descriptionId,
  actions,
}: PageHeaderProps) {
  return (
    <header className="ops-page-heading">
      <div className="ops-page-heading-main">
        <Typography.Text className="eyebrow">{eyebrow}</Typography.Text>
        <Typography.Title id={headingId} level={headingLevel}>
          {title}
        </Typography.Title>
        <Typography.Paragraph id={descriptionId} type="secondary">
          {description}
        </Typography.Paragraph>
      </div>
      {actions ? <div className="ops-page-heading-actions">{actions}</div> : null}
      {nextStep ? (
        <div className="ops-conversation-step" role="status" aria-live="polite">
          <Typography.Text strong>当前下一步</Typography.Text>
          <Typography.Text type="secondary">{nextStep}</Typography.Text>
        </div>
      ) : null}
    </header>
  );
}
