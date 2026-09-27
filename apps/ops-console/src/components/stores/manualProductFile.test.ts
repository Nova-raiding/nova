import { describe, expect, it } from "vitest";
import { parseManualProductFile } from "./manualProductFile.js";
import { productImportTemplate } from "./ProductSpreadsheetImport.js";

function file(name: string, bytes: Uint8Array) {
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as File;
}

describe("platform assisted product import file parsing", () => {
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
    expect(result.products[0]).toMatchObject({ platform: "jd", local_product_key: "JACKET-001", title: "女士防风冲锋衣" });
  });
});
