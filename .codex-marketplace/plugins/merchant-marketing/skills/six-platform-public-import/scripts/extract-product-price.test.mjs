import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
const parser = fileURLToPath(new URL('./extract-product.mjs', import.meta.url))
const extract = product => JSON.parse(execFileSync(process.execPath, [parser], { input: `<script type="application/ld+json">${JSON.stringify({'@type':'Product',name:'QA',...product})}</script>`, encoding: 'utf8' }))
for (const [input, expected] of [[0,'0.00'],[199,'199.00'],['0','0.00'],['199','199.00'],[' 199.50 ','199.50'],[-1,'-1.00'],['-1','-1.00'],['invalid','invalid'],['Infinity','Infinity']]) {
  test(`price ${JSON.stringify(input)} preserves numeric/string extraction contract`, () => {
    const result=extract({offers:{price:input}})
    assert.equal(result.price,expected);assert.equal(result.sourceEvidence.price,true)
    if (Number(input)<0 || !Number.isFinite(Number(input))) assert.ok(!Number.isFinite(Number(result.price)) || Number(result.price)<0, 'invalid source must not become an importable zero')
  })
}
test('missing/blank/boolean/object prices do not become zero', () => {
  for (const price of [undefined,null,'',false,true,{}]) {
    const result=extract({offers:{price}});assert.equal(result.price,null);assert.equal(result.sourceEvidence.price,false)
  }
})
test('numeric lowPrice and product.price fallback preserve existing priority and zero', () => {
  assert.equal(extract({offers:{lowPrice:199}}).price,'199.00')
  assert.equal(extract({price:199}).price,'199.00')
  assert.equal(extract({offers:{price:0,lowPrice:199},price:299}).price,'0.00')
  assert.equal(extract({offers:{price:'invalid',lowPrice:199}}).price,'invalid')
})
test('numeric overflow remains visibly invalid and unrelated scalar fields stay unchanged', () => {
  const output=JSON.parse(execFileSync(process.execPath,[parser],{input:'<script type="application/ld+json">{"@type":"Product","name":"QA","sku":123,"offers":{"price":1e400}}</script>',encoding:'utf8'}))
  assert.equal(output.price,'Infinity');assert.equal(output.sourceEvidence.price,true);assert.equal(output.sku,null)
})
test('non-JSON NaN and Infinity tokens are not accepted as zero', () => {
  for (const value of ['NaN','Infinity']) {
    const result=JSON.parse(execFileSync(process.execPath,[parser],{input:`<script type="application/ld+json">{"@type":"Product","offers":{"price":${value}}}</script>`,encoding:'utf8'}))
    assert.equal(result.price,null);assert.equal(result.sourceEvidence.price,false);assert.equal(result.sourceEvidence.structuredData,false)
  }
})
