#!/usr/bin/env node
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { loginLocalPlugin } from '../../apps/plugin/scripts/login-local-macos.mjs'

// Streaming HTML keeps document.fonts.ready pending until the final result arrives.
// The pending-state screenshot must be taken before the exchange is released.
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1'

const evidenceDir = new URL('../../docs/qa/evidence/2026-09-29-chatgpt-app/', import.meta.url)
const browser = await chromium.launch({ headless: true })

async function runCase(name, successful) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.addInitScript(() => { window.close = () => { throw new Error('close blocked by browser') } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let releaseExchange
  const exchangeGate = new Promise(resolve => { releaseExchange = resolve })
  let saved = false
  try {
    const login = loginLocalPlugin({
      baseUrl: 'http://127.0.0.1:19291', workspaceId: 'ws_browser_qa', timeoutMs: 10000,
      openBrowser: async authorizationUrl => {
        const authorization = new URL(authorizationUrl)
        const callback = new URL(authorization.searchParams.get('redirect_uri'))
        callback.searchParams.set('code', 'synthetic-browser-code-12345')
        callback.searchParams.set('state', authorization.searchParams.get('state'))
        await page.goto(callback.toString(), { waitUntil: 'commit' })
      },
      fetchImpl: async () => {
        await exchangeGate
        if (!successful) return new Response(JSON.stringify({ error: 'synthetic_rejection' }), { status: 403 })
        return new Response(JSON.stringify({ data: {
          access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
          token_type: 'Bearer', scope: 'merchant', expires_in: 600,
          workspace_id: 'ws_browser_qa', account_login: 'fixture@example.test',
        } }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
      storeCredential: async () => { saved = true },
      configureSession: async () => { assert.equal(saved, true) },
      launchChatGPT: async () => ({ launched: true }),
    })
    // Keep the rejection handled while the browser inspects the pending state.
    void login.catch(() => {})
    await page.getByRole('heading', { name: '正在完成绑定' }).waitFor()
    assert.equal(new URL(page.url()).search, '', 'callback code/state must leave the visible URL')
    assert.equal(await page.getByRole('button', { name: '完成，关闭此页面' }).isHidden(), true)
    await page.screenshot({ path: new URL(`27-${name}-pending.png`, evidenceDir).pathname })

    releaseExchange()
    if (successful) {
      const result = await login
      assert.equal(result.ok, true)
      assert.equal(saved, true)
      await page.getByRole('heading', { name: '绑定已完成' }).waitFor()
    } else {
      await assert.rejects(login, /LOCAL_PLUGIN_LOGIN_EXCHANGE_REJECTED/)
      assert.equal(saved, false)
      await page.getByRole('heading', { name: '绑定未完成' }).waitFor()
    }
    assert.equal(await page.getByRole('button', { name: '完成，关闭此页面' }).isVisible(), true)
    if (successful) {
      await page.getByRole('button', { name: '完成，关闭此页面' }).click()
      await page.getByRole('button', { name: '绑定完成，请返回 ChatGPT' }).isDisabled()
      assert.match(await page.locator('#hint').innerText(), /切换回 ChatGPT.*手动关闭/u)
    }
    const body = await page.locator('body').innerText()
    assert.doesNotMatch(body, /synthetic-access|synthetic-refresh|synthetic-browser-code-12345/)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: new URL(`27-${name}-result.png`, evidenceDir).pathname })
    return { case: name, result: successful ? 'success' : 'failure', credentialSaved: saved, pageErrors: errors.length }
  } finally {
    releaseExchange?.()
    await context.close()
  }
}

try {
  console.log(JSON.stringify(await runCase('callback-success', true)))
  console.log(JSON.stringify(await runCase('callback-failure', false)))
} finally {
  await browser.close()
}
