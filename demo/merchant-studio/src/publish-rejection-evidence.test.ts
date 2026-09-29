import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { merchantRouteFromLocation } from './navigation'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('merchant publish workspace routing', () => {
  it.each(['/merchant/publish', '/console/merchant/publish/'])('keeps the retired publish history route on the materials workspace: %s', (pathname) => {
    expect(merchantRouteFromLocation({ pathname, search: '', hash: '' }).page).toBe('products')
  })

  it('keeps publish confirmation mounted in the task flow without mounting the retired history panel', () => {
    expect(app).not.toContain('function PublishCenter(')
    expect(app).toContain('<PublishModal')
    expect(app).toContain('preparePublish(apiBaseUrl, taskContext.task.id)')
    expect(app).toContain('confirmPublish(')
  })
})
