/**
 * Ops dogfood retirement gate.
 *
 * The failure this exists for: `365c5d84` converged the platform sidebar and
 * removed a set of ops-console surfaces, so part of the ops dogfood suite could
 * no longer mean anything. Those assertions were retired and written down in
 * `dogfood/chatgpt-all-functions/retired-ops-assertions.md` instead of being
 * silently deleted — but that record was prose only. The ops ledger said so
 * itself, listing "补一个运营台版的门禁测试" as its one machine-enforcement
 * gap. This file closes it, following `tests/merchant-dogfood-retirements.test.ts`.
 *
 * A written record on its own rots: the next person re-adds the withdrawn
 * control to a spec, the suite stays green, and the retirement is quietly
 * undone. This gate pins both directions — the retired surfaces stay out of the
 * specs, and every retirement this gate enforces stays named in the record.
 *
 * The hard part, and why the merchant file's approach did not transfer
 * verbatim: these specs must *name* the surfaces they assert are absent. The
 * reverse gate `keeps the withdrawn model services surface unreachable …` looks
 * for a 模型服务 button precisely to prove it has `toHaveCount(0)`, and the
 * comments explain each retirement by naming it. A bare-word ban over raw
 * source would forbid explaining the very thing it pins, which is the conflict
 * the ops ledger flagged. So the ban is applied to the *assertion surface*: the
 * spec with comments and reverse-gate test blocks removed. What is left is what
 * the walk actually asserts — which is the thing worth pinning.
 *
 * Both directions of that stripping are self-tested below, because a stripper
 * that silently over-matched would make this whole gate pass vacuously.
 *
 * Two ways the first cut of this gate could be walked around, both closed here
 * and both self-tested:
 *  - the reverse-gate exemption keyed on the test *title* alone, so a block could
 *    drop itself out of the ban by naming itself `… withdrawn …` while asserting
 *    the surface is present;
 *  - the guarded set was a two-file literal while the test names said "the ops
 *    specs", so a third spec could re-add a withdrawn surface for free.
 * The guarded set is now the `ops*.spec.js` glob minus the specs the record
 * registers as known-contradictory, and the record cross-check compares two
 * independently derived lists rather than re-reading the ban array it checks.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const specDir = resolve(root, 'dogfood/chatgpt-all-functions')
const record = readFileSync(resolve(specDir, 'retired-ops-assertions.md'), 'utf8')

/**
 * The `ops*.spec.js` glob. The guarded set is discovered from the directory, not
 * listed here, for the same reason the merchant gate globs: a literal list keeps
 * enforcing the specs it names while the test titles claim a coverage the gate
 * does not have.
 */
const OPS_SPEC_GLOB = /^ops[\w-]*\.spec\.js$/u

/**
 * A reverse gate asserts a surface is ABSENT, so it must name it. Tests whose
 * title carries one of these markers are exempted from the ban — but only when
 * the block actually asserts absence: keying on the title alone made the test
 * name a one-word bypass of the entire gate.
 */
const REVERSE_GATE_TITLE = /unreachable|withdrawn/u
const ASSERTS_ABSENCE = /toHaveCount\(0\)/u

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
}

