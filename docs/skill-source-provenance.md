# 电商图片与视频技能来源记录

核验日期：2026-10-10（Asia/Shanghai）

本表记录本地商家工作流文档中引用的公开资料快照。上游 SHA 是核验时各仓库 `main` 的 commit；它们会变化，链接固定到该 commit。许可证核对对象为对应 commit 根目录的 `LICENSE` 文件，五个仓库均声明 MIT。此记录不构成法律意见或对上游质量、平台规则准确性的背书。

| 上游仓库 / commit | 许可证核验 | 对应本地文件 | 采用范围 |
| --- | --- | --- | --- |
| [xianyu110/ecommerce-image-skills](https://github.com/xianyu110/ecommerce-image-skills/tree/f4566fdc812584425728862ad8e08c90883d81ee) · `f4566fdc812584425728862ad8e08c90883d81ee` | 根目录 [`LICENSE`](https://github.com/xianyu110/ecommerce-image-skills/blob/f4566fdc812584425728862ad8e08c90883d81ee/LICENSE) 声明 MIT，版权声明为 xianyu110 | `apps/plugin/skills/merchant-marketing/references/product-image-workflow.md`；`apps/plugin/skills/ecommerce-image-workflow/SKILL.md` | 仅参考商品身份锁定和套图策划概念，并按 Store Nova 的 MCP、relay、权限、成本与证据门禁重新编写。 |
| [oldred-byte/ec-visual-skill](https://github.com/oldred-byte/ec-visual-skill/tree/fead6fa34679a920ed67c7119e2df526ed2d139c) · `fead6fa34679a920ed67c7119e2df526ed2d139c` | 根目录 [`LICENSE`](https://github.com/oldred-byte/ec-visual-skill/blob/fead6fa34679a920ed67c7119e2df526ed2d139c/LICENSE) 声明 MIT，版权声明为 hobby | `apps/plugin/skills/merchant-marketing/references/product-image-workflow.md`；`apps/plugin/skills/ecommerce-image-workflow/SKILL.md` | 仅参考按买家决策规划画面的思路；未采用固定张数、外部生成方式或平台规格作为 Store Nova 承诺。 |
| [xianyu110/ecommerce-video-skills](https://github.com/xianyu110/ecommerce-video-skills/tree/96c49b349b7d975bda8f05ce6669c1d33500c269) · `96c49b349b7d975bda8f05ce6669c1d33500c269` | 根目录 [`LICENSE`](https://github.com/xianyu110/ecommerce-video-skills/blob/96c49b349b7d975bda8f05ce6669c1d33500c269/LICENSE) 声明 MIT，版权声明为 xianyu110 | `apps/plugin/skills/merchant-marketing/SKILL.md`；`apps/plugin/skills/ecommerce-video-marketing/SKILL.md` 及其 `references/` | 仅参考视频脚本、分镜、声音和镜头连续性工作流；未复制其脚本、渲染器、平台规则或依赖。 |
| [ymh3753201/ai-commerce-video](https://github.com/ymh3753201/ai-commerce-video/tree/8c8c8a14ce8250235d2edf89459d5e61748302ba) · `8c8c8a14ce8250235d2edf89459d5e61748302ba` | 根目录 [`LICENSE`](https://github.com/ymh3753201/ai-commerce-video/blob/8c8c8a14ce8250235d2edf89459d5e61748302ba/LICENSE) 声明 MIT，版权声明为 yemeihua | `apps/plugin/skills/merchant-marketing/SKILL.md`；`apps/plugin/skills/ecommerce-video-marketing/SKILL.md`；`apps/plugin/skills/storyboard-prompt-assistant/SKILL.md` | 仅参考商品证据约束、镜头连续性和声音方案的策划思路；未复制 provider 适配器、模型配置、生成脚本或本地渲染器。 |
| [nexscope-ai/Amazon-Skills](https://github.com/nexscope-ai/Amazon-Skills/tree/0f3b13fa0e5ed0a9f3d600dc18518bc76ddd813b) · `0f3b13fa0e5ed0a9f3d600dc18518bc76ddd813b` | 根目录 [`LICENSE`](https://github.com/nexscope-ai/Amazon-Skills/blob/0f3b13fa0e5ed0a9f3d600dc18518bc76ddd813b/LICENSE) 声明 MIT，版权声明为 Nexscope AI；本地保留完整 MIT 文本 | `apps/plugin/skills/amazon-product-photography/SKILL.md` | 只采用图片组策划、摄影 brief 和人工验收的规划思路；本地文本按 Store Nova 的 MCP/事实/权限/费用/人工审核门禁重写，不含 Nexscope 推广入口、脚本、provider 或外部执行路径。 |

## Vendoring 与分发说明

- 本项目没有 vendoring、安装或执行上述仓库的 Skill 文件、源代码、生成脚本、CLI、provider 或 renderer；本地文件是为 Store Nova 工作流撰写的适配内容。Amazon Product Photography 规划技能随插件保留上游 MIT LICENSE 以供分发归属核验，但其操作文本是 Store Nova 专用重写，不复制上游促销、生成路由或外部执行内容。
- 上游代码、模板、平台规则、依赖和生成效果均未在本项目验证。上述 SHA 只标识核验时的来源快照，不表示上游当前状态或本地插件的构建 commit。
- 图片规划技能分发时连同其上游 MIT LICENSE 和本来源表一起保留。其他仅记录概念性参考的文件不分发上游许可证文本。如果未来复制或分发其它上游文件、实质性文本或派生脚本，必须重新进行许可审查，并按适用要求保留版权和许可证声明。
- 视频仓库中提及的 `edge-tts` / LGPL-3.0 依赖未被本项目引入或执行。
