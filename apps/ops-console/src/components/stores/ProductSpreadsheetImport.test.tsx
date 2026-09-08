import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProductSpreadsheetImport, productImportTemplate } from './ProductSpreadsheetImport.js';
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
  });
});
