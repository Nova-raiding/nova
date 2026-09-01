import { describe, expect, it } from 'vitest'
import { DomainError } from '../../../packages/application/src/service.js'
import { readContentModules } from './server.js'

const moduleFixture = (key: string, priority: number) => ({
  key,
  title: `${key} 标题`,
  purpose: `${key} 页面任务`,
  body: `${key} 正文`,
  factSourceIds: [`fact:${key}`],
  contentKind: 'fact',
  decisionContract: {
    buyerQuestion: `${key} 解决什么问题？`,
    pageTask: `${key} 页面任务`,
    claim: {
      text: `${key} 已核验宣称`,
      factSourceIds: [`fact:${key}`],
      skuIds: [],
      platforms: ['taobao'],
      regions: ['CN'],
      limitations: [],
    },
    evidence: {
      type: 'parameter',
      sourceIds: [`fact:${key}`],
      status: 'verified',
    },
    visualContract: {
      requiredElements: [`${key} 证据`],
      protectedElements: [],
      prohibitedImplications: [],
      accessibilityText: `${key} 可访问文本`,
    },
    priority,
    optional: false,
  },
})

function expectSchemaFailure(value: unknown) {
  try {
    readContentModules(value)
    throw new Error('expected readContentModules to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code: 'CONTENT_SCHEMA_INVALID', status: 400 })
  }
}

describe('asynchronous worker content module reader', () => {
  it('rejects a missing module array instead of falling back to defaults', () => {
    expectSchemaFailure(undefined)
  })

  it('fails the whole result when valid and invalid modules are mixed', () => {
    expectSchemaFailure([moduleFixture('hero', 1), { key: 'broken' }])
  })

  it('fails closed when every module is invalid', () => {
    expectSchemaFailure([{ body: 'missing contract and identity' }, null])
  })

  it('rejects an empty module array instead of falling back to defaults', () => {
    expectSchemaFailure([])
  })

  it('rejects oversized module arrays instead of silently truncating them', () => {
    expectSchemaFailure(Array.from({ length: 17 }, (_, index) => moduleFixture(`module-${index}`, index + 1)))
  })

  it('preserves legal dynamic order and decision contracts', () => {
    const modules = [moduleFixture('specifications', 6), moduleFixture('hero', 1), moduleFixture('usage', 7)]

    expect(readContentModules(modules)).toEqual(modules)
    expect(readContentModules(modules)?.map(module => module.key)).toEqual(['specifications', 'hero', 'usage'])
    expect(readContentModules(modules)?.map(module => module.decisionContract?.priority)).toEqual([6, 1, 7])
  })
})
