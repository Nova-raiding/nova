import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import {
  describeApiError,
  fetchManualPublishRecordPage,
  getPublishJob,
  fetchPublishJobPage,
  MERCHANT_PUBLISH_PAGE_SIZE,
  type ApiPage,
  type ManualPublishRecord,
  type PublishJob,
} from './api'
import { urlForMerchantRoute } from './navigation'

const publishStateLabel: Record<string, string> = {
  prepared: '发布预览已准备', confirmed: '发布确认已记录，待入队',
  queued: '等待运营处理', submitting: '提交处理中', submitted: '已提交，待平台确认',
  reviewing: '平台审核中', published: '平台回执显示已发布', rejected: '平台驳回',
  unknown: '结果未知，需人工核对', reconciling: '对账中，禁止重复提交',
  manual_attention: '需运营人工处理',
}

const manualStateLabel: Record<string, string> = {
  export_ready: '交付包已准备', manual_publish_in_progress: '人工发布中',
  manual_publish_reported: '运营已报告人工发布', manual_review_required: '需要人工复核',
}

const platformLabel: Record<string, string> = {
  jd: '京东', taobao: '淘宝', tmall: '天猫', pinduoduo: '拼多多',
  xiaohongshu: '小红书', douyin: '抖音',
}

const rejectionFieldLabel: Record<string, string> = {
  title: '标题', description: '商品描述', detail: '详情', category: '品类',
  price: '价格', stock: '库存', sku: '规格', images: '图片', image: '图片',
  brand: '品牌', attributes: '商品属性',
}

function displayDate(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间待核对'
}

function displayRejectionField(path: string): string {
  const leaf = path.split(/[.\[\]\/]/u).filter(Boolean).at(-1)?.toLowerCase() ?? ''
  const label = rejectionFieldLabel[leaf] ?? '平台字段'
  return `${label}（原始字段 ${path}）`
}

export function PublishJobRecord({ job, taskHref, focusJobId }: { job: PublishJob; taskHref: string; focusJobId?: string }) {
  const isFocused = Boolean(focusJobId && job.id === focusJobId)
  const reconciliationPending = job.state === 'reconciling' || job.state === 'manual_attention'
  const publishedButUnresolved = ['reconciling', 'manual_attention', 'unknown'].includes(job.state) && job.remoteState === 'published'
  const displayedState = publishedButUnresolved
    ? '平台回执显示已发布 · 任务对账未结案'
    : publishStateLabel[reconciliationPending ? job.state : job.remoteState ?? job.state] ?? '状态待核对'
  return <article className={`task-list-row${isFocused ? ' publish-job-focused' : ''}`} id={isFocused ? `publish-job-${job.id}` : undefined} aria-current={isFocused ? 'true' : undefined}>
    <div>
      {isFocused && <b>刚创建的发布任务：{job.id}</b>}
      <b>{displayedState} · {platformLabel[job.platform] ?? '未知平台'} · {job.accountId ?? '店铺未绑定'}</b>
      <span>任务 {job.taskId} · 内容版本 {job.contentVersionId} · {displayDate(job.createdAt)}</span>
      {job.rejection && <div className="error-notice" role="status">
        <b>平台原始拒绝码：{job.rejection.rawCode}</b>
        {job.rejection.message && <span> · {job.rejection.message}</span>}
        {job.rejection.fields.length > 0 && <ul>{job.rejection.fields.map((field, i) => <li key={`${field.path}-${i}`}>{displayRejectionField(field.path)}；原始代码 {field.rawCode ?? '未提供'}；{field.message}</li>)}</ul>}
        <p>根据拒绝原因在任务中创建修正版，重新审核后再确认提交。</p>
      </div>}
      {(reconciliationPending || ['unknown', 'reconciling'].includes(job.state) || ['unknown', 'reconciling'].includes(job.remoteState ?? '')) && <div className="info-notice">{publishedButUnresolved ? '平台回执显示已发布，但任务对账尚未结案。先核对平台回执和任务历史，当前不要重复提交。' : '先核对平台回执和任务历史，当前不要重复提交。'}</div>}
    </div>
    <a className="text-button" href={taskHref}>查看任务与纠错</a>
  </article>
}

