export type ProtectedProductAttribute =
  | 'color'
  | 'structure'
  | 'material'
  | 'logo'
  | 'packaging_text'
  | 'certification_mark'
  | 'accessories'

export type SafeImageModification = 'background' | 'lighting' | 'composition'

export interface ProtectedProductFinding {
  code: `PROTECTED_PRODUCT_${Uppercase<ProtectedProductAttribute>}_MUTATION`
  severity: 'error'
  attribute: ProtectedProductAttribute
  evidence: string
  message: string
  remediation: string
}

export interface ImmutableProductConstraint {
  attribute: ProtectedProductAttribute
  instructionZh: string
  instructionEn: string
}

export interface SafeImageModificationMatch {
  category: SafeImageModification
  evidence: string
}

export interface ProtectedProductIntentValidation {
  allowed: boolean
  findings: readonly ProtectedProductFinding[]
  immutableConstraints: readonly ImmutableProductConstraint[]
  safeModifications: readonly SafeImageModificationMatch[]
  promptConstraints: Readonly<{ zh: string; en: string }>
}

interface ProtectedRule {
  attribute: ProtectedProductAttribute
  terms: readonly RegExp[]
  implicitMutations?: readonly RegExp[]
  failClosedTerms?: readonly RegExp[]
  failClosedMutations?: readonly RegExp[]
  message: string
}

const mutationAction = /(?:改变|更改|修改|调整|替换|更换|改写|重写|重做|重塑|重构|改成|换成|变成|去掉|移除|删除|抹掉|隐藏|新增|添加|增加|缩小|放大|拉长|压缩|扭曲|重新设计|(?:改|换)(?=(?:商品|产品|物品|鞋子?|包装|标签|颜色|配色|结构|造型|形状|材质|材料|logo|徽标|商标|配件|附件|认证))|\b(?:alter(?:ing)?|adjust(?:ing)?|chang(?:e|ed|ing)|modify|modifying|replace|replacing|rewrit(?:e|ing)|reword(?:ing)?|swap|remove|removing|delete|deleting|erase|hide|hiding|add|adding|redesign|reshape|resize|distort)\b|\bmake\s+(?:it|the\s+(?:product|item|package))\b)/iu

