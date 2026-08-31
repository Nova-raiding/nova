import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./BrandTreeSection.tsx", import.meta.url), "utf8");

describe("brand tree interaction contract", () => {
  it("keeps create and bind false responses visible as recoverable alerts", () => {
    expect(source).toContain("请求未完成，品牌尚未创建；请检查权限或稍后重试");
    expect(source).toContain("请求未完成，店铺尚未绑定；请检查权限、店铺状态或版本后重试");
    expect(source).toContain('<Alert role="alert" type="error"');
    expect(source).toContain('aria-label="品牌名称"');
    expect(source).toContain("aria-label={`${brand.title}待绑定店铺`}");
  });
});