export function ManualPublishRecordRow({ record, taskHref }: { record: ManualPublishRecord; taskHref: string }) {
  return <article className="task-list-row">
    <div>
      <b>{manualStateLabel[record.state] ?? '人工状态待核对'} · {platformLabel[record.platform] ?? '未知平台'} · {record.accountId}</b>
      <span>任务 {record.taskId} · 内容版本 {record.contentVersionId} · {displayDate(record.recordedAt)}</span>
      <div className="info-notice">这是运营人工报告，未经平台接口验证，不代表平台已发布。</div>
      {record.platformContentId && <span>运营回填的平台内容编号：{record.platformContentId}</span>}
      {record.differenceNote && <span>内容差异：{record.differenceNote}</span>}
    </div>
    <a className="text-button" href={taskHref}>查看任务</a>
  </article>
}

type HistoryKind = 'jobs' | 'manual'

export function PublishHistoryPanel({ baseUrl }: { baseUrl?: string }) {
  const tabsId = useId().replaceAll(':', '')
  const focusJobId = new URLSearchParams(window.location.search).get('publish_job_id')?.trim()
  const [kind, setKind] = useState<HistoryKind>('jobs')
  const [jobPage, setJobPage] = useState(0)
  const [manualPage, setManualPage] = useState(0)
  const [reload, setReload] = useState(0)
  const [jobs, setJobs] = useState<ApiPage<PublishJob> | null>(null)
  const [focusedJob, setFocusedJob] = useState<PublishJob | null>(null)
  const [manual, setManual] = useState<ApiPage<ManualPublishRecord> | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const requestId = useRef(0)

  useEffect(() => {
    const currentId = ++requestId.current
    setError('')
    if (!baseUrl) {
      setLoading(false)
      setJobs(null)
      setFocusedJob(null)
      setManual(null)
      return
    }
    setLoading(true)
    if (kind === 'jobs' && focusJobId) {
      setFocusedJob(null)
      getPublishJob(baseUrl, focusJobId).then(job => {
        if (currentId === requestId.current) setFocusedJob(job)
      }).catch(cause => {
        if (currentId === requestId.current)
          setError(`无法读取指定发布任务 ${focusJobId}：${describeApiError(cause)}`)
      }).finally(() => {
        if (currentId === requestId.current) setLoading(false)
      })
      return () => { requestId.current++ }
    }
    setFocusedJob(null)
    const read = kind === 'jobs'
      ? fetchPublishJobPage(baseUrl, { limit: MERCHANT_PUBLISH_PAGE_SIZE, offset: jobPage * MERCHANT_PUBLISH_PAGE_SIZE })
      : fetchManualPublishRecordPage(baseUrl, { limit: MERCHANT_PUBLISH_PAGE_SIZE, offset: manualPage * MERCHANT_PUBLISH_PAGE_SIZE })
    read.then(page => {
      if (currentId !== requestId.current) return
      const lastPage = Math.max(0, Math.ceil(page.total / MERCHANT_PUBLISH_PAGE_SIZE) - 1)
      if (kind === 'jobs') {
        setJobs(page as ApiPage<PublishJob>)
        setJobPage(current => Math.min(current, lastPage))
      } else {
        setManual(page as ApiPage<ManualPublishRecord>)
        setManualPage(current => Math.min(current, lastPage))
      }
    }).catch(cause => {
      if (currentId !== requestId.current) return
      setError(describeApiError(cause))
      if (kind === 'jobs') setJobs(null)
      else setManual(null)
    }).finally(() => {
      if (currentId === requestId.current) setLoading(false)
    })
    return () => { requestId.current++ }
  }, [baseUrl, kind, jobPage, manualPage, reload, focusJobId])

  const tabId = (target: HistoryKind) => `${tabsId}-${target}-tab`
  const tabPanelId = (target: HistoryKind) => `${tabsId}-${target}-panel`
  const openTask = (taskId: string) => urlForMerchantRoute(window.location, { page: 'task', target: { kind: 'task', taskId } })
  const moveHistoryTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    const currentIndex = tabs.indexOf(event.currentTarget)
    if (currentIndex < 0 || tabs.length === 0) return
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    const next = tabs[nextIndex]
    next.focus()
    next.click()
  }

  return (
    <section className="panel task-list-panel" aria-label="发布记录">
      <div className="section-heading">
        <div><h3>发布记录</h3><p>查看本工作区可见任务的发布状态与人工证据。人工报告不能证明平台已发布。</p></div>
        <button type="button" className="secondary-button" onClick={() => setReload(value => value + 1)} disabled={!baseUrl || loading}>刷新记录</button>
      </div>
      <div className="asset-entry-tabs" role="tablist" aria-label="发布记录类型">
        <button id={tabId('jobs')} type="button" role="tab" aria-controls={tabPanelId('jobs')} aria-selected={kind === 'jobs'} tabIndex={kind === 'jobs' ? 0 : -1} onKeyDown={moveHistoryTab} onClick={() => setKind('jobs')}>发布任务</button>
        <button id={tabId('manual')} type="button" role="tab" aria-controls={tabPanelId('manual')} aria-selected={kind === 'manual'} tabIndex={kind === 'manual' ? 0 : -1} onKeyDown={moveHistoryTab} onClick={() => setKind('manual')}>人工发布报告</button>
      </div>
      {!baseUrl && <div className="info-notice" role="status">配置服务端后可读取真实发布记录。</div>}
      {baseUrl && loading && <div className="info-notice" role="status">正在读取发布记录…</div>}
      {baseUrl && !loading && error && <div className="error-notice" role="alert">{focusJobId && kind === 'jobs' ? error : `读取发布记录失败：${error}`} <button type="button" onClick={() => setReload(value => value + 1)}>重试</button>{focusJobId && kind === 'jobs' && <a className="text-button" href={urlForMerchantRoute(window.location, { page: 'task' })}>返回发布记录列表</a>}</div>}
      <div id={tabPanelId('jobs')} role="tabpanel" aria-labelledby={tabId('jobs')} tabIndex={0} hidden={kind !== 'jobs'}>
        {baseUrl && !loading && !error && kind === 'jobs' && !focusJobId && jobs?.total === 0 && <div className="empty-state">当前没有发布任务。</div>}
        {baseUrl && !loading && !error && kind === 'jobs' && focusJobId && focusedJob && <PublishJobRecord job={focusedJob} taskHref={openTask(focusedJob.taskId)} focusJobId={focusJobId} />}
        {baseUrl && !loading && !error && kind === 'jobs' && !focusJobId && jobs?.items.map(job => <PublishJobRecord key={job.id} job={job} taskHref={openTask(job.taskId)} />)}
        {baseUrl && !loading && !error && kind === 'jobs' && !focusJobId && jobs && jobs.total > 0 && <div className="task-list-pagination">
          <span>第 {jobPage + 1} / {Math.max(1, Math.ceil(jobs.total / MERCHANT_PUBLISH_PAGE_SIZE))} 页，共 {jobs.total} 条</span>
          <div>
            <button type="button" onClick={() => setJobPage(value => value - 1)} disabled={jobPage === 0}>上一页</button>
            <button type="button" onClick={() => setJobPage(value => value + 1)} disabled={jobPage + 1 >= Math.max(1, Math.ceil(jobs.total / MERCHANT_PUBLISH_PAGE_SIZE))}>下一页</button>
          </div>
        </div>}
      </div>
      <div id={tabPanelId('manual')} role="tabpanel" aria-labelledby={tabId('manual')} tabIndex={0} hidden={kind !== 'manual'}>
        {baseUrl && !loading && !error && kind === 'manual' && manual?.total === 0 && <div className="empty-state">当前没有人工发布报告。</div>}
        {baseUrl && !loading && !error && kind === 'manual' && manual?.items.map(record => <ManualPublishRecordRow key={record.id} record={record} taskHref={openTask(record.taskId)} />)}
        {baseUrl && !loading && !error && kind === 'manual' && manual && manual.total > 0 && <div className="task-list-pagination">
          <span>第 {manualPage + 1} / {Math.max(1, Math.ceil(manual.total / MERCHANT_PUBLISH_PAGE_SIZE))} 页，共 {manual.total} 条</span>
          <div>
            <button type="button" onClick={() => setManualPage(value => value - 1)} disabled={manualPage === 0}>上一页</button>
            <button type="button" onClick={() => setManualPage(value => value + 1)} disabled={manualPage + 1 >= Math.max(1, Math.ceil(manual.total / MERCHANT_PUBLISH_PAGE_SIZE))}>下一页</button>
          </div>
        </div>}
      </div>
    </section>
  )
}
