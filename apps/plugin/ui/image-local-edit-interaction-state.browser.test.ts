import { readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

declare global {
  interface Window {
    __toolCalls: number;
    __resolveTool?: (value: unknown) => void;
  }
}

const html = readFileSync(new URL('./image-local-edit.html', import.meta.url), 'utf8');
let browser: Browser;

async function openEditor(options: { sourceId?: string; pendingTool?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  const hostMock = `<script>
    window.__toolCalls=0;
    window.openai={callTool:async()=>{
      window.__toolCalls++;
      ${options.pendingTool ? 'return new Promise(resolve=>{window.__resolveTool=resolve})' : 'return {structuredContent:{id:"candidate-interaction-1"}}'}
    }};
  </script>`;
  await page.setContent(html.replace('<script>', `${hostMock}<script>`));
  await page.evaluate((sourceId) => {
    for (const [id, value] of Object.entries({
      sourceId,
      imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
      prompt: '只调整背景颜色',
      productId: 'product-local-1',
    })) {
      (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value = value;
    }
    (document.querySelector('details') as HTMLDetailsElement).open = true;
  }, options.sourceId ?? 'asset-local-1');
  return page;
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe('图片局部编辑提交与错误交互状态', () => {
  it('Host 请求未完成时锁定编辑区，方向键不会改区域或重新启用提交', async () => {
    const page = await openEditor({ pendingTool: true });
    try {
      await page.locator('#submit').click();
      await page.waitForFunction(() => window.__toolCalls === 1);
      await expect(page.locator('#submit')).toBeDisabled();
      await expect(page.locator('#submit')).toHaveText('正在创建候选…');

      await page.locator('#selection').focus();
      await page.keyboard.press('ArrowRight');

      await expect(page.locator('#rectX')).toHaveValue('0.350');
      await expect(page.locator('#submit')).toBeDisabled();
      expect(await page.evaluate(() => window.__toolCalls)).toBe(1);
      await page.evaluate(() => window.__resolveTool?.({ structuredContent: { id: 'candidate-interaction-1' } }));
      await expect(page.locator('#candidate')).toHaveClass(/show/u);
    } finally {
      await page.close();
    }
  }, 15_000);

  it('字段修正后清除对应的旧表单警告', async () => {
    const page = await openEditor({ sourceId: '' });
    try {
      await page.locator('#submit').click();
      await expect(page.locator('#formError')).toBeVisible();
      await expect(page.locator('#sourceId')).toHaveAttribute('aria-invalid', 'true');

      await page.locator('#sourceId').fill('asset-local-1');

      await expect(page.locator('#sourceId')).not.toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#formError')).toBeHidden();
      expect(await page.evaluate(() => window.__toolCalls)).toBe(0);
    } finally {
      await page.close();
    }
  }, 15_000);
});
