import { describe, expect, it } from "vitest";
import { opsPublicAsset } from "./assets.js";

describe("ops public asset paths", () => {
  it("keeps assets under the configured Vite base", () => {
    expect(opsPublicAsset("assets/store-nova-primary-horizontal.png", "/ops/"))
      .toBe("/ops/assets/store-nova-primary-horizontal.png");
    expect(opsPublicAsset("/assets/store-nova-primary-horizontal.png", "/ops"))
      .toBe("/ops/assets/store-nova-primary-horizontal.png");
  });
});
