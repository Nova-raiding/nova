# 上传商品图片生成链路实测（2026-09-07）

本次本地验收使用实际安装的 Merchant Marketing stdio bridge、API/MCP、PostgreSQL、worker 和已配置模型中转；没有使用宿主图片生成工具。

## 已验证

- 上传图生成未绑定候选时，不重复要求商用权/AI 修改许可确认；可信扫描、工作区隔离和明确限制仍会校验，未写入权益批准。
- 参考图编辑通过 `/images/edits` multipart 传递真实文件字节；原 JSON generations 路径的深蓝色、额外胸袋等不合格结果保留为失败证据，没有放入交付包。
- 图片模型为 `qwen-image-2.0`。已目视检查 1 张主图、5 张 Banner、2 张详情图；交付包保留原始 MCP 图片字节。
- 初测视频使用 `happyhorse-1.1-i2v`；明确 1080P，分辨率价格优先于旧固定覆盖价。缺少分辨率时，中转站异常 fallback_price=90000000 导致计费溢出。
- 已记录真实视频提交、上游失败及报价证据；任务 accepted/queued 不代表成片成功。失败任务的报价记录不能当作最终供应商扣费。
- 默认商业工具清单不变。本机显式 `MERCHANT_ENABLE_LOCAL_VIDEO_CANDIDATES=true` 且连接 loopback、非 production/staging/preview 时显示视频候选入口；实际生成仍经过服务端授权和成本门禁。macOS launcher 从 launchctl 读取该开关。

## 运行方式

重建/恢复本地 API 必须使用项目配置：

```sh
docker compose --env-file .env -f infra/local/docker-compose.yml up -d --no-deps api api-replica
```

不要漏掉 `--env-file .env`，否则中转密钥与图生视频模型配置不会进入容器。密钥未写入本报告。

## 验收边界

本地套餐/创意点为获授权的测试权益；平台账号、支付与正式发布不属于本次真实上线验收。桌面图片任务使用真实 API 返回值验证；演示 Nginx 固定 ws_demo，浏览器验收显式转发到实际工作区 API，没有伪造响应。

证据与文件：`artifacts/jd-jacket-20260907/`。最终成片结果见下文。

## 视频渠道调查进展

HappyHorse 渠道 27 的三个已受理任务均以 `InvalidParameter: input.media.0.url / first_frame` 结束；读取渠道配置返回 403，未修改中转站管理员配置。已有通用中转凭据另有 `wan3.0-video`/`wan3.0-video-prime`，供应商模型说明支持参考图，接口声明为 `openai-video`。曾通过 `/videos` 的 multipart `input_reference` 文件协议复测但商品保真失败；原 HappyHorse 凭据保留在本地配置中，未输出密钥。


## 万相首轮成片验收

`task_Ohjho0Xb7T6v7x98WlMX76wI9DOjR9aq` 已生成并完成可信扫描，但人工抽帧验收失败：原浅蓝简洁款被替换为带黑色拉链、肩部蓝条和衣架的另一款冲锋衣。中转任务的实际 action=`textGenerate`，证明仅 HTTP 成功和文件归档不能作为参考图生效证据。该文件保存为 `rejected-wan3-text-only.mp4`，不放入交付包。现改为 JSON 原生 `metadata.input.media[{type:first_frame,url:原图dataURL}]`，附加统一 image 引用，进行下一次真实验证。


## 最终成片与验收结果

- 实际成功模型：已配置中转站的 `wan3.0-video`，JSON `/video/generations`，统一 image 加原生 `metadata.input.media` 首帧引用。原图未通过宿主生图工具重绘。
- 成功任务：`task_Ag4nS6Z3YCpS1llh3ALH7i8aOVBP79Yu`；素材：`asset_761eeb71-d2a2-4353-a845-aa02e5f000b8`，可信扫描完成，`archive_state=archived`。
- 实际 MP4：1440×1440、30fps、5.038 秒。Chrome 桌面原生播放器实际播放通过（readyState=4、无媒体错误、播放时间持续推进）。完整解码无错误，10 帧人工检查通过：原商品浅蓝色、帽型、拉链和口袋保持一致，没有换款、新增标识或明显变形。
- 中转最终任务 SUCCESS，报告 quota=373999，按中转公开换算口径对应约 5.10882634 元；完整请求编号与任务状态见 `video-final-supplier-evidence.json`。这是中转任务记录，未将此前失败任务报价当作最终扣费。
- 最新类型检查通过；视频适配、价格、API 成本门禁、MCP 与插件契约 5 文件共 55 项通过；技能镜像更新后 8 项通过；13 个容器健康。之前图片适配与 API 授权测试结果保留在本轮历史证据中。
- 交付包 `京东冲锋衣-图片视频完整包.zip`：1 主图、5 Banner、2 详情图、1 视频。全部保留模型原始字节，ZIP CRC 与 SHA256 校验通过。不包含被拒绝的早期图片和视频。

