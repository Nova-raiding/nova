import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ProductKnowledgeRows } from './knowledge-document-status'
it('distinguishes restricted rights from unknown and invalid responses', () => {
  const render = (rightsStatus: string) => renderToStaticMarkup(createElement(ProductKnowledgeRows, { assets: [{id:'a',name:'资料',approvalStatus:'approved',rightsStatus,indexState:'queued'}] }))
  expect(render('restricted')).toContain('权益受限')
  expect(render('restricted')).not.toContain('待核验')
  expect(render('unknown')).toContain('待核验')
  expect(render('invalid')).toContain('未核验')
})
