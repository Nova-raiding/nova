# Store Nova 验收状态

当前安装版本：`0.1.4+codex.20261017155812`。候选 API/worker 尚未部署。

共 135 个工具；29 个有历史 stdio 检查记录。当前安装版通过 135 项工具面与源码逐项一致性校验，并在 3 个独立生产 bridge 进程中成功调用 `onboarding.status`；凭据来源为 Keychain，未要求重新授权。ChatGPT App 截图只作为部分只读响应证据，没有逐工具调用轨迹；App UI 逐工具通过数为 0。

| 工具组 | 工具数 | 历史 stdio 已检查 | 当前安装版单独验证 |
|---|---:|---:|---:|
| asset | 9 | 1 | 0 |
| billing | 6 | 2 | 0 |
| brand | 3 | 1 | 0 |
| brand-unit | 7 | 2 | 0 |
| campaign | 5 | 1 | 0 |
| canonical | 1 | 0 | 0 |
| catalog | 15 | 2 | 0 |
| commercial | 15 | 4 | 0 |
| content | 12 | 0 | 0 |
| creative | 3 | 0 | 0 |
| creative-points | 2 | 2 | 0 |
| deliverable | 1 | 1 | 0 |
| feedback | 2 | 0 | 0 |
| generation | 1 | 0 | 0 |
| knowledge | 16 | 5 | 0 |
| merchant | 2 | 0 | 0 |
| multimodal | 3 | 0 | 0 |
| onboarding | 1 | 1 | 1 |
| ops | 1 | 0 | 0 |
| platform | 2 | 0 | 0 |
| rule | 3 | 2 | 0 |
| subscription | 2 | 2 | 0 |
| support | 1 | 0 | 0 |
| task | 12 | 1 | 0 |
| workspace | 10 | 2 | 0 |

## 后续 App 验收顺序

1. 新会话检查授权与工作区；退出并重新打开 App 后复测，再升级插件后复测持久化。
2. 商品、品牌、素材、任务、交付和余额查询；对照详情、概览与分页，验证显式工作区范围。
3. 使用明确 QA 数据完成导入、事实确认、内容候选、审核、导出；核验真实持久化结果与文件字节。
4. 分别验证文本、图片生成、图片编辑、OCR、视频的真实中转回执、用量、成本、预留与结算；配置缺失时记录具体阻断。
5. 复测权限拒绝、跨工作区访问、重复提交、超时恢复、刷新后状态和新会话追踪。涉及确认的生成与扣费按真实工作流门禁执行。

每个工具逐项状态见 `plugin-acceptance-ledger.json`。工具声明、单元测试、stdio 调用和桌面浏览器测试均不替代 App UI 验收。

## 当前阻断

- App 自动操作被工具安全机制拒绝；没有尝试旁路操作。逐工具 App UI 验收尚未完成。
- 新版 bridge 的独立只读请求已成功，且 Keychain 授权保持可用；安装回执要求重启 ChatGPT。当前 App 未运行，尚无新版本 host reload 或新对话的 App UI 证据，不需要重新做商家授权。
- demo 扫描病毒库超过现有 24 小时门槛，候选配置准备因健康检查失败而停止。
- 写入、生成、扣费、导出、权限拒绝和异常恢复尚无完整 App 验收证据。

最新修复：安装器现在将旧插件缓存及回退备份放到 Codex 不会驱逐的目录，并在安装或注册回滚后恢复。安装器、升级器、安装冒烟和发布元数据共 75 项通过，类型检查通过；真实升级期间旧 bridge 持续运行，并且旧版新进程、新版新进程均无需重新授权。详见 `auth-install-continuity.json`。这些 stdio 结果不替代 App UI 验收。


## 0.1.4 本地安装复验

安装版本：`0.1.4+codex.20261017155812`，本地 `merchant-local` 已启用。完整 bridge 文件清单 73/73 与源码一致，135 个工具的发现快照一致。3 个全新生产 bridge 进程均从 Keychain 读取既有授权，`onboarding.status` 每次都返回成功；另以无效凭据模拟验证了“先重启 ChatGPT，仍失败再本地登录”的恢复顺序，并确认 fail-closed。证据见 `installed-read-0.1.4.json`。ChatGPT App 当前未运行，App UI 单工具通过数仍为 0。
