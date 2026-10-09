import type { SupportTicketStatus } from "../../../../../packages/contracts/src/ops/support.js";

export const supportStatusLabels: Record<SupportTicketStatus, string> = {
  open: "待处理",
  in_progress: "处理中",
  waiting_customer: "等待客户",
  resolved: "已解决",
  closed: "已关闭",
};
