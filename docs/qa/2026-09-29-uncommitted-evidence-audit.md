# 2026-09-29 未提交 QA 证据只读审计

范围：审计时 `main` 工作树中 7 份未提交 QA 报告、43 张新增或修改 PNG、Windows 证据目录中的文本、JSON、SQL 和日志。不审计未提交代码。本报告只记录证据可证明的范围，不将历史候选、等待态、错误态或模型答复转为当前生产及 ChatGPT App 正向验收。截图逐项对照文件名、引用处及关键画面；未对全部终端长图逐字复核。43 张 PNG 的 SHA256 均不同，不能据此排除画面近似或阶段重复。

## 最小处理清单

1. 只将 `generation-server-ledger.txt`、`generation-points-ledger.txt` 与查询 SQL 作为**旧线上单次文本调用**的独立服务端证据。它们显示同一 reservation/provider request、用量、成本、预留与结算，查询在 `BEGIN` / `ROLLBACK` 中；不能证明新免费门槛已部署、旧扣点已补偿、全部前置门禁或其他模态已通过。
2. `free-threshold/candidate-plan.json` 明写 `prepared_not_deployed`、release gates 尚在运行，属于当时时点计划；`compensation-draft.json` 的 `expected_revision=null` 且 `not_submitted`。两者应保留为草案并在最终候选记录中明确更新状态，不作为部署或返还证据。
3. 旧失败截图和失败日志只放在故障历史。特别是 `27-callback-failure-pending.png` 与 `27-callback-success-pending.png` 都只显示“正在完成绑定”；`130900-windows-minimal-patch-syntax-failure.png` 明示 `Bridge syntax failed`；`storenova-four-result.png` 明示 `MCP_CONFIGURATION_REQUIRED`；`storenova-check-popup.png` 的请求明确要求不调用工具。这些均不能列入正向 App/MCP 验收。
4. 五张图在本轮 QA 文档中未找到引用：`27-callback-failure-pending.png`、`1618-merchant-finance-quota.png`、`130900-windows-minimal-patch-syntax-failure.png`、`storenova-deepseek-windows-cli.png`、`storenova-relay-configured.png`。若归档，分别标为等待态、商家财务未读取态、bridge 语法失败、无工具调用的中转 CLI 文本探测、配置/连接诊断。后两张不证明插件业务成功。确认其他引用后再精简，避免误删故障轨迹。
5. 现有文本没有查见明文 token、Cookie、密码或 API key；抽看的 Windows 截图暴露本机用户路径、工作区/店铺业务标识和远控面板中的 `credential.json` **文件名**，未见文件内容。内部 QA 可保留，外发前应按接收范围遮挡这些标识并复核原图。

## 截图逐项证据等级

以下 `W/` 指 `evidence/2026-09-29-windows-remote/`，`C/` 指 `evidence/2026-09-29-chatgpt-app/`。`保留` 表示其历史观察有价值，不表示提交或发布已获批准。

