import type { ApiHealth, PlatformModelStatus } from './api'

export type MerchantEnvironmentState =
  | 'offline'
  | 'unavailable'
  | 'checking'
  | 'demo'
  | 'manual'
  | 'blocked'
  | 'ready'

export interface MerchantEnvironmentPresentation {
  state: MerchantEnvironmentState
  tone: 'ready' | 'warning'
  topbarLabel: string
  title: string
  detail: string
  facts: string[]
  actions: string[]
}

interface MerchantEnvironmentInput {
  apiBaseUrl?: string
  apiOnline: boolean | null
  apiHealth: ApiHealth | null
  modelStatus: PlatformModelStatus | null
  modelStatusRead: boolean
}

const modeLabels: Record<string, string> = {
  fixture: '样例数据',
  demo: '当前服务',
  test: '测试',
  local: '本地开发',
  production: '生产',
}

const demoModes = new Set(['fixture', 'demo', 'test', 'local'])

function modelFact(
  modelStatus: PlatformModelStatus | null,
  modelStatusRead: boolean,
) {
  if (!modelStatusRead) return '模型中转：读取中'
  if (!modelStatus) return '模型中转：读取失败，服务端不会放行生成'
  return `模型中转：${modelStatus.state === 'ready' ? '当前环境可用' : '未就绪，服务端会阻止生成'}`
}

export function resolveMerchantEnvironmentStatus({
  apiBaseUrl,
  apiOnline,
  apiHealth,
  modelStatus,
  modelStatusRead,
}: MerchantEnvironmentInput): MerchantEnvironmentPresentation {
  if (!apiBaseUrl) {
    return {
      state: 'offline',
      tone: 'warning',
      topbarLabel: '未连接服务',
      title: '尚未连接工作区服务',
      detail: '未配置工作区 API，不会读取或写入真实店铺数据。',
      facts: ['API 连通：未配置', '发布身份：未核验', modelFact(modelStatus, modelStatusRead)],
      actions: ['配置工作区 API 后重新检查上线状态。'],
    }
  }

  if (apiOnline === false) {
    return {
      state: 'unavailable',
      tone: 'warning',
      topbarLabel: 'API 不可用',
      title: 'API 暂不可用',
      detail: '无法读取服务端健康状态；同步、生成和发布不会在离线状态下伪造成功。',
      facts: ['API 连通：失败', '发布身份：无法确认', modelFact(modelStatus, modelStatusRead)],
      actions: ['检查 API 地址、鉴权和服务状态后重新检查。'],
    }
  }

  if (apiOnline !== true || !apiHealth) {
    return {
      state: 'checking',
      tone: 'warning',
      topbarLabel: '状态待确认',
      title: '正在确认环境状态',
      detail: '尚未取得完整的服务端健康证据，当前环境与发布身份均未核验。',
      facts: ['API 连通：检查中', '发布身份：待确认', modelFact(modelStatus, modelStatusRead)],
      actions: ['等待健康检查完成；若长时间无结果，请检查 API 鉴权。'],
    }
  }

  const mode = apiHealth.setup?.mode?.trim().toLowerCase() || 'unknown'
  const modeLabel = modeLabels[mode] ?? mode
  const isDemo = demoModes.has(mode)
  const platformOperationsMode = apiHealth.setup?.platformOperations?.mode?.trim().toLowerCase() || 'unknown'
  const manualPlatformOperations = platformOperationsMode === 'manual'
  const officialApiPlatformOperations = platformOperationsMode === 'official_api'
  const platformOperationsReady = apiHealth.setup?.platformOperations?.ready
  const automatedWritesEnabled = apiHealth.setup?.platformOperations?.automatedWritesEnabled
  const productionGate = apiHealth.setup?.productionGate
  const writesEnabled = apiHealth.writesEnabled
  const modelReady = modelStatusRead && modelStatus?.state === 'ready'
  const productionReady = mode === 'production'
    && productionGate === true
    && platformOperationsReady === true
    && (manualPlatformOperations
      ? automatedWritesEnabled === false
      : officialApiPlatformOperations && automatedWritesEnabled === true && writesEnabled === true)
    && modelReady
  const blockers: string[] = []

  if (isDemo) blockers.push(mode === 'fixture' ? '当前使用样例数据，不能作为业务证据' : '当前服务能力尚未完成核验')
  else if (mode !== 'production') blockers.push('运行环境未核验')
  if (!manualPlatformOperations && !officialApiPlatformOperations) blockers.push('未返回可识别的平台运营模式')
  if (platformOperationsReady === false) blockers.push('平台运营未就绪')
  else if (platformOperationsReady !== true) blockers.push('未返回平台运营就绪证据')
  if (manualPlatformOperations && automatedWritesEnabled !== false) blockers.push('自动平台写入边界未确认')
  if (officialApiPlatformOperations && writesEnabled === false) blockers.push('官方接口写入已关闭')
  else if (officialApiPlatformOperations && writesEnabled !== true) blockers.push('未返回官方接口写入能力证据')
  if (officialApiPlatformOperations && automatedWritesEnabled !== true) blockers.push('官方接口自动写入未就绪')
  if (mode === 'production') {
    if (productionGate === false) blockers.push('生产上线门禁未通过')
    else if (productionGate !== true) blockers.push('未返回生产上线门禁证据')
  }
  if (isDemo) blockers.push('当前环境验收与发布身份未核验')
  if (!modelStatusRead) blockers.push('模型中转状态仍在读取')
  else if (!modelReady) blockers.push('模型中转未就绪')

  const facts = [
    'API 连通：正常',
    `运行模式：${modeLabel}`,
    ...(manualPlatformOperations ? [] : [`平台运营：${officialApiPlatformOperations ? '官方接口' : '未确认'}`]),
    `自动平台写入：${automatedWritesEnabled === true ? '已开放' : automatedWritesEnabled === false ? '已关闭' : '未确认'}`,
    isDemo ? '环境验收：待核验；发布身份：未核验'
      : mode === 'production' ? `生产门禁：${productionGate === true ? '已通过' : productionGate === false ? '未通过' : '未确认'}`
        : '运行环境与发布身份：未核验',
    modelFact(modelStatus, modelStatusRead),
  ]
  const actions: string[] = []
  if (isDemo)
    actions.push('请在运营后台核对当前环境的验收证据与发布身份。')
  if (officialApiPlatformOperations && (writesEnabled !== true || automatedWritesEnabled !== true))
    actions.push('请管理员检查官方接口写入能力；当前页面不会提交真实平台写入。')
  if (mode === 'production' && productionGate !== true)
    actions.push('请管理员在运营后台查看并处理未通过或缺失的生产门禁。')

  if (productionReady) {
    return {
      state: 'ready',
      tone: 'ready',
      topbarLabel: '生产就绪',
      title: '生产环境已就绪',
      detail: manualPlatformOperations
        ? '生产上线门禁和模型中转已通过服务端检查。'
        : '生产上线门禁、官方接口写入和模型中转均已通过服务端检查。',
      facts,
      actions,
    }
  }

  const modelDetail = modelReady
    ? '模型中转配置就绪不等于实际调用、用量与成本证据已核验。'
    : '生成、图片、OCR 和视频能力将继续受服务端门禁限制。'

  return {
    state: isDemo ? 'demo' : 'blocked',
    tone: 'warning',
    topbarLabel: isDemo ? '服务待核验' : '不可上线',
    title: isDemo ? '服务能力待核验' : '当前环境不可上线',
    detail: `${blockers.join('；')}。${modelDetail}`,
    facts,
    actions,
  }
}
