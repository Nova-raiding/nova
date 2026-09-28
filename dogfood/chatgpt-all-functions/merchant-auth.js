import { expect } from '@playwright/test'

export async function ensureMerchantSession(page) {
  const account = process.env.MERCHANT_E2E_LOGIN ?? 'merchant-demo@example.com'
  const password = process.env.MERCHANT_E2E_PASSWORD ?? 'MerchantDemo123!'
  const accountInput = page.locator('#merchant-login-account')
  await page.locator('#merchant-login-account, .app-shell').first().waitFor({ state: 'visible', timeout: 30_000 })
  if (!(await accountInput.isVisible().catch(() => false))) return
  await accountInput.fill(account)
  await page.locator('#merchant-login-password').fill(password)
  const submit = page.getByRole('button', { name: '登录商家工作台', exact: true })
  await expect(submit).toBeEnabled({ timeout: 30_000 })
  await submit.click()
  const loginError = page.getByRole('alert')
  await Promise.race([
    page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 }),
    loginError.waitFor({ state: 'visible', timeout: 15_000 }).then(async () => { throw new Error(`Merchant browser fixture login failed: ${await loginError.innerText()}`) }),
  ])
}
