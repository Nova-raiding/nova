import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MaterialBrandFields } from './App.js'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fields(disabled: boolean) {
  return renderToStaticMarkup(createElement(MaterialBrandFields, {
    value: { logoUrl: '', color: '', persona: '', sellingPoints: '', personaFileName: '', sellingPointsFileName: '', assetFileName: '' },
    onChange: () => undefined,
    label: '全局',
    disabled,
  }))
}

describe('workspace brand settings read gate', () => {
  it('keeps brand controls disabled until the delayed scoped read resolves', async () => {
    const read = deferred<{ revision: number }>()
    let loading = true
    const settled = read.promise.then(() => { loading = false })

    const whileReading = fields(loading)
    expect(whileReading).toContain('<fieldset disabled=""')
    expect(app).toContain('正在读取当前工作区的最新品牌配置；读取完成前暂不可编辑。')

    read.resolve({ revision: 7 })
    await settled
    const afterRead = fields(loading)
    expect(afterRead).toContain('<fieldset')
    expect(afterRead).not.toContain('<fieldset disabled=""')
  })

  it('wires the pending server read to every brand editor and enable toggle', () => {
    expect(app).toContain('setScopedBrandLoading(true)\n    setScopedBrandError(\'\')\n    fetchScopedBrandSettings(baseUrl)')
    expect(app).toContain('disabled={scopedBrandLoading} onChange={(next) => { setGlobalBrand')
    expect(app).toContain('disabled={scopedBrandLoading} onChange={(next) => { setStoreBrands')
    expect(app).toContain('disabled={scopedBrandLoading} onChange={(next) => { setSeriesBrands')
    expect(app).toContain('disabled={scopedBrandLoading} onEnabledChange=')
  })
})
