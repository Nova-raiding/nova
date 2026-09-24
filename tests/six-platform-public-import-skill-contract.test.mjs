import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../apps/plugin/skills/six-platform-public-import/SKILL.md', import.meta.url), 'utf8')
const mirror = readFileSync(new URL('../.codex-marketplace/plugins/merchant-marketing/skills/six-platform-public-import/SKILL.md', import.meta.url), 'utf8')

assert.equal(mirror, source, 'marketplace Skill must match the source Skill')
assert.match(source, /检查当前 ChatGPT 宿主.*实际暴露的工具/)
assert.match(source, /`catalog\.import` 只导入调用方提供的字段，不会自行抓取 URL/)
assert.match(source, /宿主没有网页读取工具、读取失败.*请其补充商品标题、价格、规格、卖点等手工资料/)
assert.match(source, /不得仅凭 URL 调用 `catalog\.import`/)
assert.match(source, /显式设置 `draft_only=true`/)
assert.match(source, /不得导入浏览器 Cookie、复用持久化登录态、要求用户粘贴 token/)
assert.match(source, /不得.*验证码\/反爬挑战/)

for (const platform of ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin']) {
  assert.ok(source.includes(`（${platform}）`), `supported platform ${platform} must remain documented`)
}

console.log('six-platform public import Skill contract: ok')
