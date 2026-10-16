import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpsConsoleModel } from '../hooks/useOpsConsoleModel'
vi.mock('../components/stores/ProductSpreadsheetImport.js', () => ({ ProductSpreadsheetImport: () => null }))
vi.mock('../components/tasks/AlertFiltersSection', () => ({ AlertFiltersSection: () => null }))
vi.mock('../components/tasks/MarketingQueueFiltersSection', () => ({ MarketingQueueFiltersSection: () => null }))
vi.mock('../components/tasks/OperationalGovernanceSection', () => ({ OperationalGovernanceSection: () => null }))
import { TasksPage } from './TasksPage'
const model = (failedMethod?: string, fixture = false) => ({
  authorization: { scope: {kind:'platform'}, can: (capability:string) => ['workspace.directory.read','marketing.summary.read'].includes(capability), canAny:()=>false },
  dataSetError: (...methods:string[]) => failedMethod && methods.includes(failedMethod) ? '本次汇总读取失败' : undefined,
  dataSource:{fixtureDataPresent:fixture}, loading:false, load:vi.fn(), queueFilters:{},setQueueFilters:vi.fn(),alertFilters:{},setAlertFilters:vi.fn(),storeDirectory:[],canQueue:false,
  platformTaskSummary:{workspaceCount:1,taskCount:881,generationQueueCount:0,publishQueueCount:0,failedWorkspaceCount:0},
  platformMarketingSummary:{visualReviewCount:771,assetRiskCount:0,learningSuggestionCount:0,generationByState:{failed:0},videoPendingReconciliationCount:0,videoArchiveRiskCount:0,failedWorkspaceCount:0},
} as unknown as OpsConsoleModel)
describe('task summaries only display valid evidence',()=>{
  it('hides cached task totals after task-summary failure, retaining independently successful marketing data',()=>{
    const html=renderToStaticMarkup(<TasksPage model={model('ops.tasks.summary')}/>);
    expect(html).toContain('本次汇总读取失败');expect(html).not.toContain('>881<');expect(html).toContain('>771<');
  })
  it('hides cached marketing totals after marketing-summary failure, retaining independently successful task data',()=>{
    const html=renderToStaticMarkup(<TasksPage model={model('ops.marketing.summary')}/>);
    expect(html).not.toContain('>771<');expect(html).toContain('>881<');
  })
  it('does not present test-data task or marketing totals as actual workload',()=>{
    const html=renderToStaticMarkup(<TasksPage model={model(undefined,true)}/>);
    expect(html).not.toContain('>881<');expect(html).not.toContain('>771<');
  })
  it('keeps verified task and marketing totals including zero values',()=>{
    const html=renderToStaticMarkup(<TasksPage model={model()}/>);
    expect(html).toContain('>881<');expect(html).toContain('>771<');expect(html).toContain('>0<');
  })
})
