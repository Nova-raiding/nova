import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserServer, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const html = await readFile(new URL('./image-local-edit.html', import.meta.url), 'utf8');
let browser: Browser;
let browserServer: BrowserServer | undefined;

const SHUTDOWN_TIMEOUT_MS = 5_000;

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<'settled' | 'rejected' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    promise.then(
      () => { clearTimeout(timer); resolve('settled'); },
      () => { clearTimeout(timer); resolve('rejected'); },
    );
  });
}

async function openEditor(response: unknown): Promise<Page> {
  const page = await browser.newPage();
  const hostStub = `<script>window.openai={callTool:async()=>{window.__toolCalls=(window.__toolCalls||0)+1;return ${JSON.stringify(response)}}};</script>`;
  await page.setContent(html.replace('<script>', `${hostStub}<script>`));
  await page.evaluate(() => {
    for (const [id, value] of Object.entries({
      sourceId: 'asset-1',
      imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
      prompt: '只修改标题',
      productId: 'product-1',
    })) {
      (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value = value;
    }
  });
  return page;
}

beforeAll(async () => {
  browserServer = await chromium.launchServer({ headless: true });
  browser = await chromium.connect(browserServer.wsEndpoint());
});

afterAll(async () => {
  const server = browserServer;
  if (!server) return;

  if (await settlesWithin(server.close(), SHUTDOWN_TIMEOUT_MS) === 'settled') return;

  // A hung graceful shutdown should not leave a Chromium child behind and
  // stall Vitest's afterAll hook indefinitely. Kill only this test-owned server.
  if (await settlesWithin(server.kill(), SHUTDOWN_TIMEOUT_MS) === 'settled') return;

  const child = server.process();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
  });
  if (await settlesWithin(exited, SHUTDOWN_TIMEOUT_MS) !== 'settled') {
    throw new Error('局部图片编辑恢复测试的 Chromium 进程无法在强制清理后退出。');
  }
}, SHUTDOWN_TIMEOUT_MS * 3 + 2_000);

describe('局部图片编辑失败恢复', () => {
  it('证据或结算未确认时阻止重复提交并显示核对指引', async () => {
    const page = await openEditor({
      isError: true,
      structuredContent: {
        code: 'MODEL_RELAY_EVIDENCE_REQUIRED',
        message: '模型结果的用量或结算证据尚未确认。',
      },
    });
    try {
      await page.locator('#submit').click();
      const error = (await page.locator('#formError').textContent()) || '';
      expect(error).toContain('不要重复提交');
      expect(error).toContain('平台核对');
      expect(await page.locator('#submit').isDisabled()).toBe(true);
      expect(await page.locator('#submit').textContent()).toContain('等待平台核对');
      await page.locator('#submit').click({ force: true });
      expect(await page.evaluate(() => (window as Window & { __toolCalls?: number }).__toolCalls)).toBe(1);
    } finally {
      await page.close();
    }
  }, 20_000);

  it('Host 超时映射的未知结果代码阻止再次提交', async () => {
    const page = await openEditor({
      isError: true,
      structuredContent: {
        code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN',
        message: 'MCP Host 响应超时；操作是否完成尚未确认。',
      },
    });
    try {
      await page.locator('#submit').click();
      expect((await page.locator('#formError').textContent()) || '').toContain('不要重复提交');
      expect(await page.locator('#submit').isDisabled()).toBe(true);
      await page.locator('#submit').click({ force: true });
      expect(await page.evaluate(() => (window as Window & { __toolCalls?: number }).__toolCalls)).toBe(1);
    } finally {
      await page.close();
    }
  }, 20_000);

  it('普通可恢复失败仍允许再次提交', async () => {
    const page = await openEditor({
      isError: true,
      structuredContent: { code: 'API_UNAVAILABLE', message: '暂时无法连接服务。' },
    });

    try {
      await page.locator('#submit').click();
      expect(await page.locator('#submit').isEnabled()).toBe(true);
      await page.locator('#submit').click();
      expect(await page.evaluate(() => (window as Window & { __toolCalls?: number }).__toolCalls)).toBe(2);
    } finally {
      await page.close();
    }
  }, 20_000);
});
