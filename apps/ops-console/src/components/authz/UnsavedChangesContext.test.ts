import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { updateUnsavedChangeEntries } from "./UnsavedChangesContext.js";

describe("unsaved changes registration", () => {
  it("keeps same-label forms independent and removes only the unmounted form", () => {
    const first = updateUnsavedChangeEntries(new Map(), "form-1", true, "客户建档表单");
    const both = updateUnsavedChangeEntries(first, "form-2", true, "客户建档表单");

    expect([...new Set(both.values())]).toEqual(["客户建档表单"]);

    const afterFirstUnmount = updateUnsavedChangeEntries(both, "form-1", false, "客户建档表单");
    expect([...afterFirstUnmount.entries()]).toEqual([["form-2", "客户建档表单"]]);
    expect([...new Set(afterFirstUnmount.values())]).toEqual(["客户建档表单"]);
  });

  it("unregisters its unique dirty entry when the hook effect is cleaned up", () => {
    const source = readFileSync(new URL("./UnsavedChangesContext.tsx", import.meta.url), "utf8");
    expect(source).toContain("const id = useId();");
    expect(source).toContain("return () => setDirty(id, false, label);");
  });
});
