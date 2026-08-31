import { describe, expect, it } from "vitest";
import { filterPermissionMatrixItems, type PermissionMatrixItem } from "./PermissionMatrixSection";

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
});