const preservationPatterns = [
  /(?:不要|不应|不得|不能|请勿|禁止|避免|无需|无须|不需要)(?:[^，。；;,.!?]{0,24})(?:改变|更改|修改|调整|替换|更换|重做|重塑|改成|换成|变成|去掉|移除|删除|隐藏|新增|添加)/iu,
  /(?:保持|保留|维持|确保)(?:[^，。；;,.!?]{0,28})(?:不变|原样|原有|原始|一致|完整)/iu,
  /(?:不改变|不更改|不修改|不调整|不替换|不更换|不移除|不删除|不新增|不添加)/iu,
  /(?:do\s+not|don't|never|must\s+not|should\s+not|avoid)(?:[^,.;!?]{0,80})(?:alter|adjust|change|modify|replace|rewrite|reword|remove|delete|hide|add|redesign|reshape|distort)(?:[^,.;!?]{0,32})/iu,
  /(?:without)(?:[^,.;!?]{0,64})(?:altering|adjusting|changing|modifying|replacing|rewriting|removing|adding)(?:[^,.;!?]{0,32})/iu,
  /(?:keep|preserve|retain|leave|maintain)(?:[^,.;!?]{0,80})(?:unchanged|intact|as[ -]?is|original|the\s+same)/iu,
  /(?:no\s+(?:changes?|modifications?)\s+to)/iu,
  /(?:不是|并非)(?:要|想|需要|打算)?(?:[^，。；;,.!?]{0,32})(?:改变|更改|修改|调整|替换|更换|改写|重写|去掉|移除|删除|新增|添加|改|换)/iu,
  /(?:not|isn't|aren't)\s+(?:asking|trying|going|intending)?(?:[^,.;!?]{0,40})(?:alter|adjust|change|modify|replace|rewrite|remove|delete|add)/iu,
]

const affirmativeDoubleNegation = /(?:不要|不能|不可|别|并非|不是)\s*(?:不|没有|未)(?:改变|更改|修改|调整|替换|更换|改写|重写|去掉|移除|删除|新增|添加)|(?:do\s+not|don't|never)\s+(?:keep|leave|preserve|retain)(?:[^,.;!?]{0,48})(?:unchanged|intact|as[ -]?is|original|the\s+same)/iu

const explicitSafeTarget = /(?:背景|场景|环境|布景|光影|光线|灯光|照明|构图|画面|取景|裁切|视角|backdrop|background|scene|setting|lighting|light|composition|layout|framing|crop|camera\s+angle)/iu

const protectedRules: readonly ProtectedRule[] = [
  {
    attribute: 'color',
    terms: [/商品(?:的)?(?:颜色|配色|色彩)/iu, /产品(?:的)?(?:颜色|配色|色彩)/iu, /(?:物品|鞋子?|包包|服装|衣服|瓶子?|盒子?)(?:的)?(?:颜色|配色|色彩)/iu, /(?<!背景)(?<!光影)(?<!灯光)(?<!光线)(?<!环境)配色/iu, /(?:product|item)(?:'s)?\s+(?:color|colour|colorway)/iu, /(?:color|colour)\s+of\s+(?:the\s+)?(?:product|item)/iu, /(?:its?|it'?s)\s+(?:color|colour|colorway)/iu],
    implicitMutations: [/(?:把|将)?(?:商品|产品|物品|鞋子?|包包|服装|衣服|瓶子?|盒子?)(?:整体)?(?:改|换|变|调)(?:成|为)?(?:红|橙|黄|绿|蓝|紫|粉|黑|白|灰|金|银|棕|褐)色?/iu, /(?:make|turn|recolor)\s+(?:the\s+)?(?:product|item|it)\s+(?:red|orange|yellow|green|blue|purple|pink|black|white|grey|gray|gold|silver|brown)/iu],
    failClosedTerms: [/(?:颜色|色彩|配色)/iu, /\b(?:color|colour|colorway)\b/iu],
    failClosedMutations: [/(?:改|换|变|调)(?:成|为)?\s*(?:红|橙|黄|绿|蓝|紫|粉|黑|白|灰|金|银|棕|褐)色?/iu, /(?:make|turn|recolor)\s+(?:it\s+)?(?:red|orange|yellow|green|blue|purple|pink|black|white|grey|gray|gold|silver|brown)/iu],
    message: '请求会改变商品本体颜色或配色。',
  },
  {
    attribute: 'structure',
    terms: [/商品(?:的)?(?:结构|造型|形状|轮廓|比例|尺寸)/iu, /产品(?:的)?(?:结构|造型|形状|轮廓|比例|尺寸)/iu, /(?:鞋子?|包包|服装|衣服|瓶子?|盒子?)(?:的)?(?:结构|造型|形状|轮廓|比例|尺寸)/iu, /(?:product|item)(?:'s)?\s+(?:structure|shape|silhouette|proportions?|dimensions?)/iu, /(?:its?|it'?s)\s+(?:structure|shape|silhouette|proportions?|dimensions?)/iu],
    implicitMutations: [/(?:把|将)?(?:商品|产品)(?:拉长|压扁|缩小|放大|变形|重塑)/iu, /(?:reshape|distort|stretch|squash|resize)\s+(?:the\s+)?(?:product|item)/iu],
    failClosedTerms: [/(?:结构|造型|形状|轮廓|比例|尺寸)/iu, /\b(?:structure|shape|silhouette|proportions?|dimensions?)\b/iu],
    message: '请求会改变商品结构、造型、比例或尺寸。',
  },
  {
    attribute: 'material',
    terms: [/商品(?:的)?(?:材质|材料|质地|纹理)/iu, /产品(?:的)?(?:材质|材料|质地|纹理)/iu, /(?:鞋子?|包包|服装|衣服|瓶子?|盒子?)(?:的)?(?:材质|材料|质地|纹理)/iu, /(?:product|item)(?:'s)?\s+(?:material|fabric|texture|finish)/iu, /(?:material|fabric|texture|finish)\s+of\s+(?:the\s+)?(?:product|item)/iu, /(?:its?|it'?s)\s+(?:material|fabric|texture|finish)/iu],
    implicitMutations: [/(?:把|将)?(?:商品|产品|鞋子?|包包|服装|衣服|瓶子?|盒子?)(?:改成|换成|变成)(?:皮革|金属|木质|玻璃|塑料|丝绸|棉|羊毛)/iu, /(?:make|turn)\s+(?:the\s+)?(?:product|item|it)\s+(?:leather|metallic|wooden|glass|plastic|silk|cotton|wool)/iu],
    failClosedTerms: [/(?:材质|材料|质地|纹理)/iu, /\b(?:material|fabric|texture|finish)\b/iu],
    failClosedMutations: [/(?:改|换|变)(?:成|为)?\s*(?:皮革|金属|木质|玻璃|塑料|丝绸|棉|羊毛)/iu, /(?:make|turn|change|switch)(?:\s+it)?\s+(?:to|into)?\s*(?:leather|metallic|wooden|glass|plastic|silk|cotton|wool)/iu],
    message: '请求会改变商品材质、质地或表面纹理。',
  },
  {
    attribute: 'logo',
    terms: [/(?:商品|产品|包装|本体|品牌)(?:上|上的|的)?\s*(?:logo|徽标|标志|商标)/iu, /(?:logo|徽标|商标)/iu, /(?:product|item|package|brand)(?:'s)?\s+(?:logo|trademark|brand\s+mark)/iu, /(?:logo|trademark|brand\s+mark)\s+on\s+(?:the\s+)?(?:product|item|package)/iu, /\b(?:logo|trademark|brand\s+mark)\b/iu],
    message: '请求会改变、移除或新增商品/包装上的 Logo。',
  },
  {
    attribute: 'packaging_text',
    terms: [/(?:包装|盒身|瓶身|标签)(?:上|上的|的)?(?:包装)?(?:字|文字|文案|说明|字体|字样)/iu, /(?:packaging|package|box|bottle|label)(?:'s)?\s+(?:text|copy|wording|lettering|instructions?)/iu, /(?:text|copy|wording|lettering)\s+on\s+(?:the\s+)?(?:packaging|package|box|bottle|label)/iu, /(?:its?|it'?s)\s+(?:packaging|package|label)\s+(?:text|copy|wording)/iu],
    message: '请求会改变包装、标签或商品表面的原始文字。',
  },
  {
    attribute: 'certification_mark',
    terms: [/(?:认证|合格|许可|防伪)(?:标识|标志|图标|标签|印章)/iu, /(?:认证|资质)(?:信息|文字)/iu, /(?:certification|compliance|approval|authenticity)\s+(?:mark|seal|badge|label|logo|text)/iu],
    message: '请求会改变或移除认证、合规或防伪标识。',
  },
  {
    attribute: 'accessories',
    terms: [/(?:商品|产品|随附|原有|配套)(?:的)?(?:配件|附件|零件|赠品)/iu, /(?:product|item)(?:'s)?\s+(?:accessories|attachments|included\s+parts)/iu, /(?:included|original|bundled)\s+(?:accessories|attachments|parts)/iu, /(?:its?|it'?s)\s+(?:accessories|attachments|parts)/iu],
    failClosedTerms: [/(?:配件|附件|零件|赠品)/iu, /\b(?:accessories|attachments|included\s+parts)\b/iu],
    message: '请求会改变、增删或替换商品原有配件。',
  },
] as const

const immutableConstraints = Object.freeze([
  constraint('color', '保持商品本体颜色与配色完全不变。', 'Keep the product color and colorway exactly unchanged.'),
  constraint('structure', '保持商品结构、造型、轮廓、比例与尺寸完全不变。', 'Keep the product structure, shape, silhouette, proportions, and dimensions exactly unchanged.'),
  constraint('material', '保持商品材质、质地、纹理与表面处理完全不变。', 'Keep the product material, fabric, texture, and finish exactly unchanged.'),
  constraint('logo', '保留原始 Logo、商标及其位置、形状、颜色和比例，不得增删或重绘。', 'Preserve every original logo and trademark, including position, shape, color, and proportions; do not add, remove, or redraw them.'),
  constraint('packaging_text', '保留包装、标签和商品表面的全部原始文字，不得改写、增删或生成新文字。', 'Preserve all original packaging, label, and product text; do not rewrite, add, remove, or generate text.'),
  constraint('certification_mark', '保留全部认证、合规、防伪和许可标识，不得修改、遮挡、增删或伪造。', 'Preserve all certification, compliance, authenticity, and approval marks; do not alter, obscure, add, remove, or fabricate them.'),
  constraint('accessories', '保留商品原有配件、附件、零件及其数量和外观，不得增删或替换。', 'Preserve all original accessories, attachments, included parts, their count, and appearance; do not add, remove, or replace them.'),
])

const safeRules: ReadonlyArray<{ category: SafeImageModification; pattern: RegExp }> = [
  { category: 'background', pattern: /(?:背景|场景|环境|布景|backdrop|background|scene|setting)/iu },
  { category: 'lighting', pattern: /(?:光影|光线|灯光|照明|曝光|阴影|高光|色温|lighting|light|illumination|exposure|shadow|highlight|color\s+temperature)/iu },
  { category: 'composition', pattern: /(?:构图|画面布局|取景|裁切|视角|景别|留白|composition|layout|framing|crop|camera\s+angle|negative\s+space)/iu },
]

export function validateProtectedProductIntent(request: string): ProtectedProductIntentValidation {
  const normalized = request.normalize('NFKC').trim()
  const clauses = splitClauses(normalized)
  const findings: ProtectedProductFinding[] = []
  const safeModifications: SafeImageModificationMatch[] = []

  for (const clause of clauses) {
    for (const safeRule of safeRules) {
      const evidence = matchText(clause, safeRule.pattern)
      if (evidence && !safeModifications.some(match => match.category === safeRule.category)) {
        safeModifications.push(Object.freeze({ category: safeRule.category, evidence }))
      }
    }
    for (const rule of protectedRules) {
      const evidence = protectedEvidence(clause, rule)
      if (!evidence || isPreservationIntent(clause, evidence)) continue
      findings.push(Object.freeze({
        code: `PROTECTED_PRODUCT_${rule.attribute.toUpperCase()}_MUTATION` as ProtectedProductFinding['code'],
        severity: 'error',
        attribute: rule.attribute,
        evidence,
        message: rule.message,
        remediation: '仅调整背景、光影或构图，并明确保持商品本体及受保护元素不变。',
      }))
    }
  }

  const uniqueFindings = findings.filter((finding, index) => findings.findIndex(candidate => candidate.attribute === finding.attribute && candidate.evidence === finding.evidence) === index)
  const promptConstraints = Object.freeze({
    zh: immutableConstraints.map(item => item.instructionZh).join('\n'),
    en: immutableConstraints.map(item => item.instructionEn).join('\n'),
  })
  return Object.freeze({
    allowed: uniqueFindings.length === 0,
    findings: Object.freeze(uniqueFindings),
    immutableConstraints,
    safeModifications: Object.freeze(safeModifications),
    promptConstraints,
  })
}

function protectedEvidence(clause: string, rule: ProtectedRule): string | undefined {
  const implicit = rule.implicitMutations?.map(pattern => matchText(clause, pattern)).find(Boolean)
  if (implicit) return implicit
  const term = rule.terms.map(pattern => matchText(clause, pattern)).find(Boolean)
  if (term && (mutationAction.test(clause) || affirmativeDoubleNegation.test(clause))) return term
  if (explicitSafeTarget.test(clause)) return undefined
  const failClosedMutation = rule.failClosedMutations?.map(pattern => matchText(clause, pattern)).find(Boolean)
  if (failClosedMutation) return failClosedMutation
  const failClosedTerm = rule.failClosedTerms?.map(pattern => matchText(clause, pattern)).find(Boolean)
  return failClosedTerm && mutationAction.test(clause) ? failClosedTerm : undefined
}

function isPreservationIntent(clause: string, evidence: string): boolean {
  if (affirmativeDoubleNegation.test(clause)) return false
  const evidenceIndex = clause.toLocaleLowerCase().indexOf(evidence.toLocaleLowerCase())
  return preservationPatterns.some(pattern => {
    const match = pattern.exec(clause)
    if (!match) return false
    const start = match.index
    const end = start + match[0].length
    return evidenceIndex < 0 || (evidenceIndex >= start - 12 && evidenceIndex <= end + 12)
  })
}

function splitClauses(value: string): string[] {
  if (!value) return []
  return value.split(/(?:[。；;，,.!?！？\n]+|\b(?:but|however)\b|(?:但是|但|不过|然而))/iu).map(clause => clause.trim()).filter(Boolean)
}

function matchText(value: string, pattern: RegExp): string | undefined {
  pattern.lastIndex = 0
  return pattern.exec(value)?.[0]
}

function constraint(attribute: ProtectedProductAttribute, instructionZh: string, instructionEn: string): ImmutableProductConstraint {
  return Object.freeze({ attribute, instructionZh, instructionEn })
}
