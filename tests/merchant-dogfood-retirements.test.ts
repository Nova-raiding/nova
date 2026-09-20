/**
 * Merchant dogfood retirement gate.
 *
 * The failure this exists for: the reviewed merchant UI (`fdd6deac`,
 * `c2eafb72`, `2e055921`) removed a set of merchant-facing safety surfaces, so
 * part of the desktop dogfood suite could no longer mean anything. Those
 * assertions were retired and written down in
 * `dogfood/chatgpt-all-functions/retired-merchant-assertions.md` instead of
 * being silently deleted.
 *
 * A written record on its own rots: the next person re-adds `.environment-banner`
 * to a spec, the suite stays green, and the retirement is quietly undone. This
 * gate pins both directions — the retired assertions stay out of the specs, and
 * every retired assertion stays named in the record. Adding a new retirement
 * means adding it here too, which is the point.
 *
 * Only *code forms* are matched, never bare words: the specs document each
 * retirement in a comment that necessarily names the removed surface, and a
 * substring ban would forbid explaining the very thing it pins.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const specDir = resolve(root, 'dogfood/chatgpt-all-functions')
const record = readFileSync(resolve(specDir, 'retired-merchant-assertions.md'), 'utf8')

function merchantSpecs(): { name: string; source: string }[] {
  return readdirSync(specDir)
    .filter(name => name.startsWith('merchant') && name.endsWith('.spec.js'))
    .map(name => ({ name, source: readFileSync(resolve(specDir, name), 'utf8') }))
}

/** Assertion call sites that must not come back, with the surface they reached for. */
const RETIRED_CODE_FORMS: { form: string; surface: string }[] = [
  { form: "locator('.environment-banner')", surface: '环境横幅（2e055921 卸载）' },
  { form: "name: /系统健康/", surface: '系统健康工具入口（2e055921 移除）' },
  { form: "name: '查看系统健康'", surface: '环境横幅上的健康入口（2e055921 移除）' },
  { form: "getByRole('button', { name: '知识库', exact: true })", surface: '知识库一级入口（fdd6deac 改为分组标签）' },
  { form: 'name: /商品目录/', surface: '知识库 > 商品目录二级入口（fdd6deac 移除）' },
  { form: "name: '同步全部店铺'", surface: '概览同步入口（c2eafb72 按视觉评审隐藏）' },
  { form: "'暂无营销任务'", surface: '营销任务队列（fdd6deac 移除入口）' },
  { form: 'rules-api-empty', surface: '规则库空态（fdd6deac 移除）' },
  { form: 'categories-api-empty', surface: '品类库空态（fdd6deac 移除）' },
  { form: 'utilitySections', surface: '查看系统健康与上线状态遍历（2e055921 移除）' },
  { form: 'openKnowledgeEntry', surface: '知识库二级入口辅助函数（随入口一并移除）' },
]

/** Test titles that no longer have a surface to assert against. */
const RETIRED_TEST_TITLES = [
  'model relay readiness is visible before a merchant starts a task',
  'fixture health never presents the merchant workspace as production ready',
  'closed writes keep a production-mode workspace visibly blocked',
  'rule and category API failures never reveal demos and independent retries recover real data',
  'successful empty rule and category APIs show true empty states without demos',
  'task list shows loading, then a true empty state only after a successful response',
  'task list keeps error distinct from empty and retry can recover to data',
  'task list remains visible when auxiliary product identity fails and retry recovers',
  'knowledge navigation keeps publishing inside the marketing task workflow',
  'both sync-all entry points target every readable store including same-platform stores',
  'store discovery failure disables sync and sends no sync request',
]

describe('merchant dogfood retirements', () => {
  it('discovers the merchant specs it is meant to guard', () => {
    const names = merchantSpecs().map(spec => spec.name)
    expect(names).toContain('merchant-all.spec.js')
    expect(names).toContain('merchant-data-safety.spec.js')
    expect(names).toContain('merchant-interactions.spec.js')
  })

  it.each(RETIRED_CODE_FORMS)('keeps $form out of the merchant specs ($surface)', ({ form }) => {
    const offenders = merchantSpecs()
      .filter(spec => spec.source.includes(form))
      .map(spec => spec.name)
    expect(
      offenders,
      `${form} asserts a surface the reviewed UI removed (${form}). Re-anchoring it needs a deliberate decision and an update to retired-merchant-assertions.md, not a silent re-add.`,
    ).toEqual([])
  })

  it.each(RETIRED_TEST_TITLES)('keeps the retired test "%s" retired', title => {
    const offenders = merchantSpecs()
      .filter(spec => spec.source.includes(`test('${title}'`))
      .map(spec => spec.name)
    expect(offenders, `retired test returned: ${title}`).toEqual([])
  })

  it('names every retired assertion in the written record', () => {
    const missing = [...RETIRED_CODE_FORMS.map(entry => entry.form), ...RETIRED_TEST_TITLES]
      .filter(entry => !record.includes(entry))
    expect(
      missing,
      'the retirement record must name every retirement this gate enforces, otherwise the record and the suite disagree',
    ).toEqual([])
  })
})
