export async function ensureMerchantSession(page) {
  const account = process.env.MERCHANT_E2E_LOGIN ?? 'merchant-demo@example.com'
  const password = process.env.MERCHANT_E2E_PASSWORD ?? 'MerchantDemo123!'
  const accountInput = page.locator('#merchant-login-account')
  await page.locator('#merchant-login-account, .app-shell').first().waitFor({ state: 'visible', timeout: 30_000 })
  if (!(await accountInput.isVisible().catch(() => false))) return
  await accountInput.fill(account)
  await page.locator('#merchant-login-password').fill(password)
  await page.getByRole('button', { name: '登录商家工作台', exact: true }).click()
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 })
}
