import JSZip from "jszip";
import { spreadsheetFactsToBatchProducts } from "../../../../../packages/application/src/spreadsheet-batch.js";

export function scopeManualProductsToStore(
  products: ReadonlyArray<Record<string, unknown>>,
  store: { platform: string; account_id: string; store_alias?: string | null },
): { products: Record<string, unknown>[]; mismatchedCount: number; assignedCount: number; confirmationCount: number } {
  let mismatchedCount = 0;
  let assignedCount = 0;
  let confirmationCount = 0;
  const scoped = products.map(product => {
    const platformMissing = product.platform == null || product.platform === "";
    const accountMissing = product.account_id == null || product.account_id === "";
    const fileStoreName = typeof product.store_name === "string" ? product.store_name.normalize("NFKC").trim() : "";
    const selectedStoreName = store.store_alias?.normalize("NFKC").trim() ?? "";
    if ((!platformMissing && product.platform !== store.platform)
      || (!accountMissing && product.account_id !== store.account_id)
      || (fileStoreName && selectedStoreName && fileStoreName !== selectedStoreName)) mismatchedCount++;
    if (platformMissing || accountMissing) assignedCount++;
    if (platformMissing || accountMissing || !fileStoreName || !selectedStoreName) confirmationCount++;
    return {
      ...product,
      ...(platformMissing ? { platform: store.platform } : {}),
      ...(accountMissing ? { account_id: store.account_id } : {}),
    };
  });
  return { products: scoped, mismatchedCount, assignedCount, confirmationCount };
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  if (cell || row.length) { row.push(cell); if (row.some(value => value.trim())) rows.push(row); }
  return rows;
}

function decodeXml(text: string): string {
  return text.replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/gu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, "&");
}

async function xlsxRows(bytes: Uint8Array): Promise<Record<string, string>[]> {
  const zip = await JSZip.loadAsync(bytes);
  const sharedXml = zip.file("xl/sharedStrings.xml") ? await zip.file("xl/sharedStrings.xml")!.async("text") : "";
  const shared = [...sharedXml.matchAll(/<(?:[\w.-]+:)?si\b[\s\S]*?<\/(?:[\w.-]+:)?si>/giu)]
    .map(match => decodeXml(match[0].replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim()));
  const sheet = Object.keys(zip.files).find(name => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name));
  if (!sheet) throw new Error("Excel 文件没有工作表");
  const xml = await zip.file(sheet)!.async("text");
  return [...xml.matchAll(/<(?:[\w.-]+:)?row\b[\s\S]*?<\/(?:[\w.-]+:)?row>/giu)].map(row => Object.fromEntries(
    [...row[0].matchAll(/<(?:[\w.-]+:)?c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/(?:[\w.-]+:)?c>/giu)].flatMap(cell => {
      const column = /\br="([A-Z]+)\d+"/u.exec(cell[1] ?? "")?.[1];
      if (!column) return [];
      const raw = /<(?:[\w.-]+:)?v>([\s\S]*?)<\/(?:[\w.-]+:)?v>/iu.exec(cell[2] ?? "")?.[1]
        ?? /<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/iu.exec(cell[2] ?? "")?.[1] ?? "";
      return [[column, /\bt="s"/u.test(cell[1] ?? "") ? shared[Number(raw)] ?? "" : decodeXml(raw)]];
    }),
  ));
}

export async function parseManualProductFile(file: File): Promise<{ products: Record<string, unknown>[]; sha256: string }> {
  if (!/\.(xlsx|csv)$/iu.test(file.name) || file.size > 10 * 1024 * 1024) throw new Error("请选择不超过 10MB 的 Excel 或 CSV 文件");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  let facts: Record<string, unknown>;
  if (/\.csv$/iu.test(file.name)) {
    const rows = csvRows(new TextDecoder().decode(bytes));
    const header = rows[0]?.map(value => value.normalize("NFKC").trim()) ?? [];
    facts = { format: "csv", rows: rows.map(values => Object.fromEntries(header.map((name, index) => [name || `column_${index + 1}`, values[index] ?? ""]))) };
  } else facts = { format: "xlsx", rows: await xlsxRows(bytes) };
  const products = spreadsheetFactsToBatchProducts(facts);
  if (products.length < 1 || products.length > 50) throw new Error("一次只能导入 1 至 50 个商品");
  return { products, sha256 };
}
