import { createServer, type ViteDevServer } from 'vite';
import { it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
let cache: string;
let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;
beforeAll(async()=>{
cache = await mkdtemp(join(tmpdir(), 'ops-reconciliation-context-'));
 server = await createServer({configFile:false,root:resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),cacheDir:cache,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},optimizeDeps:{rolldownOptions:{transform:{define:{'process.env.NODE_ENV':'"development"'}}}},plugins:[{
 name:'reconciliation-context-readonly-probe',
 resolveId(id){if(id==='/__reconciliation-context.tsx')return '\0'+id;},
 load(id){if(id!=='\0/__reconciliation-context.tsx')return;return `
 import React from 'react'; import {createRoot} from 'react-dom/client';
 import {App,Button} from 'antd'; import {ReconciliationSection} from '/src/components/finance/ReconciliationSection.tsx';
 import '/src/styles.css';
 const record={id:'usage_fixture_review',revision:1,observed_at:'2026-10-15T00:00:00Z',run_key:'run_fixture_review',action_id:'action_fixture_review',modality:'text',model:'fixture',provider_request_id:'fixture_request',settlement_status:'pending_wallet',allowed_decisions:['retry','waive','manual_attention'],settlement_reason:'wallet'};
 function Harness(){const [allowed,setAllowed]=React.useState(true);const mode=new URLSearchParams(location.search).get('change');const updatedRecord=!allowed&&mode==='revision'?{...record,revision:2}:!allowed&&mode==='decision'?{...record,allowed_decisions:[]}:record;const [attempts,setAttempts]=React.useState(0);
 const model={loading:!allowed&&mode==='loading',authorization:{scope:{kind:'platform'}},canModelSettlement:allowed||mode!=='permission',canPaymentReconciliation:false,canBillingExport:false,dataSetError:()=>!allowed&&mode==='read-error'?'fixture read failure':undefined,load:async()=>{},
 reconciliation:{balance_cny:'0.00',recharge_cny:'0.00',debit_cny:'0.00',refund_cny:'0.00',transaction_count:0,transactions:[],provider:{mode:mode==='manual-transfer'?'manual_transfer':'provider',ready:mode!=='manual-transfer',reasons:[]},model_usage:{record_count:1,total_tokens:10,provider_cost_cny:'0.01',customer_charge_cny:'0.02',unsettled_records:1,unsettled:[updatedRecord],by_modality:{},external_provider_statement:{status:'balanced'}}},
 retryModelUsageSettlement:!allowed&&mode==='callback'?undefined:async()=>{setAttempts(n=>n+1)},runModelUsageReconciliation:async()=>{},runReconciliation:async()=>{},exportBilling:async()=>{}};
 return React.createElement(App,null,React.createElement(Button,{onClick:()=>setAllowed(false)},'Fixture withdraw permission'),React.createElement('output',{id:'attempts'},attempts),React.createElement(ReconciliationSection,{model}))}
 createRoot(document.getElementById('root')).render(React.createElement(Harness));`},
 configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/__reconciliation-context')return next();s.transformIndexHtml(req.url,'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/__reconciliation-context.tsx"></script></body></html>').then(html=>{res.setHeader('Content-Type','text/html');res.end(html)}).catch(next)})}
 }],server:{host:'127.0.0.1',port:0,hmr:false}});
 await server.listen();const addr=server.httpServer?.address();if(!addr||typeof addr==='string')throw new Error('Reconciliation fixture failed to bind');
 browser=await chromium.launch({channel:'chrome',headless:true});baseUrl=`http://127.0.0.1:${addr.port}`;
},120_000);
afterAll(async()=>{try{await browser?.close()}finally{try{await server?.close()}finally{if(cache)await rm(cache,{recursive:true,force:true})}}},60_000);
it.each(['permission','revision','decision','callback','read-error','loading','unchanged'])('keeps settlement confirmation aligned with current %s context', async change=>{
const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);try {
 await page.goto(`${baseUrl}/__reconciliation-context?change=${change}`,{waitUntil:'domcontentloaded',timeout:60000});
 await page.getByRole('button',{name:'重试模型用量结算 usage_fixture_review',exact:true}).click();
 await page.getByLabel('处理原因',{exact:true}).fill('核对钱包结算证据');await page.getByLabel('Evidence 引用',{exact:true}).fill('ticket://fixture-review');
 // Context changes originate outside the open modal; a controlled harness event avoids clicking through its mask.
 await page.getByRole('button',{name:'Fixture withdraw permission',exact:true}).evaluate(e=>(e as HTMLButtonElement).click());
 const dialog=page.getByRole('dialog');const labelBindings=await dialog.locator('label').evaluateAll(es=>es.map(e=>({text:e.textContent,for:e.getAttribute('for'),targetPresent:!!document.getElementById(e.getAttribute('for')??'')})));
 const confirm=dialog.getByRole('button',{name:'确认提交',exact:true});
 expect(labelBindings.every(label=>label.targetPresent)).toBe(true);
 if(change==='unchanged') {
  expect(await confirm.isEnabled()).toBe(true);
  await confirm.click();
  await expect.poll(()=>page.locator('#attempts').innerText()).toBe('1');
  await dialog.waitFor({state:'hidden'});
 } else {
  await dialog.getByRole('alert').filter({hasText:'当前不能提交结算操作'}).waitFor();
  expect(await confirm.isDisabled()).toBe(true);
  expect(await page.locator('#attempts').innerText()).toBe('0');
  expect(await page.getByLabel('处理原因',{exact:true}).inputValue()).toBe('核对钱包结算证据');
  await dialog.getByRole('button',{name:/取\s*消/u}).click();
  await dialog.waitFor({state:'hidden'});
  expect(await page.locator('#attempts').innerText()).toBe('0');
 }
} finally { await page.close(); }
},60_000);

it('explains manual transfers without calling real receipts fixture payments', async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});try {
  await page.goto(`${baseUrl}/__reconciliation-context?change=manual-transfer`,{waitUntil:'domcontentloaded',timeout:60000});
  await page.getByRole('button',{name:'查看详情',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByText('支付方式：人工转账收款（自动查单不可用）',{exact:true}).waitFor();
  expect(await dialog.getByText('当前为 fixture',{exact:false}).count()).toBe(0);
  expect(await dialog.getByText('人工收款和退款请在对应商业操作中核对凭证、分配及人工处理记录；此状态不代表测试收款。',{exact:true}).count()).toBe(1);
 } finally {await page.close();}
},60000);
