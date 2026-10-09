import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const html = '<meta content="反序标题" property="og:title"><meta content="反序描述" name="description">'
const parsers = [
  fileURLToPath(new URL('./extract-product.mjs', import.meta.url)),
  fileURLToPath(new URL('../../../../../.codex-marketplace/plugins/merchant-marketing/skills/six-platform-public-import/scripts/extract-product.mjs', import.meta.url)),
]
const outputs = parsers.map(parser => JSON.parse(execFileSync(process.execPath, [parser], { input: html, encoding: 'utf8' })))

for (const output of outputs) {
  assert.equal(output.title, '反序标题')
  assert.equal(output.description, '反序描述')
  assert.equal(output.sourceEvidence.title, true)
  assert.equal(output.sourceEvidence.description, true)
}
assert.deepEqual(outputs[0], outputs[1], 'the local plugin and marketplace parsers must preserve identical metadata-order semantics')
console.log('extract-product-meta-order: source and marketplace mirror ok')
