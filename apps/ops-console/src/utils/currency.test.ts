import { describe, expect, it } from "vitest";
import { fenToYuan, yuanToFen } from "./currency.js";

describe("currency input helpers", () => {
  it("converts yuan to integer fen without floating point drift", () => {
    expect(yuanToFen("2000.00")).toBe(200000);
    expect(yuanToFen(19.99)).toBe(1999);
  });

  it("converts fen to display yuan", () => {
    expect(fenToYuan(200000)).toBe(2000);
    expect(fenToYuan("199")).toBe(1.99);
  });

  it("rejects negative and non-numeric yuan input", () => {
    expect(() => yuanToFen(-1)).toThrow("金额必须是非负数字");
    expect(() => yuanToFen("not-a-number")).toThrow("金额必须是非负数字");
  });
});