| 截图 | 实际能证明的范围与处理 |
| --- | --- |
| C/`27-callback-failure-pending.png` | 授权回调等待页；与成功路径的 pending 图画面近似。未被本轮文档引用，候选精简；不能证明失败结果。 |
| C/`27-callback-success-pending.png` | 同一等待页；保留为回调 UI 时序。不能证明凭据保存。 |
| C/`27-callback-success-result.png` | 页面显示“绑定已完成”。对应浏览器 E2E 使用进程内 fixture；不能证明生产 Keychain 或 ChatGPT 工具可用。 |
| C/`1618-merchant-finance-quota.png` | 商家财务 UI 显示创意点“未读取”、存储 50 GB；未被本轮文档引用，候选归档。不能当作余额已读取或权益已确认。 |
| W/`124900-windows-config-process-diagnosis.png` | 宿主对配置/进程的诊断答复；保留为排障线索，非进程检查或工具回执。 |
| W/`130900-windows-minimal-patch-syntax-failure.png` | `bridge.mjs` shebang 位置错误和语法失败；未被引用，建议补历史链接或归档。绝不能放入修复通过证据。 |
| W/`sn-after-focus.png` | 远端 JSON 文件信息存在性；保留，不能证明文件内容源自原始工具事件。 |
| W/`sn-alttab.png` | Windows 宿主界面恢复；保留，不证明 MCP 调用。 |
| W/`sn-call-expanded4.png` | 宿主执行摘要/集成使用标记；保留为宿主层观察，非单项原始工具回执。 |
| W/`sn-calls-output.png` | 读取宿主写出 JSON 的四项 `raw_response_text`；保留，受遮挡且来源仍是宿主写文件。 |
| W/`sn-copy-evidence-correct.png` | 命令已粘贴；保留为过程记录，不能证明命令运行或文件取回。 |
| W/`sn-followup-result2.png` | 宿主声称两项只读调用成功并保存文件；保留为答复，不是原始事件。 |
| W/`sn-four-results.png`、`sn-host-result1.png` | 宿主对四项结果及余额的总结；保留为二级证据，不代替展开的工具回执。 |
| W/`sn-generation-pasted.png`、`sn-generation-sent.png` | 生成提示已粘贴、随后已发送；保留为时序，不能证明生成发生。 |
| W/`sn-generation-progress.png` | 宿主对生成、扣点及成本的总结；保留，独立证明见服务端账本，截图本身不能证明模型/用量/结算。 |
| W/`sn-host-running.png` | 四项只读请求提交后处于 Thinking；保留，不证明返回。 |
| W/`sn-json-keys-result.png` | 远端 JSON 可解析并有文件哈希；保留，不证明六项完整原始回执。 |
| W/`sn-json-notes.png` | 文件内自述 `isError` 为推断、无 requestId、目录项截断；保留为证据限制，不将自述升级为独立校验。 |
| W/`sn-opened-real.png` | 直接 EXE 启动失败；保留为失败过程。图中重启标记不等于启动成功。 |
| W/`sn-package-result3.png` | 通过系统入口启动的命令过程；保留，后续宿主界面另见 `sn-alttab.png`。 |
| W/`sn-remote-build-output.png` | 首次补丁语法失败及后续构建输出；保留为过程，不能由构建成功推出宿主重新加载。 |
| W/`storenova-authenticated-onboarding.png` | Windows 独立 stdio 经凭据调用的结果；保留，不等于 ChatGPT 宿主调用。 |
| W/`storenova-build-latest.png` | Windows helper 构建成功但未签名、非 production ready；保留为构建证据。 |
| W/`storenova-check-popup.png` | 宿主按“不调用工具”要求给出文本答复；保留为模型中转文本探测，不能当作 Store Nova MCP 成功。 |
| W/`storenova-config-short.png`、`storenova-paths-filtered.png` | 旧版缓存/入口配置；保留为版本诊断，不代表新版运行。 |
| W/`storenova-connection-gate.png` | 连接帮助弹窗显示门禁；保留为阻断证据。 |
| W/`storenova-deepseek-windows-cli.png` | CLI 文本探测先有模型列表错误，后有无工具调用的答复；未被引用，可归档。非插件业务证据。 |
| W/`storenova-explicit-env.png` | 本地开发 MCP 显式非秘密环境配置修复过程，画面亦有一次 PowerShell 错误；保留为诊断，不单独证明 App 已接收配置。 |
| W/`storenova-final-check.png`、`storenova-gate-see.png` | 健康端点或正式包签名门禁检查，其中正式打包失败；保留为各自范围的证据，不可称正式包就绪。 |
| W/`storenova-four-result.png`、`storenova-retry-result.png` | 早期宿主四项配置缺失/调用失败；保留为失败记录，不能与后续答复混作成功。 |
| W/`storenova-import-result.png` | Bundle 接收、哈希及 `git bundle verify`；保留，只证明源传输。 |
| W/`storenova-install-executed.png` | `plugin add` 命令退出 0 但仍指向旧版；保留，不证明新版安装。 |
| W/`storenova-local-auth-success.png`、`storenova-local-auth-terminal.png` | Windows 本地授权页及 CLI 报告凭据保存成功；保留，CLI 自述 `host_verified:false`。 |
| W/`storenova-probe-result2.png` | 旧 bridge 可初始化但缺配置，业务调用阻断；保留为基线。 |
| W/`storenova-relay-configured.png` | 中转配置/无密钥 401 的终端信息；未被引用，可归档。不能证明模型用量或插件工具。 |
| W/`storenova-verify-restart.png` | 新缓存安装/bridge 校验及重启命令，画面还保留早一次安装失败；保留为安装层证据，非宿主业务结果。 |
| W/`storenova-windows-contract.png` | 源码目录自比对的 Windows 工具契约检查；保留，不证明正式安装包一致或 116 项调用通过。 |

