import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const parser = fileURLToPath(new URL('./extract-product.mjs', import.meta.url))
const html = '<meta content="反序标题" property="og:title"><meta content="反序描述" name="description">'
const output = JSON.parse(execFileSync(process.execPath, [parser], { input: html, encoding: 'utf8' }))

assert.equal(output.title, '反序标题')
assert.equal(output.description, '反序描述')
assert.equal(output.sourceEvidence.title, true)
assert.equal(output.sourceEvidence.description, true)
console.log('extract-product-meta-order: ok')
