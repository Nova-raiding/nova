import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProductSpreadsheetImport, productImportAssetState, productImportBatchParams, productImportNextStep, productImportTemplate } from './ProductSpreadsheetImport.js';
import { parseDocumentFacts } from '../../../../../packages/application/src/document-parser.js';
import { spreadsheetFactsToBatchProducts } from '../../../../../packages/application/src/spreadsheet-batch.js';
import JSZip from 'jszip';

describe('product spreadsheet import', () => {
  it('creates a real XLSX template with a sourced SKU example and field requirements', async () => {
    const file = await productImportTemplate();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const facts = await parseDocumentFacts({ name: 'template.xlsx', mimeType: file.type, body: bytes });
    expect(Array.isArray(facts.rows) ? facts.rows[0] : undefined).toMatchObject({ O: '平台商品ID', R: '商品图片', U: '品牌', AD: '卖点3来源ID' });
    expect(Object.keys((facts.rows as Record<string, unknown>[])[0] ?? {})).toHaveLength(30);
    expect(Object.keys((facts.rows as Record<string, unknown>[])[1] ?? {})).toHaveLength(30);
    const rows = spreadsheetFactsToBatchProducts(facts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: 'jd', remote_id: '10137064435110', sku_count: 1, skus: [{ id: '10137064435110', price: 399.2, stock: 99 }] });
    const zip = await JSZip.loadAsync(bytes);
    const guide = await zip.file('xl/worksheets/sheet2.xml')?.async('text');
    expect(guide).toContain('必填');
    expect(guide).toContain('有SKU时必填');
    expect(guide).toContain('选填');
    expect(guide).toContain('价格和库存');
    expect(guide).toContain('未从京东页面独立核验');
    expect(guide?.match(/<row r=/gu)).toHaveLength(38);
  });
  it('keeps platform scope out of arbitrary customer imports', () => {
    const html = renderToStaticMarkup(<ProductSpreadsheetImport platformScope canWrite workspaceId="" />);
    expect(html).toContain('运营代商家上传商品请到“平台连接汇总”');
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
    expect(productImportBatchParams('asset-1', [{ title: '商品' }]).params).toEqual({ source_asset_id: 'asset-1', draft_only: 'true' });
    expect(productImportBatchParams('asset-1', [{ title: '商品', account_id: 'store-1' }]).params).toEqual({ source_asset_id: 'asset-1' });
    expect(() => productImportBatchParams('asset-1', [{ title: '店铺商品', account_id: 'store-1' }, { title: '草稿商品' }])).toThrow('同一批次不能混合');
  });
  it('only allows parsing after a clean scan and blocks unscanned, failed, or quarantined assets', () => {
    expect(productImportAssetState({ id: 'a', scanStatus: 'blocked' })).toBe('scan_blocked');
    expect(productImportAssetState({ id: 'a', scanStatus: 'failed' })).toBe('scan_failed');
    expect(productImportAssetState({ id: 'a', scanStatus: 'quarantined' })).toBe('scan_pending');
    expect(productImportAssetState({ id: 'a', scanStatus: 'unscanned' })).toBe('scan_pending');
    expect(productImportAssetState({ id: 'a', scanStatus: 'unscanned', parseStatus: 'succeeded', extractedFacts: { products: [] } })).toBe('scan_pending');
    expect(productImportAssetState({ id: 'a', scanStatus: 'clean' })).toBe('parse_pending');
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
