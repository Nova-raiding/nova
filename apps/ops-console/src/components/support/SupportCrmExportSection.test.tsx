import { describe, expect, it } from "vitest";
import { csvCell } from "./SupportCrmExportSection.js";

describe("SupportCrmExportSection", () => {
  it("quotes CSV data and neutralizes spreadsheet formulas", () => {
    expect(csvCell('云朵"商家')).toBe('"云朵""商家"');
    expect(csvCell("=HYPERLINK(\"https://evil.test\")")).toBe('"\'=HYPERLINK(""https://evil.test"")"');
    expect(csvCell("  +1")).toBe('"\'  +1"');
    expect(csvCell("normal@example.test")).toBe('"normal@example.test"');
  });
});
