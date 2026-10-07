import { describe, expect, it } from "vitest";
import { encodeBenefits, type BenefitEditorValue } from "./RegisteredBenefitFields.js";

const benefit = (overrides: Partial<BenefitEditorValue> = {}): BenefitEditorValue => ({
  code: "task_quota",
  value: 30,
  unit: "task",
  policyRef: "policy-1",
  ...overrides,
});

describe("encodeBenefits", () => {
  it("normalizes registered benefits while retaining prior metadata", () => {
    const encoded = encodeBenefits(
      [benefit(), benefit({ code: "cloud_storage", value: 1024, unit: "byte" })],
      [{ code: "task_quota", metadata: { source: "approved-package" } }],
    );
    expect(encoded).toEqual([
      {
        code: "task_quota",
        quantity: 30,
        rawValue: null,
        rawUnit: "task",
        normalizedValue: null,
        policyRef: "policy-1",
        metadata: { source: "approved-package" },
      },
      {
        code: "cloud_storage",
        quantity: 1024,
        rawValue: null,
        rawUnit: "byte",
        normalizedValue: 1024,
        policyRef: "policy-1",
        metadata: {},
      },
    ]);
  });

  it("rejects ambiguous or unsafe benefit values before persistence", () => {
    expect(() => encodeBenefits([benefit(), benefit()])).toThrow("同一权益不可重复配置");
    expect(() => encodeBenefits([benefit({ value: 1.5 })])).toThrow("非负整数");
    expect(() => encodeBenefits([benefit({ code: "cloud_storage", unit: "GB" })])).toThrow("规范字节数");
    expect(() => encodeBenefits([benefit({ code: "feature.video", value: 2, unit: "boolean" })])).toThrow("只允许未授权0或授权1");
  });

  it("treats omitted editor collections as an empty draft", () => {
    expect(encodeBenefits()).toEqual([]);
  });
});
