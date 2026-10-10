import type { StoreDirectory } from "../../types/ops.js";

export function storeRevocationCopy(store: Pick<StoreDirectory, "state" | "dataMode" | "label">) {
  if (store.state === "revoked") {
    return {
      actionLabel: "已撤销",
      dialogTitle: "授权已撤销",
      confirmLabel: "已撤销",
      description: `${store.label || "该店铺"}的授权已撤销。若需继续使用，请重新授权。`,
      errorTitle: "撤销授权失败",
      errorFallback: "撤销授权失败，请检查权限和网络后重试。",
      successMessage: "店铺授权已撤销",
    };
  }
  if (store.state === "manually_registered") {
    return {
      actionLabel: "撤销登记",
      dialogTitle: "确认撤销人工登记？",
      confirmLabel: "确认撤销登记",
      description: `将把${store.label || "该店铺"}的人工登记标记为已撤销。此记录不包含平台凭证，不会向平台发送撤销请求；账号记录和审计事件仍会保留。`,
      errorTitle: "人工登记撤销失败",
      errorFallback: "撤销人工登记失败，请检查权限和网络后重试。",
      successMessage: "人工店铺登记已撤销",
    };
  }
  return {
    actionLabel: "撤销",
    dialogTitle: "确认撤销平台授权？",
    confirmLabel: "确认撤销",
    description: `将撤销${store.label || "该店铺"}的平台授权，后续同步和发布会停止；如需继续使用，必须重新授权。该操作会写入审计记录。`,
    errorTitle: "撤销授权失败",
    errorFallback: "撤销授权失败，请检查权限和网络后重试。",
    successMessage: "店铺授权已撤销",
  };
}
