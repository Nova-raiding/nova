import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./image-local-edit.html', import.meta.url), 'utf8');

describe('图片局部编辑 MCP Host 错误契约', () => {
  it('保留 Host 结构化错误代码；缺少代码时按结果未知阻止重复提交', () => {
    const start = html.indexOf("window.addEventListener('message'");
    const end = html.indexOf('hydrate(window.openai?.toolInput', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const handler = html.slice(start, end);
    expect(handler).toContain('details.code');
    expect(handler).toContain('nested.code');
    expect(handler).toContain("nested.operation_status==='unknown'");
    expect(handler).toContain("'MODEL_PROVIDER_OUTCOME_UNKNOWN'");
    expect(handler).toContain('item.reject(error)');
  });

  it('收到未知写入结果时禁用重复提交并保留 Host 错误说明', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(`<iframe id="editor"></iframe><script>
        window.__toolCalls = 0;
        const frame = document.getElementById('editor');
        window.addEventListener('message', event => {
          if (event.source !== frame.contentWindow || event.data?.method !== 'tools/call') return;
          window.__toolCalls += 1;
          event.source.postMessage({
            jsonrpc: '2.0', id: event.data.id,
            error: { code: -32000, message: '操作尚未确认', data: { code: 'API_UNAVAILABLE', details: { operation_status: 'unknown' } } },
          }, '*');
        });
      </script>`);
      await page.locator('#editor').evaluate((frame, source) => {
        (frame as HTMLIFrameElement).srcdoc = source;
      }, html);

      const editor = page.frameLocator('#editor');
      await editor.locator('details > summary').click();
      await editor.locator('#sourceId').fill('asset-local-1');
      await editor.locator('#imageUrl').fill('data:image/png;base64,iVBORw0KGgo=');
      await editor.locator('#prompt').fill('只调整背景颜色');
      await editor.locator('#productId').fill('product-local-1');
      await editor.locator('#submit').click();
      await editor.locator('#regionStatus').getByText('模型调用结果或结算尚未确认').waitFor();

      expect(await editor.locator('#submit').isDisabled()).toBe(true);
      expect(await editor.locator('#formError').textContent()).toContain('操作尚未确认');
      expect(await page.evaluate(() => (window as Window & typeof globalThis & { __toolCalls?: number }).__toolCalls)).toBe(1);
    } finally {
      await browser.close();
    }
  // This launches a real Chromium instance. Keep its harness deadline above
  // the widget's 20s MCP Host timeout so shard-level browser contention cannot
  // kill the test before the UI reaches its own bounded timeout behavior.
  }, 45_000);
});
