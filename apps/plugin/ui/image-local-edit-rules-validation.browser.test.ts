import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserServer, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const html = await readFile(new URL('./image-local-edit.html', import.meta.url), 'utf8');
let browser: Browser;
let browserServer: BrowserServer | undefined;

async function openEditor(): Promise<Page> {
  const page = await browser.newPage();
  const mock = '<script>window.openai={callTool:async()=>{window.__toolCalls=(window.__toolCalls||0)+1;return {}}};</script>';
  await page.setContent(html.replace('<script>', `${mock}<script>`));
  await page.evaluate(() => {
    for (const [id, value] of Object.entries({
      sourceId: 'asset-local-1',
      imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
      prompt: '只调整背景颜色',
      productId: 'product-local-1',
    })) {
      (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value = value;
    }
    (document.getElementById('rulesJson') as HTMLTextAreaElement).value = '{invalid';
    (document.querySelector('details') as HTMLDetailsElement).open = true;
  });
  return page;
}

beforeAll(async () => {
  browserServer = await chromium.launchServer({ headless: true });
  browser = await chromium.connect(browserServer.wsEndpoint());
});

afterAll(async () => {
  await browser?.close();
  await browserServer?.close();
});

describe('图片局部编辑表单输入边界', () => {
  it('规则快照 JSON 损坏时聚焦错误字段且不调用 MCP Host', async () => {
    const page = await openEditor();
    try {
      await page.locator('#submit').click();

      expect(await page.locator('#formError').isVisible()).toBe(true);
      expect(await page.locator('#rulesJson').getAttribute('aria-invalid')).toBe('true');
      expect(await page.locator('#rulesJson').evaluate((field) => field === document.activeElement)).toBe(true);
      expect(await page.locator('#formError').textContent()).toContain('规则快照 JSON');
      expect(await page.evaluate(() => (window as Window & { __toolCalls?: number }).__toolCalls ?? 0)).toBe(0);
    } finally {
      await page.close();
    }
  }, 20_000);
});
