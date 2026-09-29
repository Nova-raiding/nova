import { useEffect, useRef, useState } from 'react'
import {
  describeApiError,
  fetchManualPublishRecordPage,
  fetchPublishJobPage,
  MERCHANT_PUBLISH_PAGE_SIZE,
  type ApiPage,
  type ManualPublishRecord,
  type PublishJob,
} from './api'
import { urlForMerchantRoute } from './navigation'

const publishStateLabel: Record<string, string> = {
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

export function PublishJobRecord({ job, taskHref }: { job: PublishJob; taskHref: string }) {
  return <article className="task-list-row">
    <div>
      <b>{publishStateLabel[job.remoteState ?? job.state] ?? '状态待核对'} · {platformLabel[job.platform] ?? '未知平台'} · {job.accountId ?? '店铺未绑定'}</b>
      <span>任务 {job.taskId} · 内容版本 {job.contentVersionId} · {new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
      {job.rejection && <div className="error-notice" role="status">
        <b>平台原始拒绝码：{job.rejection.rawCode}</b>
        {job.rejection.message && <span> · {job.rejection.message}</span>}
        {job.rejection.fields.length > 0 && <ul>{job.rejection.fields.map((field, i) => <li key={`${field.path}-${i}`}>字段 {field.path}；原始代码 {field.rawCode ?? '未提供'}；{field.message}</li>)}</ul>}
        <p>根据拒绝原因在任务中创建修正版，重新审核后再确认提交。</p>
      </div>}
      {['unknown', 'reconciling'].includes(job.remoteState ?? job.state) && <div className="info-notice">先核对平台回执和任务历史，当前不要重复提交。</div>}
    </div>
    <a className="text-button" href={taskHref}>查看任务与纠错</a>
  </article>
}

export function ManualPublishRecordRow({ record, taskHref }: { record: ManualPublishRecord; taskHref: string }) {
  return <article className="task-list-row">
    <div>
      <b>{manualStateLabel[record.state] ?? '人工状态待核对'} · {platformLabel[record.platform] ?? '未知平台'} · {record.accountId}</b>
      <span>任务 {record.taskId} · 内容版本 {record.contentVersionId} · {new Date(record.recordedAt).toLocaleString('zh-CN', { hour12: false })}</span>
      <div className="info-notice">这是运营人工报告，未经平台接口验证，不代表平台已发布。</div>
      {record.platformContentId && <span>运营回填的平台内容编号：{record.platformContentId}</span>}
      {record.differenceNote && <span>内容差异：{record.differenceNote}</span>}
    </div>
    <a className="text-button" href={taskHref}>查看任务</a>
  </article>
}

type HistoryKind = 'jobs' | 'manual'

export function PublishHistoryPanel({ baseUrl }: { baseUrl?: string }) {
  const [kind, setKind] = useState<HistoryKind>('jobs')
  const [jobPage, setJobPage] = useState(0)
  const [manualPage, setManualPage] = useState(0)
  const [reload, setReload] = useState(0)
  const [jobs, setJobs] = useState<ApiPage<PublishJob> | null>(null)
  const [manual, setManual] = useState<ApiPage<ManualPublishRecord> | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const requestId = useRef(0)

  useEffect(() => {
    const currentId = ++requestId.current
    setError('')
    if (!baseUrl) return
    setLoading(true)
    const read = kind === 'jobs'
      ? fetchPublishJobPage(baseUrl, { limit: MERCHANT_PUBLISH_PAGE_SIZE, offset: jobPage * MERCHANT_PUBLISH_PAGE_SIZE })
      : fetchManualPublishRecordPage(baseUrl, { limit: MERCHANT_PUBLISH_PAGE_SIZE, offset: manualPage * MERCHANT_PUBLISH_PAGE_SIZE })
    read.then(page => {
      if (currentId !== requestId.current) return
      if (kind === 'jobs') setJobs(page as ApiPage<PublishJob>)
      else setManual(page as ApiPage<ManualPublishRecord>)
    }).catch(cause => {
      if (currentId !== requestId.current) return
      setError(describeApiError(cause))
      if (kind === 'jobs') setJobs(null)
      else setManual(null)
    }).finally(() => {
      if (currentId === requestId.current) setLoading(false)
    })
    return () => { requestId.current++ }
  }, [baseUrl, kind, jobPage, manualPage, reload])

  const page = kind === 'jobs' ? jobs : manual
  const index = kind === 'jobs' ? jobPage : manualPage
  const count = Math.max(1, Math.ceil((page?.total ?? 0) / MERCHANT_PUBLISH_PAGE_SIZE))
  const openTask = (taskId: string) => urlForMerchantRoute(window.location, { page: 'task', target: { kind: 'task', taskId } })

  return (
    <section className="panel task-list-panel" aria-label="发布记录">
      <div className="section-heading">
        <div><h3>发布记录</h3><p>查看本工作区可见任务的发布状态与人工证据。人工报告不能证明平台已发布。</p></div>
        <button type="button" className="secondary-button" onClick={() => setReload(value => value + 1)} disabled={!baseUrl || loading}>刷新记录</button>
      </div>
      <div className="asset-entry-tabs" role="tablist" aria-label="发布记录类型">
        <button type="button" role="tab" aria-selected={kind === 'jobs'} onClick={() => setKind('jobs')}>发布任务</button>
        <button type="button" role="tab" aria-selected={kind === 'manual'} onClick={() => setKind('manual')}>人工发布报告</button>
      </div>
      {!baseUrl && <div className="info-notice" role="status">配置服务端后可读取真实发布记录。</div>}
      {baseUrl && loading && <div className="info-notice" role="status">正在读取发布记录…</div>}
      {baseUrl && !loading && error && <div className="error-notice" role="alert">读取发布记录失败：{error} <button type="button" onClick={() => setReload(value => value + 1)}>重试</button></div>}
      {baseUrl && !loading && !error && page?.total === 0 && <div className="empty-state">当前没有{kind === 'jobs' ? '发布任务' : '人工发布报告'}。</div>}
      {baseUrl && !loading && !error && kind === 'jobs' && jobs?.items.map(job => <PublishJobRecord key={job.id} job={job} taskHref={openTask(job.taskId)} />)}
      {baseUrl && !loading && !error && kind === 'manual' && manual?.items.map(record => <ManualPublishRecordRow key={record.id} record={record} taskHref={openTask(record.taskId)} />)}
      {baseUrl && !loading && !error && page && page.total > 0 && <div className="task-list-pagination">
        <span>第 {index + 1} / {count} 页，共 {page.total} 条</span>
        <div>
          <button type="button" onClick={() => kind === 'jobs' ? setJobPage(value => value - 1) : setManualPage(value => value - 1)} disabled={index === 0}>上一页</button>
          <button type="button" onClick={() => kind === 'jobs' ? setJobPage(value => value + 1) : setManualPage(value => value + 1)} disabled={index + 1 >= count}>下一页</button>
        </div>
      </div>}
    </section>
  )
}
