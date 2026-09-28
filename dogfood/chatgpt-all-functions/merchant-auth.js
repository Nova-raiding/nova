import { expect } from '@playwright/test'

export async function ensureMerchantSession(page) {
  const account = process.env.MERCHANT_E2E_LOGIN ?? 'merchant-demo@example.com'
  const password = process.env.MERCHANT_E2E_PASSWORD ?? 'MerchantDemo123!'
  const accountInput = page.locator('#merchant-login-account')
  const appShell = page.locator('.app-shell')
  const submit = page.getByRole('button', { name: '登录商家工作台', exact: true })
  await expect.poll(async () => {
    if (await appShell.isVisible().catch(() => false)) return 'authenticated'
    if (await submit.isVisible().catch(() => false)) return 'signed_out'
    return 'loading'
  }, { timeout: 30_000 }).not.toBe('loading')
  if (await appShell.isVisible().catch(() => false)) return
  await accountInput.fill(account)
  await page.locator('#merchant-login-password').fill(password)
  await expect.poll(async () => {
    if (await appShell.isVisible().catch(() => false)) return 'authenticated'
    if (await submit.isVisible().catch(() => false)) return await submit.isEnabled() ? 'ready' : 'loading'
    return 'loading'
  }, { timeout: 30_000 }).toMatch(/authenticated|ready/)
  if (await appShell.isVisible().catch(() => false)) return
  await submit.click()
  const loginError = page.getByRole('alert')
  await Promise.race([
    page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 }),
    loginError.waitFor({ state: 'visible', timeout: 15_000 }).then(async () => { throw new Error(`Merchant browser fixture login failed: ${await loginError.innerText()}`) }),
  ])
}
