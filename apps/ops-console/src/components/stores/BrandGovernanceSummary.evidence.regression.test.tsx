import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BrandGovernanceSummary } from './BrandGovernanceSummary'
import type { PlatformBrandUnitSummary } from '../../types/ops'
const summary = (n:number):PlatformBrandUnitSummary => ({scope:'platform',workspaceCount:1,brandCount:n,boundStoreCount:n,unboundBrandCount:0,canonicalProductCount:n,listingCount:n,workspaces:[]})
describe('brand aggregate evidence boundaries',()=>{
 it('distinguishes successfully read zeros from an unread aggregate',()=>{
  const html=renderToStaticMarkup(<BrandGovernanceSummary summary={summary(0)}/>);
  expect(html).toContain('品牌数');expect(html).toContain('>0<');expect(html).not.toContain('尚未取得');
 });
 it('suppresses cached brand counts after a failed aggregate refresh',()=>{
  const html=renderToStaticMarkup(<BrandGovernanceSummary {...{summary:summary(884),error:'本次品牌汇总读取失败',onRetry:()=>{}}}/>);
  expect(html).toContain('本次品牌汇总读取失败');expect(html).not.toContain('>884<');expect(html).toContain('重新读取');
 });
 it('never presents test-data aggregate counts as verified brand records',()=>{
  const html=renderToStaticMarkup(<BrandGovernanceSummary {...{summary:summary(884),fixtureDataPresent:true}}/>);
  expect(html).not.toContain('>884<');expect(html).toContain('未核验');
 });
})
