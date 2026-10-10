import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourcePath = 'apps/plugin/skills/amazon-product-photography/SKILL.md'
const sourceLicensePath = 'apps/plugin/skills/amazon-product-photography/LICENSE'
const mirrorPath = '.codex-marketplace/plugins/merchant-marketing/skills/amazon-product-photography/SKILL.md'
const mirrorLicensePath = '.codex-marketplace/plugins/merchant-marketing/skills/amazon-product-photography/LICENSE'
const read = path => readFileSync(resolve(root, path), 'utf8')

test('Amazon product photography planner is mirrored, packaged, attributed, and text-only', () => {
  const source = read(sourcePath)
  const marketplace = read(mirrorPath)
  const license = read(sourceLicensePath)
  const marketplaceLicense = read(mirrorLicensePath)
  const pluginManifest = JSON.parse(read('apps/plugin/.codex-plugin/plugin.json'))
  const marketplaceManifest = JSON.parse(read('.codex-marketplace/plugins/merchant-marketing/.codex-plugin/plugin.json'))
  const mirrors = read('scripts/plugin-skill-mirrors.ts')
  const packager = read('apps/plugin/scripts/package-local-plugin.mjs')
  const provenance = read('docs/skill-source-provenance.md')
  const merchantEntry = read('apps/plugin/skills/merchant-marketing/SKILL.md')
  const merchantMirror = read('.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/SKILL.md')

  assert.equal(marketplace, source)
  assert.equal(marketplaceLicense, license)
  assert.equal(pluginManifest.skills, './skills/')
  assert.equal(marketplaceManifest.skills, './skills/')
  assert.ok(mirrors.includes(`['${sourcePath}', '${mirrorPath}']`))
  assert.ok(mirrors.includes(`['${sourceLicensePath}', '${mirrorLicensePath}']`))
  assert.ok(packager.includes(`'skills/amazon-product-photography/SKILL.md'`))
  assert.ok(packager.includes(`'skills/amazon-product-photography/LICENSE'`))
  assert.ok(provenance.includes('nexscope-ai/Amazon-Skills'))
  assert.ok(provenance.includes('0f3b13fa0e5ed0a9f3d600dc18518bc76ddd813b'))

  assert.equal(merchantMirror, merchantEntry)
  assert.match(merchantEntry, /amazon-product-photography/u)
  assert.match(merchantEntry, /身份.*工作区.*核验/u)
  assert.match(merchantEntry, /主图组策划/u)
  assert.match(merchantEntry, /拍摄 brief/u)
  assert.match(merchantEntry, /验收清单/u)
  assert.match(merchantEntry, /图片生成、编辑或上传.*Merchant MCP/u)
  assert.match(merchantEntry, /商品视频增强技能路由/u)
  assert.match(merchantEntry, /视频脚本或分镜.*Merchant Marketing MCP/u)
  assert.match(merchantEntry, /multimodal\.video\.request/u)
  assert.match(merchantEntry, /模型中转、费用及审计门禁/u)

  assert.ok(source.includes('name: amazon-product-photography'))
  assert.ok(source.includes('Merchant MCP'))
  assert.ok(source.includes('商家明确确认'))
  assert.ok(source.includes('待核对'))
  assert.ok(source.includes('只处理规划和验收文本'))
  assert.ok(source.includes('不得网页搜索'))
  assert.ok(source.includes('不得直接调用任何媒体工具'))
  assert.doesNotMatch(source, /nexscope\.ai|tryallapi|run_plan\.py|npx skills add|https?:\/\//iu)
  assert.ok(license.includes('MIT License'))
  assert.ok(license.includes('Copyright (c) 2026 Nexscope AI'))
})
