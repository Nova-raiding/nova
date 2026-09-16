import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'public-product-'))
const file = join(dir, 'sample.html')
writeFileSync(file, '<meta property="og:title" content="Meta title"><script type="application/ld+json">{"@type":"Product","name":"测试商品","description":"详情","sku":"SKU-1","image":["https://img.test/a.jpg"],"offers":{"price":"199","priceCurrency":"CNY"}}</script>')
const output = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./extract-product.mjs', import.meta.url)), file], { encoding: 'utf8' }))
assert.deepEqual(output.title, '测试商品')
assert.deepEqual(output.price, '199.00')
assert.deepEqual(output.images, ['https://img.test/a.jpg'])
assert.equal(output.sourceEvidence.price, true)
console.log('extract-product: ok')
