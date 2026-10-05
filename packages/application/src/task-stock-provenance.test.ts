import { describe, expect, it } from 'vitest'
import { MerchantService, type Product } from './service.js'
const make = () => new MerchantService({fixtureMode:true,seedFixture:false})
const base={workspaceId:'ws_stock',platform:'taobao' as const,title:'Explicit provenance fixture',localProductKey:'stock-fixture'}
const task=(service:MerchantService,product:Product,candidateOnly=true)=>service.createTask({workspaceId:base.workspaceId,productId:product.id,platform:base.platform,candidateOnly,requestText:'只要纯文本，内部审核。',answers:{placement:'纯文本'}})
describe('candidate stock question provenance',()=>{
  it.each([{stock:undefined,known:false,question:false},{stock:0,known:true,question:true},{stock:4,known:true,question:false}])('preserves supplied stock semantics: %j',({stock,known,question})=>{
    const service=make();const product=service.importProduct({...base,...(stock===undefined?{}:{stock})});service.confirmProductFacts(base.workspaceId,product.id)
    expect(product.stock).toBe(stock??0);expect(product.stockProvided).toBe(known)
    // Same JSON snapshot representation used for durable save/hydration.
    const hydrated=make();const snapshot=JSON.parse(JSON.stringify(product));hydrated.hydrateSnapshot({entityType:'product',entity:snapshot})
    expect(task(hydrated,snapshot).missingQuestions.some(q=>q.id==='stock_status')).toBe(question)
    expect(hydrated.products.get(product.id)?.stockProvided).toBe(known)
  })
  it('rejects invalid supplied stock before recording provenance',()=>{
    const service=make()
    for(const stock of [null,NaN,Infinity,-1,0.5,'0']) expect(()=>service.importProduct({...base,stock:stock as number})).toThrow('商品库存必须是非负整数')
    expect(service.products.size).toBe(0)
  })
  it('does not infer legacy candidate stock, but retains the original formal-task question',()=>{
    const service=make();const product=service.importProduct({...base,stock:0});service.confirmProductFacts(base.workspaceId,product.id);delete product.stockProvided
    expect(task(service,product).missingQuestions.some(q=>q.id==='stock_status')).toBe(false)
    expect(product).not.toHaveProperty('stockProvided')
    expect(task(service,product,false).missingQuestions.some(q=>q.id==='stock_status')).toBe(true)
  })
  it('marks only an explicit SKU stock edit, not a name-only edit, as supplied',()=>{
    const service=make();const product=service.importProduct({...base,skus:[{id:'sku',name:'sku',price:0,stock:0}]})
    service.updateProductSku({workspaceId:base.workspaceId,productId:product.id,skuId:'sku',name:'renamed'})
    expect(product.stockProvided).toBe(false)
    service.updateProductSku({workspaceId:base.workspaceId,productId:product.id,skuId:'sku',stock:0})
    expect(product.stockProvided).toBe(true);expect(product.stock).toBe(0)
  })
  it('records explicit platform stock and does not carry old provenance into a sparse reimport',()=>{
    const service=make();const [synced]=service.upsertSyncedProducts({workspaceId:base.workspaceId,platform:base.platform,items:[{remoteId:'remote',title:base.title,sku:[],stock:0,source:'official_api'}]})
    expect(synced).toMatchObject({stock:0,stockProvided:true})
    service.importProduct({...base,stock:0});const sparse=service.importProduct(base)
    expect(sparse).toMatchObject({stock:0,stockProvided:false})
  })
})
