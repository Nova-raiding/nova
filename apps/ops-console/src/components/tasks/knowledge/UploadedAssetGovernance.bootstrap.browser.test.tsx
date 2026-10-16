import { expect, it } from 'vitest'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect as browserExpect } from '@playwright/test'

it('confirms historical scan enrollment, cancels without a call and reuses the key after failure', async () => {
  const entry = '/__scan-bootstrap.tsx'
  const vite = await createServer({ configFile: false, root: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'scan-bootstrap-fixture', enforce: 'pre',
    transform(code, id) {
      if (!id.includes('UploadedAssetGovernance.tsx')) return
      const original = 'import { describeOpsError, rpc } from "../../../api/opsClient.js";'
      if (!code.includes(original)) throw new Error('RPC seam changed')
      return code.replace(original, 'const describeOpsError = e => String(e); const rpc = (method, params) => window.__scanCall(method, params);')
    },
    resolveId(id) { if (id === entry) return `\0${entry}` },
    load(id) { if (id === `\0${entry}`) return `
      import React from 'react'; import {createRoot} from 'react-dom/client'; import {App} from 'antd';
      import {UploadedAssetGovernance} from '/src/components/tasks/knowledge/UploadedAssetGovernance.tsx';
      const row={id:'asset-historical',workspaceId:'ws-scan',name:'历史素材.png',mimeType:'image/png',scanStatus:'unscanned',parseStatus:'pending',rightsStatus:'pending',readiness:{status:'blocked',reasons:[]},revision:3,createdAt:'2026-10-01',nextAction:{method:'ops.marketing.asset_scan.bootstrap',label:'申请首次安全扫描',requiredInputs:[]}};
      const model={canQueue:true,canKnowledge:true,marketingQueue:{uploadedAssetRisks:[row]},load:async()=>{window.__scanLoads=(window.__scanLoads||0)+1},governUploadedAsset:async()=>false};
      window.__scanCalls=[]; window.__scanCall=async(method,params)=>{window.__scanCalls.push({method,params});if(window.__scanCalls.length===1)throw new Error('模拟网络结果未知');return {newEventId:'evt-first-scan',replayed:true}};
      const root=createRoot(document.getElementById('root'));
      const render=()=>root.render(React.createElement(App,null,React.createElement(UploadedAssetGovernance,{model})));
      window.__scanContext=mode=>{model.canQueue=mode!=='permission';model.marketingQueue={uploadedAssetRisks:[{...row,revision:mode==='revision'?4:3,workspaceId:mode==='workspace'?'ws-other':'ws-scan'}]};render()};render();
    ` },
    configureServer(server) { server.middlewares.use((req,res,next)=>{if(req.url!=='/__scan')return next();void server.transformIndexHtml(req.url,`<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`).then(html=>{res.setHeader('Content-Type','text/html');res.end(html)}).catch(next)}) },
  }] })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}})
    await page.goto(`http://127.0.0.1:${address.port}/__scan`)
    await page.getByRole('button',{name:'申请首次安全扫描',exact:true}).click()
    await browserExpect(page.getByRole('dialog')).toContainText('不是人工放行')
    await browserExpect(page.getByRole('dialog')).not.toContainText('旧 event_id')
    await page.getByRole('button',{name:/取\s*消/u}).click()
    expect(await page.evaluate(()=> (window as any).__scanCalls)).toEqual([])
    for (const change of ['permission', 'revision', 'workspace']) {
      await page.getByRole('button',{name:'申请首次安全扫描',exact:true}).click()
      await page.getByRole('textbox',{name:'扫描重新排队原因'}).fill('核验当前素材恢复条件')
      await page.evaluate(mode => (window as any).__scanContext(mode), change)
      await browserExpect(page.getByRole('button',{name:'确认重新排队'})).toBeDisabled()
      await page.getByRole('button',{name:/取\s*消/u}).click()
      expect(await page.evaluate(()=> (window as any).__scanCalls)).toEqual([])
      await page.evaluate(()=> (window as any).__scanContext('restore'))
    }
    await page.getByRole('button',{name:'申请首次安全扫描',exact:true}).click()
    await page.getByRole('textbox',{name:'扫描重新排队原因'}).fill('历史隔离素材重新核验')
    await page.getByRole('button',{name:'确认重新排队'}).click()
    await browserExpect(page.getByRole('alert').last()).toContainText('模拟网络结果未知')
    await page.getByRole('button',{name:'确认重新排队'}).click()
    await browserExpect(page.getByRole('dialog')).toContainText('evt-first-scan')
    const calls = await page.evaluate(()=> (window as any).__scanCalls)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(calls[0].method).toBe('ops.marketing.asset_scan.bootstrap')
    expect(calls[0].params.workspace_id).toBe('ws-scan')
    expect(calls[0].params).not.toHaveProperty('event_id')
    await page.getByRole('button',{name:'完 成'}).click()
    await page.getByRole('button',{name:'申请首次安全扫描',exact:true}).click()
    await page.getByRole('textbox',{name:'扫描重新排队原因'}).fill('核验迟到扫描响应')
    await page.evaluate(()=>{ (window as any).__scanCall=()=>new Promise(resolve=>{(window as any).__scanResolve=resolve}) })
    const loadsBefore = await page.evaluate(()=> (window as any).__scanLoads)
    await page.getByRole('button',{name:'确认重新排队'}).click()
    await page.evaluate(()=> (window as any).__scanContext('workspace'))
    await page.evaluate(()=> (window as any).__scanResolve({newEventId:'evt-old-workspace'}))
    await browserExpect(page.getByRole('dialog')).toContainText('原工作区请求已接受')
    await browserExpect(page.getByRole('dialog')).not.toContainText('重新排队失败')
    expect(await page.evaluate(()=> (window as any).__scanLoads)).toBe(loadsBefore)

  } finally { await browser.close(); await vite.close() }
}, 60000)
