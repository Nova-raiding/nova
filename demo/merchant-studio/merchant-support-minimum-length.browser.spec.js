import { chromium, expect, test } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const studioRoot = fileURLToPath(new URL('.', import.meta.url))

test('support form rejects blank and short content before creating a request', async () => {
  test.setTimeout(60_000)
  const vite = await createServer({
    configFile: false,
    envDir: false,
    root: studioRoot,
    plugins: [react(), {
      name: 'merchant-support-validation-entry',
      resolveId(id) { if (id === '/__merchant-support-validation-entry.tsx') return '\0merchant-support-validation-entry' },
      load(id) {
        if (id !== '\0merchant-support-validation-entry') return
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { MerchantSupportRequestPanel } from '/src/MerchantSupportRequestPanel.tsx';
          import { configureMerchantWorkspaceScope } from '/src/api.ts';
          configureMerchantWorkspaceScope(['fixture-workspace'], 'fixture-workspace');
          createRoot(document.getElementById('root')).render(React.createElement(MerchantSupportRequestPanel, { baseUrl: '/api', workspaceKey: 'fixture-workspace:fixture-user' }));
        `
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__merchant-support-validation') return next()
          const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__merchant-support-validation-entry.tsx"></script></body></html>'
          void server.transformIndexHtml(req.url, html).then(output => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(output)
          }).catch(next)
        })
      },
    }],
    define: { 'import.meta.env.MODE': JSON.stringify('test') },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') {
    await vite.close()
    throw new Error('Local Merchant support validation fixture did not bind an ephemeral TCP port')
  }

  const studioUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const externalRequests = []
  const supportWrites = []
  const runtimeErrors = []
  page.on('pageerror', error => runtimeErrors.push(error.message))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== studioUrl) {
      externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    if (url.pathname.startsWith('/api/')) {
      if (route.request().method() !== 'GET') supportWrites.push(`${route.request().method()} ${url.pathname}`)
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FIXTURE_REQUEST_BLOCKED', message: 'Invalid form must not call the API.' } }) })
    }
    return route.continue()
  })

  try {
    await page.goto(`${studioUrl}/__merchant-support-validation`, { waitUntil: 'commit' })
    await expect(page.getByRole('heading', { name: '提交人工支持' })).toBeVisible({ timeout: 30_000 })
    const subject = page.getByLabel('问题标题')
    const message = page.getByLabel('问题说明')
    const submit = page.getByRole('button', { name: '提交人工支持' })
    await expect(submit).toBeEnabled()

    await subject.fill('  ')
    await message.fill('  ')
    await submit.click()
    await expect(page.getByRole('alert')).toContainText('至少填写 3 个字')
    await expect(subject).toHaveValue('  ')
    await expect(message).toHaveValue('  ')

    await subject.fill('短')
    await message.fill('不够')
    await submit.click()
    await expect(page.getByRole('alert')).toContainText('至少填写 3 个字')
    expect(supportWrites).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await context.close()
    await browser.close()
    await vite.close()
  }
})
