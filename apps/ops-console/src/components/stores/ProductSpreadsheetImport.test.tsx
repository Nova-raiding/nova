import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProductSpreadsheetImport, productImportAssetState, productImportNextStep, productImportTemplate } from './ProductSpreadsheetImport.js';
import { parseDocumentFacts } from '../../../../../packages/application/src/document-parser.js';
import { spreadsheetFactsToBatchProducts } from '../../../../../packages/application/src/spreadsheet-batch.js';

describe('product spreadsheet import', () => {
  it('creates a real XLSX template that the backend parses into one product with two SKUs', async () => {
    const file = await productImportTemplate();
    const facts = await parseDocumentFacts({ name: 'template.xlsx', mimeType: file.type, body: new Uint8Array(await file.arrayBuffer()) });
    const rows = spreadsheetFactsToBatchProducts(facts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ local_product_key: 'JACKET-001', sku_count: 2, skus: [{ id: 'JACKET-BLUE-M' }, { id: 'JACKET-BLUE-L' }] });
  });
  it('keeps platform scope out of arbitrary customer imports', () => {
    const html = renderToStaticMarkup(<ProductSpreadsheetImport platformScope canWrite workspaceId="" />);
    expect(html).toContain('对应客户的授权工作区');
    expect(html).toContain('下载 Excel 模板');
    expect(html).toContain('disabled');
  });
  it('shows the actual workspace and permission denial without an enabled import action', () => {
    const html = renderToStaticMarkup(<ProductSpreadsheetImport platformScope={false} canWrite={false} workspaceId="ws_customer" />);
    expect(html).toContain('ws_customer');
    expect(html).toContain('没有商品导入权限');
    const upload = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)].find((button) => button[2]?.includes('上传商品表格'));
    expect(upload).toBeDefined();
    expect(upload?.[1]).toContain('disabled');
  });
  it('allows authorized workspace import before connecting a store without promising platform writes', () => {
    const html = renderToStaticMarkup(<ProductSpreadsheetImport platformScope={false} canWrite workspaceId="ws_customer" />);

    expect(html).toContain('导入商品资料无需先连接店铺');
    expect(html).toContain('仅导入当前已授权工作区，可先预览草稿');
    expect(html).toContain('真实平台同步和发布仍需连接对应店铺，并具备相应操作权限');
    expect(html).not.toContain('没有商品导入权限');
    const upload = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)].find((button) => button[2]?.includes('上传商品表格'));
    expect(upload).toBeDefined();
    expect(upload?.[1]).not.toContain('disabled');
  });
  it('distinguishes blocked, failed, pending, and completed scan or parse states', () => {
    expect(productImportAssetState({ id: 'a', scanStatus: 'blocked' })).toBe('scan_blocked');
    expect(productImportAssetState({ id: 'a', scanStatus: 'failed' })).toBe('scan_failed');
    expect(productImportAssetState({ id: 'a', scanStatus: 'quarantined' })).toBe('scan_pending');
    expect(productImportAssetState({ id: 'a', scanStatus: 'unscanned' })).toBe('parse_pending');
    expect(productImportAssetState({ id: 'a', scanStatus: 'unscanned', parseStatus: 'succeeded', extractedFacts: { products: [] } })).toBe('parse_ready');
    expect(productImportAssetState({ id: 'a', scanStatus: 'clean', parseStatus: 'failed' })).toBe('parse_failed');
    expect(productImportAssetState({ id: 'a', scanStatus: 'clean', parseStatus: 'succeeded' })).toBe('parse_incomplete');
    expect(productImportAssetState({ id: 'a', scanStatus: 'clean', parseStatus: 'processing' })).toBe('parse_processing');
  });
  it('gives users a workspace-aware plugin handoff without claiming binding was verified', () => {
    const next = productImportNextStep('ws_customer', ['product_1', 'product_2']);
    expect(next.binding).toContain('无法验证插件是否已绑定');
    expect(next.context).toContain('ws_customer');
    expect(next.prompt).toContain('product_1、product_2');
  });
});