## 文本与日志的归属

| 文件 | 证据范围 |
| --- | --- |
| `2026-09-29-chatgpt-plugin-{174000,182200,183300,183900}-owner-audit.md` | 四个不同安装时点的阻断/版本记录。不能汇总为同一版本的 App 功能通过；183900 当前记录仍为工具 0 项。 |
| `2026-09-29-ui-screenshot-fidelity-audit.md`、`2026-09-29-merchant-brand-page-geometry-audit.md` | 桌面 UI 候选与隔离环境截图对照；依赖各自 artifacts，不能直接证明生产租户数据或 ChatGPT 插件。前者明确四张 Ops 参考图是会话失效画面，不应作为目标页。 |
| `2026-09-29-model-free-threshold-fix.md` | 源码规则/测试及部署待办；末段承认最终舍入变化后旧 129 项测试和类型检查不能覆盖最终候选，且尚未部署。 |
| `160709-31-readonly-stdio-keychain-block.md`、`keychain-upgrade-readonly-audit.md` | 本地独立 stdio 与 Keychain 阻断，非 App 业务成功；未打印令牌。 |
| `qa-upload-gate-and-password-recovery-audit.md` | QA 工作区单次素材上传返回 503，改密仅审计路径而未执行；不能列为上传或改密成功。 |
| `W/status.md`、`W/signing-preparation.md` | Windows 时序/签名准备；历史失败与后续恢复分阶段解释，准备不等于远端安装或正式签名包。 |
| `W/generation-server-ledger.sql`、`W/generation-server-ledger.txt`、`W/generation-points-ledger.txt` | 同一次旧线上生成的独立数据库查询与只读事务输出；保留并限制结论到该 action。 |
| `W/free-threshold/sn-free-delivery-pg-check.sql`、`.log` | 临时表与回滚范围内的 PG 阈值验证，`PASS` 指 SQL 断言满足，不是生产迁移或 Windows 验收。 |
| `W/free-threshold/sn-free-threshold-owner-tests.log`、`storenova-model-reconciliation-threshold.log` | 分别显示 129 项、22 项源码测试通过；对应执行时源码，不自动覆盖之后变更。 |
| `W/free-threshold/sn-free-threshold-typecheck.log`、`sn-free-threshold-typecheck-final.log` | 两份含 TS 错误的历史失败日志；不可当作最终通过。 |
| `W/free-threshold/sn-free-threshold-typecheck-complete.log` | 输出末尾到 worker `tsc`，日志本身不含退出码；owner 报告退出 0，但该文件单独无法证明退出状态，且不覆盖其后舍入变化。 |
| `W/free-threshold/live-migrations-254.txt`、`candidate-plan.json`、`compensation-draft.json` | 前者是迁移名称/哈希快照，后二者是部署和补偿准备；不代表迁移 255 已执行、兼容模式上线或补偿已提交。 |

未发现可把上述材料合并解释为当前版本全工具、图片/视频、五模态或生产发布门禁通过的证据。
