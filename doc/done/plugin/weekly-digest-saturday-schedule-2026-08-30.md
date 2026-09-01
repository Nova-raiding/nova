# 每周平台经营简报周六调度修正（2026-08-30）

## 完成范围

- 修正插件原生 Automation 模板 `weekly-six-platform-digest.json` 的星期配置：由周一 `MO` 改为周六 `SA`。
- 同步源码插件、Marketplace 镜像、Skill 建议时间和插件清单测试，避免模板名称、说明和机器配置不一致。

## 代码证据

- `apps/plugin/scheduled/weekly-six-platform-digest.json`
- `.codex-marketplace/plugins/merchant-marketing/scheduled/weekly-six-platform-digest.json`
- `apps/plugin/skills/merchant-marketing/references/automations.md`
- `.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/references/automations.md`
- `tests/plugin-manifest.test.ts`

## 验证证据

- `tests/plugin-manifest.test.ts`：7 项通过。

## 未宣称事项

该修正只证明仓库模板的星期配置一致，不代表真实 Codex App Automation 创建、Run now、历史、通知或宿主 schema 已完成验收；真实宿主证据仍是 release todo 门禁。