function assertionSurface(source: string): string {
  // Anchored to the start of a line, not to a preceding newline: a source that
  // begins with `test(` has no newline before it, and splitting on `\ntest(`
  // would leave that block glued to index 0 where the filter cannot drop it.
  // The self-test below covers exactly that shape.
  return stripComments(source)
    .split(/^test\(/gmu)
    .filter((block, index) => index === 0 || !isReverseGate(block))
    .join('\n')
}

/** A reverse gate both says absence in its title and asserts it in its body. */
function isReverseGate(block: string): boolean {
  return REVERSE_GATE_TITLE.test(titleOf(block)) && ASSERTS_ABSENCE.test(block)
}

/** The title line of a split test block. `noUncheckedIndexedAccess` makes
 * `split(...)[0]` a `string | undefined`, which is why this is not inlined. */
function titleOf(block: string): string {
  return block.split('\n')[0] ?? ''
}

/**
 * Withdrawn ops surfaces that must not return without a new product decision.
 *
 * `账务与退款` and `平台财务中心` are deliberately NOT here: the owner reversed
 * that half of the withdrawal on 2026-09-20 (docs/qa/four-product-decisions-2026-09-20.md,
 * option A), so both are live navigation facts again — `platformSections` and
 * the `headings` map must carry them, and the reverse gate asserts the finance
 * heading is visible. Only the models half and the never-mounted surfaces stay
 * banned.
 */
const RETIRED_SURFACES: { form: string; note: string }[] = [
  { form: '模型服务', note: '平台侧栏「模型服务」入口（365c5d84 从 navigationGroups 摘除，未随 finance 一起恢复）' },
  { form: "platformSections = ['总览', '用户中心', '模型服务', '账务与退款']", note: '收敛前的一级导航列表（把 models 重新塞回走查）' },
  { form: '导出商业配置', note: '商业配置导出控件（PlanBillingSection 至今无挂载点，finance 恢复也未挂上）' },
  { form: 'ops-commercial-', note: '商业配置导出文件名 ops-commercial-<YYYY-MM-DD>.csv' },
  { form: '导出当前筛选', note: '用户目录导出控件（cc2f01cb 移除）' },
  { form: '认证会话（已脱敏）', note: '用户详情抽屉的脱敏会话段（f84b9561 / 1b7d8799 移除）' },
  { form: '平台身份生命周期', note: '用户详情抽屉的身份生命周期段' },
  { form: '所属租户与角色', note: '用户详情抽屉的租户与角色摘要段' },
  { form: '成员操作历史', note: '用户详情抽屉的成员操作历史段' },
]

/**
 * A spec whose whole body is imports delegates its walk to another file:
 * `ops-delivery-contract-link.spec.js` is a 49-byte re-export, and the assertions
 * live in the fixture it imports.
 */
const DELEGATES_ONLY = /^(?:[^\S\n]*import\s[^\n]*\n?)+$/u

/** The files an import-only spec pulls in, resolved next to it. */
function importedFiles(body: string): string[] {
  return [...body.matchAll(/^[^\S\n]*import\s+(?:[^\n]*?\sfrom\s+)?['"]([^'"]+)['"]/gmu)]
    .map(match => match[1])
    .filter((specifier): specifier is string => specifier !== undefined)
    .map(specifier => resolve(specDir, specifier))
    .filter(file => existsSync(file))
}

/**
 * The file an import-only spec hands its walk to. It has to be the spec's own
 * companion — `ops-delivery-contract-link.spec.js` re-exports
 * `ops-delivery-contract-link.fixture.js`. Pointing at a shared helper must not
 * count, or a spec could shed its coverage by becoming `import './ops-auth.js'`
 * and still read as "asserts something", which is the shape of the failure this
 * whole file exists to stop.
 */
function companionOf(name: string, body: string): string | undefined {
  const stem = name.replace(/\.spec\.js$/u, '')
  return importedFiles(body).find(file => basename(file).startsWith(`${stem}.`))
}

/** Every `ops*.spec.js` on disk, read once — this is the guarded candidate set. */
const DISCOVERED_SPECS: { name: string; source: string; surface: string }[] = readdirSync(specDir)
  .filter(name => OPS_SPEC_GLOB.test(name))
  .sort()
  .map(name => {
    const source = readFileSync(resolve(specDir, name), 'utf8')
    return { name, source, surface: assertionSurface(source) }
  })

function discoveredSpecs(): { name: string; source: string; surface: string }[] {
  return DISCOVERED_SPECS
}

/**
 * Specs the record registers as known-contradictory and deliberately unguarded.
 *
 * `ops-mcp-request-matrix.spec.js` still walks the withdrawn `模型服务` route, so
 * the ban below cannot pass over it; the record's "未处理，仅登记" section is where
 * that is written down. The registration is read *out of the record* rather than
 * listed here, so exempting a spec means editing the record — and removing that
 * section drops the spec back into the guard, so an exemption cannot silently
 * outlive its reason.
 */
function registeredSpecs(): string[] {
  const section = record
    .split(/^## /gmu)
    .find(block => titleOf(block).includes('未处理'))
  if (section === undefined) return []
  return discoveredSpecs()
    .map(spec => spec.name)
    .filter(name => section.includes(name))
}

/** The specs the ban applies to: everything discovered minus the registrations. */
function guardedSpecs(): { name: string; source: string; surface: string }[] {
  const registered = registeredSpecs()
  return discoveredSpecs().filter(spec => !registered.includes(spec.name))
}

/**
 * The record's own copy of the ban list, parsed from the fence under
 * `## 被禁用的断言写法`. This is the *second*, independently derived list: the
 * check below compares it with `RETIRED_SURFACES` instead of asking whether the
 * record mentions each form somewhere, which is what made the cross-check
 * vacuous — one edit to the ban array used to delete the ban and its record
 * requirement together, so the two could never disagree.
 */
function recordedBanForms(): string[] {
  const section = record
    .split(/^## /gmu)
    .find(block => titleOf(block).startsWith('被禁用的断言写法'))
  if (section === undefined) return []
  const fence = /```[^\n]*\n([\s\S]*?)```/u.exec(section)
  if (fence === null) return []
  return (fence[1] ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

describe('ops dogfood retirements', () => {
  it('discovers the ops specs by glob, and guards every one the record has not registered', () => {
    const discovered = discoveredSpecs().map(spec => spec.name)
    const guarded = guardedSpecs().map(spec => spec.name)
    const registered = registeredSpecs()

    // The specs the ledger declares must really be on disk and inside the guard.
    // A glob that matched nothing would empty every ban below; a registration
    // that swallowed a guarded spec would do the same, quietly.
    expect(discovered).toEqual(expect.arrayContaining(['ops-all.spec.js', 'ops-users.spec.js']))
    expect(guarded).toEqual(expect.arrayContaining(['ops-all.spec.js', 'ops-users.spec.js']))

    // The guard is wider than the pair this test used to hardcode — that is the
    // point of discovering the set: a new `ops-*.spec.js` is guarded without
    // anyone remembering to edit this file.
    expect(guarded.length).toBeGreaterThan(2)

    // Nothing discovered is silently dropped: each spec is either guarded or
    // registered in the record, and no registration is stale.
    expect([...guarded, ...registered].sort()).toEqual([...discovered].sort())
    for (const name of registered) expect(discovered).toContain(name)
  })

  it('matches only `ops*.spec.js` names, so discovery cannot sweep in helpers', () => {
    expect(OPS_SPEC_GLOB.test('ops-all.spec.js')).toBe(true)
    expect(OPS_SPEC_GLOB.test('ops.spec.js')).toBe(true)
    expect(OPS_SPEC_GLOB.test('ops-delivery-contract-link.spec.js')).toBe(true)
    // `ops-auth.js` is a helper the specs import, not a spec.
    expect(OPS_SPEC_GLOB.test('ops-auth.js')).toBe(false)
    expect(OPS_SPEC_GLOB.test('ops-delivery-contract-link.fixture.js')).toBe(false)
    expect(OPS_SPEC_GLOB.test('ops-all-inventory.json')).toBe(false)
    expect(OPS_SPEC_GLOB.test('merchant-all.spec.js')).toBe(false)
  })

  it('reads a delegating spec through its own fixture, never a shared helper', () => {
    expect(DELEGATES_ONLY.test("import './ops-delivery-contract-link.fixture.js'")).toBe(true)
    expect(DELEGATES_ONLY.test("import { expect, test } from '@playwright/test'\n")).toBe(true)
    expect(DELEGATES_ONLY.test("import { test } from '@playwright/test'\ntest('walks', async () => {})")).toBe(false)
    // An emptied spec is not a delegation: it must fail the surface invariant
    // rather than read as "nothing left to ban".
    expect(DELEGATES_ONLY.test('')).toBe(false)

    // The shim on disk resolves to its own fixture, and that fixture asserts.
    const shim = "import './ops-delivery-contract-link.fixture.js'"
    const fixture = resolve(specDir, 'ops-delivery-contract-link.fixture.js')
    expect(companionOf('ops-delivery-contract-link.spec.js', shim)).toBe(fixture)
    expect(assertionSurface(readFileSync(fixture, 'utf8'))).toContain('expect(')

    // A spec cannot borrow a shared helper's assertions instead.
    expect(companionOf('ops-workspace-visual.spec.js', "import './ops-auth.js'")).toBeUndefined()
  })

  it('registers nothing the ban is supposed to cover', () => {
    const registered = registeredSpecs()
    // A registration that reached a guarded spec would empty the ban for it.
    expect(registered).not.toContain('ops-all.spec.js')
    expect(registered).not.toContain('ops-users.spec.js')
    // Each one comes from the record, not from this file.
    for (const name of registered) expect(record).toContain(name)
  })

  it('strips absence assertions but keeps positive ones, so the ban has teeth', () => {
    // The exemption must actually work: a reverse-gate block naming a withdrawn
    // surface is removed rather than tripping the ban below.
    const reverseGate = [
      "test('keeps the withdrawn X unreachable', async () => {",
      "  await expect(page.getByRole('button', { name: '导出商业配置' })).toHaveCount(0)",
      '})',
    ].join('\n')
    expect(assertionSurface(reverseGate)).not.toContain('导出商业配置')

    // …and the ban must actually bite: a positive assertion of the same surface
    // survives stripping, so it would be caught.
    const positive = "await expect(page.getByRole('button', { name: '导出商业配置' })).toBeVisible()"
    expect(assertionSurface(positive)).toContain('导出商业配置')

    // The title alone must not buy an exemption: a block that names itself
    // `… withdrawn …` while asserting the surface is present stays in the ban.
    const titleOnly = [
      "test('keeps the withdrawn 导出商业配置 control available to ops', async () => {",
      "  await expect(page.getByRole('button', { name: '导出商业配置' })).toBeVisible()",
      '})',
    ].join('\n')
    expect(assertionSurface(titleOnly)).toContain('导出商业配置')

    // Nor does asserting absence anywhere buy one: a walk that happens to count
    // the surface out is not a reverse gate and keeps its whole surface.
    const absenceWithoutMarker = [
      "test('walk every Ops Console section', async () => {",
      "  await expect(page.getByText('导出商业配置')).toHaveCount(0)",
      '})',
    ].join('\n')
    expect(assertionSurface(absenceWithoutMarker)).toContain('导出商业配置')

    // The strip must not be able to swallow a whole spec, or every ban would
    // pass vacuously. A walk body has to survive it.
    const walk = [
      "test('walk every Ops Console section', async () => {",
      "  await page.getByRole('button', { name: '总览' }).click()",
      '})',
    ].join('\n')
    expect(assertionSurface(walk)).toContain('总览')
  })

  it('leaves a substantial assertion surface in every guarded spec', () => {
    for (const { name, source, surface } of guardedSpecs()) {
      // Guards against the stripper over-matching: a gate reading an emptied
      // surface would be green and meaningless in exactly the way this branch
      // keeps finding elsewhere.
      expect(surface.length, `${name} lost its assertion surface`).toBeGreaterThan(source.length / 2)
      if (surface.includes('expect(')) continue
      // No assertion in the spec itself. That is only legitimate for a spec that
      // re-exports its own fixture, and only when that fixture does assert —
      // otherwise coverage could disappear into a one-line shim while the surface
      // read as "nothing left to ban".
      const body = stripComments(source).trim()
      const companion = DELEGATES_ONLY.test(body) ? companionOf(name, body) : undefined
      expect(companion, `${name} has no assertions and no fixture of its own`).toBeDefined()
      const delegated = companion === undefined ? '' : readFileSync(companion, 'utf8')
      expect(assertionSurface(delegated), `${name} delegates to a file that asserts nothing`).toContain('expect(')
    }
  })

  it.each(RETIRED_SURFACES)('keeps "$form" out of the ops specs ($note)', ({ form }) => {
    const offenders = guardedSpecs()
      .filter(spec => spec.surface.includes(form))
      .map(spec => spec.name)
    expect(
      offenders,
      `${form} asserts a surface the ops console withdrew (${form}). Re-adding it needs a deliberate decision and an update to retired-ops-assertions.md, not a silent re-add.`,
    ).toEqual([])
  })

  it('enforces exactly the ban list the record declares, and nothing it does not', () => {
    // Two independently derived lists: `RETIRED_SURFACES` above and the record's
    // own fence. Comparing them is what makes a divergence detectable — dropping
    // an entry from either side fails here instead of removing a ban and its
    // record requirement in one edit.
    const recorded = recordedBanForms()
    expect(recorded, 'the record no longer declares a ban list this test can read').not.toEqual([])
    expect(
      recorded.length,
      'the record declares a different number of banned forms than this test enforces',
    ).toBe(RETIRED_SURFACES.length)
    expect([...recorded].sort()).toEqual([...RETIRED_SURFACES.map(entry => entry.form)].sort())
  })

  it('does not re-ban the surfaces the owner restored', () => {
    // The complement of the ban: finance was deliberately brought back, so the
    // specs are *supposed* to carry these. If a future edit adds them to the ban
    // list above, this fails and points at the decision.
    const restored = ['账务与退款', '平台财务中心']
    for (const form of restored) {
      expect(RETIRED_SURFACES.map(entry => entry.form)).not.toContain(form)
    }
    const surface = guardedSpecs().find(spec => spec.name === 'ops-all.spec.js')?.surface ?? ''
    expect(surface).toContain('账务与退款')
  })
})
