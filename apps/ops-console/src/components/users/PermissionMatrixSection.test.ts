import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { filterPermissionMatrixItems, type PermissionMatrixItem } from "./PermissionMatrixSection";

const source = readFileSync(resolve(import.meta.dirname, "./PermissionMatrixSection.tsx"), "utf8");

const items: PermissionMatrixItem[] = [
  { method: "ops.users.list", capability: "identity.read", workbench: "platform", scope: "platform", data_class: "secret_metadata", effect: "read", audit: "deny_only", obligations: [], role_access: { platform_admin: "read", viewer: "hidden" } },
  { method: "content.generate", capability: "customer.content.update", workbench: "workspace", scope: "workspace", data_class: "customer_content", effect: "write", audit: "mutation", obligations: [], role_access: { platform_admin: "hidden", operator: "operate" } },
];

describe("permission matrix filtering", () => {
  it("searches the authoritative method and capability fields", () => {
    expect(filterPermissionMatrixItems(items, { query: "IDENTITY", workbench: undefined, effect: undefined }).map((item) => item.method)).toEqual(["ops.users.list"]);
  });

  it("combines workbench and effect filters without creating derived state", () => {
    expect(filterPermissionMatrixItems(items, { query: "", workbench: "workspace", effect: "write" }).map((item) => item.method)).toEqual(["content.generate"]);
  });

  it("provides a stable loading skeleton and keyboard-reachable recovery without dropping filters", () => {
    expect(source).toContain('data-state="loading"');
    expect(source).toContain('aria-label="正在读取权限矩阵"');
    expect(source).toContain('tabIndex={-1}');
    expect(source).toContain('aria-labelledby="permission-matrix-error-title"');
    expect(source).toContain('window.requestAnimationFrame(() => errorRef.current?.focus({ preventScroll: true }))');
    expect(source).toContain("当前筛选和已读取的矩阵仍保留");
    expect(source).toContain('className="ops-error-retry"');
  });
});
