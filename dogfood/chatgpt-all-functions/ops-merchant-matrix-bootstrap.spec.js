import { expect, test } from '@playwright/test'
import { openPlatformConsole } from './ops-auth.js'

test.use({ channel: 'chrome', viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Shanghai' })

test('isolated bootstrap authenticates the Ops browser before merchant matrix capture', async ({ page }) => {
  await openPlatformConsole(page, '/ops/overview')
  await expect(page.getByRole('heading', { name: '平台运营实时概况' })).toBeVisible()
})