本次证明本机安装 bridge → API/MCP → 中转 → 真实文件归档与下载已跑通；不等于证明所有 ChatGPT 宿主会话、正式商家支付、发布和生产门禁均已通过。原 HappyHorse 渠道首帧映射问题保留为未修复的上游问题，实际交付使用已验证的万相路径。


## 19:27 插件连接回归

- 本会话预加载的宿主 MCP 调用仍返回缺失 MERCHANT_MCP_BASE_URL；不能将新子进程成功等同于旧宿主会话已恢复。
- 安装清单补齐 DEPLOY_ENV 和 MERCHANT_ENABLE_LOCAL_VIDEO_CANDIDATES 环境变量传递，源码、市场镜像和本机安装缓存同步。
- 新版 bridge 对缺失连接配置返回 MCP_CONFIGURATION_REQUIRED、operation_status=blocked、retryable=false，明确本次未向后端发请求，并说明配置更新后重新加载连接。配置错误不再提示未知操作状态或不断重试。
- 以去除全部 MERCHANT_* 变量的干净子进程启动已安装 bridge，真实 merchant.start、workspace.health 均通过，144 个本地工具且视频候选可用。读取已有图片得到真实图片附件；已有视频返回 completed/archived，没有重新生成媒体。
- 安装、bridge、镜像契约 3 文件 150 项测试通过，相关 diff 检查通过。证据：connection-fresh-launch-regression.json、existing-delivery-recovery-regression.json。
- 未终止其他会话进程。宿主应用自动操作受安全限制，无法替用户刷新当前旧连接；当前旧会话仍需重新加载插件连接后才可宣称宿主入口恢复。


## 20:35 本轮质量修正和 Excel 商品导入

- 运营新增 Excel / CSV 商品与 SKU 导入：真实模板、扫描解析、SKU 预览、确认导入、同工作区插件查询。完整验收见 product-sku-excel-import-20260907.md。
- 长图尺寸下发原来使用 /images/edits multipart；中转 Ali edit converter 丢弃 size。原生 /images/generations 的 input.messages（真实图片像素）与 parameters.size=1024*4096 同时保留引用和尺寸。适配已增加单元测试。
- qwen-image-2.0 长图虽达到 1024x4096，但虚构帽绳，v3/v4 拒绝作为合格交付。改用已配置中转的 qwen-image-3.0，v5 得到完整五区长图，移除黑色帽绳。候选细节仍需要商家对照实物审核，未发布。
- v5 job imggen_b91462d6-9d36-4dc5-b354-de184589e7cf，asset_5e668ca0-6558-410f-9206-e336c0b063ee；直接下载 MCP 原始 PNG，1024x4096。
- 新视频 wan3.0-video-prime，10.030998 秒、1440x1440、30fps。四段镜头，完整 ffmpeg 解码通过；逐秒抽帧对照了原图帽型、拉链和侧袋，无黑色帽绳。真实 model_usage_ledger 记录成本 15.326520 元，状态 settled；不等于实际商家付费订单。
- 新视频已用 QuickTime 打开播放，长图用 Preview 打开。更新包只打包已生成原始字节，不包含拒绝的 v2/v3/v4 长图。
- 类型检查和本轮 34 项相关测试通过。13 本地容器健康。这里没有宣称生产五模态全部通过；HappyHorse 中转映射故障仍未解决，图片回执费用在本轮查询的 model_usage_ledger 中尚未找到完整记录，不能把本地候选状态当成生产计费门禁已完成。
