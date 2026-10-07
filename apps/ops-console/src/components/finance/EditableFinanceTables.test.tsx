import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("antd", () => ({
  Button: ({ children, disabled }: any) => createElement("button", { disabled }, children),
  InputNumber: ({ disabled, value }: any) => createElement("input", { type: "number", disabled, value }),
  Switch: ({ disabled, checked }: any) => createElement("input", { type: "checkbox", disabled, checked, readOnly: true }),
  Table: ({ dataSource, columns }: any) => createElement("table", null, dataSource.map((row: any) => createElement("tr", { key: row.id ?? row.code }, columns.map((column: any) => createElement("td", { key: column.title ?? column.dataIndex }, column.render ? column.render(row[column.dataIndex], row) : row[column.dataIndex])))),),
}));

import { CouponTable } from "./CouponTable.js";
import { RolloutTable } from "./RolloutTable.js";

const baseModel = (overrides: any = {}): any => ({
  rollouts: [{ id: "rollout-1", offerCode: "starter", workspaceId: "workspace-1", percentage: 25, enabled: true }],
  coupons: [{ code: "WELCOME", discountType: "percentage", discountValue: 10, maxRedemptions: 100, redeemedCount: 2 }],
  setRollouts: vi.fn(),
  setCoupons: vi.fn(),
  saveRollout: vi.fn(),
  saveCoupon: vi.fn(),
  canPlatformOps: false,
  canGlobalCommercial: false,
  ...overrides,
});

describe("editable finance tables", () => {
  it("keeps rollout controls and save action disabled without platform ops permission", () => {
    const html = renderToStaticMarkup(<RolloutTable model={baseModel()} />);
    expect(html).toContain("starter");
    expect(html).toContain("Workspace ID：workspace-1");
    expect(html).toContain('type="number"');
    expect(html).toContain('type="checkbox"');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3);
  });

  it("enables coupon editing only for the global commercial capability", () => {
    const html = renderToStaticMarkup(<CouponTable model={baseModel({ canGlobalCommercial: true })} />);
    expect(html).toContain("WELCOME");
    expect(html).toContain("percentage");
    expect(html).toContain('value="10"');
    expect(html).toContain('value="100"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("保存");
  });
});
