import { writeFileSync } from 'node:fs'
import { readBoundedResponseText } from '../packages/connectors/src/bounded-response.js'

type ProbeResult = {
  modality: 'text' | 'image' | 'image_edit' | 'ocr' | 'video'
  state: 'ready' | 'blocked' | 'not_run_cost_guard' | 'skipped_input'
  endpoint: string
  model: string
  httpStatus?: number
  providerRequestId?: string
  usageObserved?: boolean
  costObserved?: boolean
  detail?: string
}

const source = process.env.MODEL_RELAY_BASE_URL?.trim() ?? ''
const key = process.env.MODEL_RELAY_API_KEY?.trim() ?? ''
const confirmCost = process.env.MODEL_RELAY_CANARY_CONFIRM === 'true'
const timeoutMs = Math.min(30_000, Math.max(2_000, Number(process.env.MODEL_RELAY_CANARY_TIMEOUT_MS ?? 15_000)))
const base = source.replace(/\/+$/u, '')

function modelFor(modality: ProbeResult['modality']) {
  if (modality === 'text') return process.env.AI_MODEL?.trim() || process.env.MODEL_ID?.trim() || ''
  if (modality === 'image') return process.env.IMAGE_MODEL?.trim() || process.env.AI_IMAGE_MODEL?.trim() || ''
  if (modality === 'image_edit') return process.env.IMAGE_EDIT_MODEL?.trim() || process.env.IMAGE_MODEL?.trim() || process.env.AI_IMAGE_MODEL?.trim() || ''
  if (modality === 'ocr') return process.env.OCR_MODEL?.trim() || process.env.AI_VISION_MODEL?.trim() || ''
  return process.env.VIDEO_MODEL?.trim() || process.env.AI_VIDEO_MODEL?.trim() || ''
}

function endpointFor(modality: ProbeResult['modality']) {
  if (modality === 'text' || modality === 'ocr') return '/chat/completions'
  if (modality === 'image') return '/images/generations'
  if (modality === 'image_edit') return '/images/edits'
  return process.env.VIDEO_GENERATION_PATH?.trim() || '/video/generations'
}

function usageFields(payload: unknown, headers: Headers) {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const usage = record.usage && typeof record.usage === 'object' ? record.usage : undefined
  const cost = record.cost_cny ?? record.cost ?? headers.get('x-model-cost-cny')
  return { usageObserved: Boolean(usage), costObserved: cost !== undefined && cost !== null && cost !== '' }
}

async function probe(modality: ProbeResult['modality']): Promise<ProbeResult> {
  const model = modelFor(modality)
  const endpoint = endpointFor(modality)
  const common = { modality, endpoint, model }
  if (!model) return { ...common, state: 'blocked', detail: 'model_missing' }
  if (!confirmCost && ['image', 'image_edit', 'video'].includes(modality)) return { ...common, state: 'not_run_cost_guard', detail: 'set MODEL_RELAY_CANARY_CONFIRM=true to run potentially billable media probes' }
  if (modality === 'image_edit' && !process.env.MODEL_RELAY_CANARY_SOURCE_ASSET_REF?.trim()) return { ...common, state: 'skipped_input', detail: 'set MODEL_RELAY_CANARY_SOURCE_ASSET_REF to run the relay-owned edit probe' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body = modality === 'text'
      ? { model, temperature: 0, max_tokens: 8, messages: [{ role: 'user', content: '只返回 OK' }] }
      : modality === 'ocr'
        ? { model, temperature: 0, max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: '只返回 JSON：{"ocr_text":"OK"}' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg==' } }] }] }
        : modality === 'image'
          ? { model, prompt: '生成一张 64x64 的纯白测试图，只用于中转站连通性验收', n: 1, size: '64x64', response_format: 'b64_json' }
          : modality === 'image_edit'
            ? { model, prompt: '对测试素材做最小编辑：保持主体不变', source_asset_refs: [process.env.MODEL_RELAY_CANARY_SOURCE_ASSET_REF!.trim()], edit_region: { x: 0, y: 0, width: 1, height: 1 }, n: 1, response_format: 'b64_json' }
            : { model, prompt: '创建一个最小成本的中转站测试任务', output: 'rendering', context: { canary: true } }
    const response = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-damai-canary': 'true' }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' })
    const payload = await readBoundedResponseText(response, 1 * 1024 * 1024, 'model relay response')
      .then(text => JSON.parse(text) as unknown)
      .catch(() => undefined)
    const measured = usageFields(payload, response.headers)
    const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
    const providerRequestId = response.headers.get('x-request-id') ?? response.headers.get('x-provider-request-id') ?? (typeof payloadRecord.provider_request_id === 'string' ? payloadRecord.provider_request_id : typeof payloadRecord.request_id === 'string' ? payloadRecord.request_id : undefined)
    if (!response.ok) return { ...common, state: 'blocked', httpStatus: response.status, ...(providerRequestId ? { providerRequestId } : {}), ...measured, detail: `relay returned HTTP ${response.status}` }
    const valid = modality === 'text' || modality === 'ocr'
      ? Boolean(payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).choices))
      : modality === 'video'
        ? Boolean(payload && typeof payload === 'object' && ((payload as Record<string, unknown>).id || (payload as Record<string, unknown>).task_id || (payload as Record<string, unknown>).job_id || (payload as Record<string, unknown>).video_url || (payload as Record<string, unknown>).output_url))
        : Boolean(payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).data))
    return { ...common, state: valid ? 'ready' : 'blocked', httpStatus: response.status, ...(providerRequestId ? { providerRequestId } : {}), ...measured, ...(valid ? {} : { detail: 'response shape is incompatible with the merchant relay contract' }) }
  } catch (error) {
    return { ...common, state: 'blocked', detail: error instanceof Error ? error.name === 'AbortError' ? 'timeout' : error.message : 'probe_failed' }
  } finally { clearTimeout(timer) }
}

if (process.argv.includes('--probe')) {
  const results: ProbeResult[] = []
  if (!base || !key) {
    console.error(JSON.stringify({ state: 'blocked', reason: !base ? 'MODEL_RELAY_BASE_URL missing' : 'MODEL_RELAY_API_KEY missing' }))
    process.exitCode = 1
  } else {
    try {
      if (new URL(base).protocol !== 'https:') throw new Error('MODEL_RELAY_BASE_URL must use HTTPS')
      for (const modality of ['text', 'image', 'image_edit', 'ocr', 'video'] as const) results.push(await probe(modality))
      const evidence = { schema_version: '1', release_id: process.env.RELEASE_ID?.trim() || '', generated_at: new Date().toISOString(), relay: base, results }
      const evidencePath = process.env.MODEL_RELAY_EVIDENCE_PATH?.trim()
      if (evidencePath) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
      console.log(JSON.stringify(evidence, null, 2))
      if (results.some(result => result.state !== 'ready' || result.providerRequestId === undefined || result.usageObserved !== true || result.costObserved !== true)) process.exitCode = 1
    } catch (error) {
      console.error(JSON.stringify({ state: 'blocked', reason: error instanceof Error ? error.message : 'relay_probe_failed' }))
      process.exitCode = 1
    }
  }
} else {
  console.error('使用 --probe 才会发起真实中转请求；媒体请求还需要 MODEL_RELAY_CANARY_CONFIRM=true。')
  process.exitCode = 2
}
