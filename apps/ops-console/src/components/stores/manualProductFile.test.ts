import { describe, expect, it } from "vitest";
import { parseManualProductFile, scopeManualProductsToStore } from "./manualProductFile.js";
import { productImportTemplate } from "./ProductSpreadsheetImport.js";

function file(name: string, bytes: Uint8Array) {
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as File;
}

describe("platform assisted product import file parsing", () => {
  it("uses the explicitly selected manual store when the source omits its account, while rejecting conflicting scope", () => {
    const store = { platform: "jd", account_id: "store_qa", store_alias: "贵人鸟官方旗舰店" };
    const missing = scopeManualProductsToStore([{ platform: "jd", title: "QA item" }], store);
    expect(missing).toMatchObject({ products: [{ platform: "jd", account_id: "store_qa", title: "QA item" }], assignedCount: 1, confirmationCount: 1, mismatchedCount: 0 });
    expect(scopeManualProductsToStore([{ platform: "taobao", account_id: "other" }], store)).toMatchObject({ assignedCount: 0, mismatchedCount: 1 });
    expect(scopeManualProductsToStore([{ platform: "jd", store_name: "贵人鸟母婴旗舰店" }], store)).toMatchObject({ assignedCount: 1, mismatchedCount: 1 });
    expect(scopeManualProductsToStore([{ platform: "jd", account_id: "store_qa", store_name: "贵人鸟官方旗舰店" }], store)).toMatchObject({ assignedCount: 0, confirmationCount: 0, mismatchedCount: 0 });
  });
  it("previews CSV with quoted fields and hashes the actual bytes", async () => {
    const bytes = new TextEncoder().encode('平台,店铺账号,商品货号,商品名称,价格,库存\n京东,store_qa,QA-001,"跑鞋, 男款",199,3\n');
    const result = await parseManualProductFile(file("products.csv", bytes));
    expect(result.products).toMatchObject([{ platform: "jd", account_id: "store_qa", local_product_key: "QA-001", title: "跑鞋, 男款", price: 199, stock: 3 }]);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reads the downloadable Excel template", async () => {
    const blob = await productImportTemplate();
    const result = await parseManualProductFile(file("template.xlsx", new Uint8Array(await blob.arrayBuffer())));
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({ platform: "jd", remote_id: "10137064435110", skus: [{ id: "10137064435110", price: 399.2, stock: 99 }] });
  });
});
