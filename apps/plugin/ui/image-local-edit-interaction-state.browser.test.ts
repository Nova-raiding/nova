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
      expect(await page.locator('#submit').isDisabled()).toBe(true);
      expect(await page.locator('#submit').innerText()).toBe('正在创建候选…');

      await expect(page.locator('#stage')).toHaveAttribute('aria-disabled', 'true');
      expect(await page.locator('#stage').evaluate((stage) => (stage as HTMLElement).inert)).toBe(true);
      await page.locator('#selection').dispatchEvent('keydown', { key: 'ArrowRight' });

      expect(await page.locator('#rectX').inputValue()).toBe('0.350');
      expect(await page.locator('#submit').isDisabled()).toBe(true);
      expect(await page.evaluate(() => window.__toolCalls)).toBe(1);
      await page.evaluate(() => window.__resolveTool?.({ structuredContent: { id: 'candidate-interaction-1' } }));
      expect((await page.locator('#candidate').getAttribute('class')) ?? '').toMatch(/show/u);
    } finally {
      await page.close();
    }
  }, 15_000);

  it('字段修正后清除对应的旧表单警告', async () => {
    const page = await openEditor({ sourceId: '' });
    try {
      await page.locator('#submit').click();
      expect(await page.locator('#formError').isVisible()).toBe(true);
      expect(await page.locator('#sourceId').getAttribute('aria-invalid')).toBe('true');

      await page.locator('#sourceId').fill('asset-local-1');

      expect(await page.locator('#sourceId').getAttribute('aria-invalid')).not.toBe('true');
      expect(await page.locator('#formError').isVisible()).toBe(false);
      expect(await page.evaluate(() => window.__toolCalls)).toBe(0);
    } finally {
      await page.close();
    }
  }, 15_000);
});
