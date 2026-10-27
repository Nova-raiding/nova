import { beforeAll, afterAll, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let server: ViteDevServer;
let browser: Browser;
let cache: string;
let baseUrl: string;
beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), 'ops-login-validation-'));
  server = await createServer({
    configFile: false,
    root: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    cacheDir: cache,
    logLevel: 'error',
    plugins: [{
      name: 'ops-login-validation-fixture',
      resolveId(id) { if (id === '/__login-validation.tsx') return '\0' + id; },
      load(id) {
        if (id !== '\0/__login-validation.tsx') return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {App} from 'antd'; import {PlatformOpsLoginPage} from '/src/components/PlatformOpsLoginPage.tsx';
          import '/src/styles.css';
          createRoot(document.getElementById('root')).render(React.createElement(App,null,
            React.createElement(PlatformOpsLoginPage,{managedSession:false,onAuthenticated:()=>{},onRetry:()=>{}})));`;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== '/__login-validation') return next();
          void vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__login-validation.tsx"></script></body></html>').then(html => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
          }).catch(next);
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Login validation fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 120_000);
afterAll(async () => {
  try { await browser?.close(); }
  finally { try { await server?.close(); } finally { if (cache) await rm(cache, { recursive: true, force: true }); } }
}, 60_000);

it('takes keyboard users to each invalid login field without attempting authentication', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  try {
    await page.goto(`${baseUrl}/__login-validation`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const submit = page.getByRole('button', { name: '登录平台运营后台', exact: true });
    const account = page.getByRole('textbox', { name: '平台运营账号', exact: true });
    const password = page.getByLabel('密码', { exact: true });
    await submit.focus(); await page.keyboard.press('Enter');
    await page.getByText('请输入平台运营账号', { exact: true }).waitFor();
    await expect.poll(() => account.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await account.getAttribute('aria-invalid')).toBe('true');
    await account.fill('fixture-account');
    await submit.focus(); await page.keyboard.press('Enter');
    await page.getByText('请输入密码', { exact: true }).waitFor();
    await expect.poll(() => password.evaluate(element => element === document.activeElement)).toBe(true);
    expect(await password.getAttribute('aria-invalid')).toBe('true');
    const passwordVisibility = page.locator('.ant-input-password-icon');
    expect(await passwordVisibility.getAttribute('role')).toBe('button');
    expect(await passwordVisibility.getAttribute('tabindex')).toBe('0');
    expect(await passwordVisibility.getAttribute('aria-label')).toMatch(/\S/u);
    expect(await passwordVisibility.evaluate(element => getComputedStyle(element).width)).toBe('44px');
    expect(await passwordVisibility.evaluate(element => getComputedStyle(element).height)).toBe('44px');
    await passwordVisibility.focus();
    expect(await passwordVisibility.evaluate(element => getComputedStyle(element).outlineWidth)).toBe('3px');
    expect(await passwordVisibility.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
    expect(writes).toEqual([]);
  } finally { await page.close(); }
}, 60_000);

it('moves focus to the named login error summary after authentication fails', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route('**/v1/auth/login', async route => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '账号或密码不正确' } }),
    });
  });
  try {
    await page.goto(`${baseUrl}/__login-validation`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByRole('textbox', { name: '平台运营账号', exact: true }).fill('fixture-account');
    await page.getByLabel('密码', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: '登录平台运营后台', exact: true }).click();

    const alert = page.locator('[role="alert"]');
    await alert.waitFor();
    expect(await alert.innerText()).toContain('运营登录已失效或尚未登录');
    const summary = page.locator('[data-focus-target="login-error"]');
    expect(await summary.getAttribute('role')).toBe('group');
    expect(await summary.getAttribute('aria-labelledby')).toBe('ops-login-error-title');
    expect(await summary.getAttribute('aria-describedby')).toBe('ops-login-error-description');
    await expect.poll(() => summary.evaluate(element => element === document.activeElement)).toBe(true);
  } finally { await page.close(); }
}, 60_000);
