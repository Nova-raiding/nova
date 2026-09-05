import { chromium } from '../../node_modules/@playwright/test/index.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
const root = new URL('.', import.meta.url).pathname;
await mkdir(root+'videos',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:root+'videos'}});
const page=await context.newPage();page.setDefaultTimeout(8000);
const steps=[], errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)});
async function snap(name){await page.waitForTimeout(1000);await page.screenshot({path:root+'screenshots/human-'+steps.length+'.png'});steps.push({name,url:page.url(),text:await page.locator('body').innerText(),controls:await page.locator('button,input,select').evaluateAll(es=>es.map(e=>({text:e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder'),disabled:e.disabled,value:e.value})))});await writeFile(root+'human-exploration.json',JSON.stringify({steps,errors},null,2));}
try{
await page.goto('http://127.0.0.1:18081/');await page.waitForTimeout(2500);
await page.getByLabel('搜索商品',{exact:true}).pressSequentially('轻云',{delay:150});await page.getByLabel('搜索商品',{exact:true}).press('Enter');await snap('全局搜索输入并回车');
await page.getByRole('button',{name:'商品与资产',exact:true}).first().click();await page.waitForTimeout(1000);
const checks=page.getByRole('checkbox');
if(await checks.nth(0).isEnabled())await checks.nth(0).check();
if(await checks.nth(1).isEnabled())await checks.nth(1).check();
await snap('选择两个商品，核对批量创建门禁');
await page.getByRole('button',{name:'下一页',exact:true}).click();await snap('商品列表第二页');
await page.getByRole('button',{name:'上一页',exact:true}).click();
await page.getByRole('button',{name:'查看关系',exact:true}).first().click();await snap('商品关系详情');
await page.keyboard.press('Escape');
await page.getByRole('button',{name:'营销任务',exact:true}).first().click();await page.waitForTimeout(1000);
await page.getByRole('button',{name:'查看任务',exact:true}).first().click();await snap('图片任务详情');
await page.keyboard.press('Escape');
await page.getByRole('button',{name:'发布中心',exact:true}).first().click();await snap('发布中心门禁');
}catch(e){errors.push(e.stack);await snap('操作失败现场');}
await context.close();await browser.close();
console.log(JSON.stringify({steps:steps.map(s=>s.name),errors},null,2));
