import { useEffect, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { spreadsheetFactsToBatchProducts } from '../../../packages/application/src/spreadsheet-batch.js'
import {
  catalogImportBatch,
  confirmProductFacts,
  confirmAssetFacts,
  fetchAssets,
  parseAsset,
  uploadAsset,
  type AssetMetadata,
  type PlatformAccount,
  type PlatformId,
} from './api.js'

type SpreadsheetProduct = {
  platform?: PlatformId
  account_id?: string
  title?: string
  local_product_key?: string
  remote_id?: string
  category?: string
  price?: number
  stock?: number
  skus?: Array<{ id: string; name: string; price: number; stock: number; attributes?: Record<string, string> }>
}

export type SpreadsheetImportMode = 'draft_only' | 'store'

export function validateSpreadsheetImportMode(
  products: SpreadsheetProduct[],
  mode: SpreadsheetImportMode,
  accounts: PlatformAccount[],
): string | null {
  if (!products.length) return '表格中没有可导入的商品。'
  for (const [index, product] of products.entries()) {
    if (!product.platform || !product.title) return `第 ${index + 1} 个商品缺少平台或商品名称。`
    if (mode === 'draft_only') continue
    const accountId = product.account_id?.trim()
    if (!accountId) return `第 ${index + 1} 个商品未填写店铺账号；真实店铺导入不能创建无归属商品。`
    const account = accounts.find((item) => item.platform === product.platform && item.accountId === accountId)
    if (!account?.readEnabled) return `第 ${index + 1} 个商品的店铺账号未连接或不可读取：${accountId}`
  }
  return null
}

const spreadsheetMime = (name: string) => name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * Preview rows for the confirmation table.
 *
 * Every row resolves its own store account. The table used to look the account
 * up by product title, so two rows sharing a title — the same product listed on
 * a second platform, or the same name twice in one sheet — both rendered the
 * first product's account: the merchant is asked to verify this table before a
 * real-store import, and it named a store that row would not be imported into.
 * The label lives on the row so the table cannot re-derive it.
 */
export function spreadsheetPreviewRows(products: SpreadsheetProduct[], mode: SpreadsheetImportMode) {
  return products.flatMap((product, index) => (product.skus?.length
    ? product.skus.map((sku) => ({ key: `${index}-${sku.id}`, title: product.title, sku: sku.id, price: sku.price, stock: sku.stock, accountId: product.account_id ?? '' }))
    : [{ key: `${index}`, title: product.title, sku: '—', price: product.price, stock: product.stock, accountId: product.account_id ?? '' }]))
    .map((row) => ({ ...row, storeLabel: row.accountId || (mode === 'draft_only' ? '仅草稿' : '待填写') }))
}

export function ProductSpreadsheetImport({
  baseUrl,
  accounts,
  canWrite,
}: {
  baseUrl?: string
  accounts: PlatformAccount[]
  canWrite: boolean
}) {
  const [mode, setMode] = useState<SpreadsheetImportMode>('draft_only')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [error, setError] = useState('')
  const [asset, setAsset] = useState<AssetMetadata | null>(null)
  const [products, setProducts] = useState<SpreadsheetProduct[]>([])
  const [importedIds, setImportedIds] = useState<string[]>([])
  const errorRef = useRef<HTMLDivElement>(null)
  const runRef = useRef(0)

  useEffect(() => () => { runRef.current += 1 }, [])
  useEffect(() => {
    if (!error || busy) return
    window.requestAnimationFrame(() => errorRef.current?.focus({ preventScroll: true }))
  }, [busy, error])

  const reset = () => {
    runRef.current += 1
    setAsset(null); setProducts([]); setImportedIds([]); setError(''); setPhase('')
  }

  const inspect = async (assetId: string, run: number) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (run !== runRef.current) return
      const current = (await fetchAssets(baseUrl!)).find((item) => item.id === assetId)
      if (current?.scanStatus === 'rejected' || current?.scanStatus === 'quarantined') throw new Error('文件未通过安全检查，请检查内容后重新上传。')
      if (current?.scanStatus === 'clean') {
        setPhase('正在解析商品与 SKU…')
        if (current.parseStatus !== 'succeeded') await parseAsset(baseUrl!, assetId)
        const parsed = (await fetchAssets(baseUrl!)).find((item) => item.id === assetId)
        if (!parsed?.extractedFacts || parsed.parseStatus !== 'succeeded') {
          if (parsed?.parseStatus === 'failed') throw new Error(parsed.parseError || '表格解析失败，请修正文件后重试。')
          throw new Error('表格解析尚未完成，请稍后点击继续检查。')
        }
        const preview = spreadsheetFactsToBatchProducts(parsed.extractedFacts) as SpreadsheetProduct[]
        if (run === runRef.current) { setAsset(parsed); setProducts(preview); setPhase('请核对预览，并选择草稿或真实店铺导入。') }
        return
      }
      setPhase('正在进行文件安全检查…')
      await new Promise((resolve) => window.setTimeout(resolve, 1500))
    }
    throw new Error('文件仍在安全检查中，文件已保留；请稍后点击继续检查。')
  }

  const upload = async (file: File) => {
    if (!baseUrl || !canWrite || busy) return
    if (!/\.(xlsx|csv)$/iu.test(file.name) || file.size > 10 * 1024 * 1024) {
      setError('请选择不超过 10MB 的 .xlsx 或 .csv 文件；旧版 .xls 请另存为 .xlsx。')
      return
    }
    const run = ++runRef.current
    setBusy(true); setError(''); setAsset(null); setProducts([]); setImportedIds([]); setPhase('正在上传表格…')
    try {
      const uploaded = await uploadAsset(baseUrl, new File([await file.arrayBuffer()], file.name, { type: spreadsheetMime(file.name) }))
      setAsset(uploaded)
      await inspect(uploaded.id, run)
    } catch (cause) {
      if (run === runRef.current) setError(cause instanceof Error ? cause.message : '上传失败')
    } finally {
      if (run === runRef.current) setBusy(false)
    }
  }

  const commit = async () => {
    if (!baseUrl || !asset || !products.length || busy) return
    const validation = validateSpreadsheetImportMode(products, mode, accounts)
    if (validation) { setError(validation); return }
    const run = ++runRef.current
    setBusy(true); setError(''); setPhase('正在确认表格事实…')
    try {
      const facts = asset.extractedFacts ?? {}
      await confirmAssetFacts(baseUrl, asset.id, facts, '商家核对 Excel/CSV 商品与 SKU 预览后确认')
      setPhase(mode === 'draft_only' ? '正在创建仅草稿商品…' : '正在绑定真实店铺并导入商品…')
      const normalized = mode === 'draft_only' ? products.map(({ account_id: _ignored, ...product }) => product) : products
      const result = await catalogImportBatch(baseUrl, {
        source_asset_id: asset.id,
        products_json: JSON.stringify(normalized),
        ...(mode === 'draft_only' ? { draft_only: 'true' as const } : {}),
      })
      const ids = (result.products ?? []).map((item) => item.id || item.product_id).filter((id): id is string => Boolean(id))
      if (!ids.length) throw new Error('服务端未返回商品编号，未显示为成功。')
      setPhase('正在确认商品事实，准备进入内容生产…')
      const confirmations = await Promise.allSettled(ids.map((id) => confirmProductFacts(baseUrl, id)))
      const failed = confirmations.filter((item) => item.status === 'rejected').length
      if (run !== runRef.current) return
      setImportedIds(ids)
      setPhase(failed ? `已创建 ${ids.length} 个商品，但有 ${failed} 个商品事实仍需重试确认。` : mode === 'draft_only' ? `已创建 ${ids.length} 个草稿商品；不可同步或发布。` : `已导入并确认 ${ids.length} 个真实店铺商品。`)
    } catch (cause) {
      if (run === runRef.current) setError(cause instanceof Error ? cause.message : '导入失败')
    } finally {
      if (run === runRef.current) setBusy(false)
    }
  }

  const rows = spreadsheetPreviewRows(products, mode)
  const storeModeBlocked = !accounts.some((account) => account.readEnabled && account.accountId)

  return <section className="table-panel merchant-spreadsheet-import" data-testid="merchant-product-spreadsheet-import" aria-labelledby="merchant-spreadsheet-import-title">
    <div className="panel-head"><div><span className="section-kicker">PRODUCT IMPORT</span><h3 id="merchant-spreadsheet-import-title">Excel / CSV 导入商品与 SKU</h3><p>上传后先完成安全检查和预览，再创建商品；每个 SKU 会按商品货号自动合并。</p></div><button className="secondary" type="button" onClick={reset} disabled={busy || (!asset && !products.length)}>重新开始</button></div>
    <div className="spreadsheet-import-body">
      <fieldset className="import-mode-picker"><legend>导入方式</legend>
        <label><input type="radio" name="merchant-import-mode" checked={mode === 'draft_only'} onChange={() => setMode('draft_only')} disabled={busy} /><span><b>仅草稿</b><small>无需店铺账号；创建待审核知识候选，不可同步或发布。</small></span></label>
        <label><input type="radio" name="merchant-import-mode" checked={mode === 'store'} onChange={() => setMode('store')} disabled={busy || storeModeBlocked} /><span><b>绑定真实店铺</b><small>{storeModeBlocked ? '当前没有可读取的已连接店铺。' : '表格每行必须填写已连接且可读取的店铺账号。'}</small></span></label>
      </fieldset>
      <div className="button-row"><label className="file-button"><Upload aria-hidden="true" size={16} />上传 .xlsx / .csv<input type="file" accept=".xlsx,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = '' }} disabled={!baseUrl || !canWrite || busy} /></label>{asset && !products.length && <button className="secondary" type="button" onClick={() => void inspect(asset.id, runRef.current)} disabled={busy}>继续检查</button>}</div>
      {!baseUrl && <div className="info-notice" role="status">商家 API 尚未配置，上传入口已关闭。</div>}
      {!canWrite && <div className="info-notice" role="status">当前账号没有商品导入权限。</div>}
      {asset && <p className="source-note">当前文件：<b>{asset.name}</b> · revision {asset.revision} · 已确认素材事实后才能提交</p>}
      {error && <div ref={errorRef} id="merchant-spreadsheet-import-error" className="error-notice" role="alert" tabIndex={-1} aria-live="assertive"><b>无法导入</b><span>{error}</span></div>}
      {phase && <div className="info-notice" role="status" aria-live="polite">{phase}</div>}
      {!!rows.length && <><div className="import-preview-summary"><b>预览：{products.length} 个商品，{rows.length} 个 SKU / 商品记录</b><span>{mode === 'draft_only' ? '草稿模式：不会写入任何平台店铺' : '真实店铺模式：按表格中的店铺账号绑定'}</span></div><div className="table-wrap"><table><thead><tr><th>商品</th><th>SKU</th><th>店铺账号</th><th>价格（元）</th><th>库存</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><td>{row.title}</td><td>{row.sku}</td><td>{row.storeLabel}</td><td>{row.price}</td><td>{row.stock}</td></tr>)}</tbody></table></div><button className="primary" type="button" onClick={() => void commit()} disabled={busy || !!importedIds.length || !canWrite}>{importedIds.length ? '已提交' : mode === 'draft_only' ? '确认并创建草稿' : '确认并导入真实店铺'}</button></>}
      {!!importedIds.length && <p className="source-note">商品编号：{importedIds.join('、')}。请在商品目录中继续审核事实、知识权益和索引状态。</p>}
    </div>
  </section>
}
