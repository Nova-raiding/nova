import { readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

declare global {
  interface Window {
    __calls: Array<{ name: string; args: { request_json: string } }>;
  }
}

const html = readFileSync(new URL('./image-local-edit.html', import.meta.url), 'utf8');
let browser: Browser;

async function openEditor(): Promise<Page> {
  const page = await browser.newPage();
  const hostMock = `<script>window.__calls=[];window.openai={callTool:async(name,args)=>{window.__calls.push({name,args});return {structuredContent:{id:'candidate-local-1',modelVersion:'mock-model',images:['javascript:alert(1)']}}}};</script>`;
  await page.setContent(html.replace('<script>', `${hostMock}<script>`));
  await page.evaluate(() => {
    for (const [id, value] of Object.entries({
      sourceId: 'asset-local-1',
      imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
      prompt: '只调整背景颜色',
      productId: 'product-local-1',
    })) {
      (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value = value;
    }
    (document.querySelector('details') as HTMLDetailsElement).open = true;
  });
  return page;
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe('图片局部编辑候选输出安全边界', () => {
  it('保留候选回执但隐藏不安全图片地址，且只调用 Host 一次', async () => {
    const page = await openEditor();
    try {
      expect(await page.locator('#sourceImage').isHidden()).toBe(true);
      await page.locator('#submit').click();
      await page.waitForSelector('#candidate.show');

      expect(await page.locator('#candidateId').textContent()).toBe('candidate-local-1');
      expect(await page.locator('#candidateImage').isHidden()).toBe(true);
      expect(await page.locator('#regionStatus').textContent()).toContain('候选已创建');
      expect(await page.evaluate(() => window.__calls.map((call) => call.name))).toEqual(['multimodal.image.edit']);
      const requestJson = await page.evaluate(() => window.__calls[0]?.args.request_json as string);
      expect(JSON.parse(requestJson).sourceImage.uri).toBe('asset://asset-local-1');
      expect(requestJson).not.toContain('data:image/png;base64');
    } finally {
      await page.close();
    }
  }, 12_000);
});
