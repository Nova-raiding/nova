# Windows 生产签名准备

日期：2026-09-29。状态：申请与接入方案已准备；尚未购买、签发证书或配置云端签名身份。

## 已有环境

目标 Windows 为 LAPTOP-H6U5929T，用户 Han。已安装 Git、Node、.NET 8 SDK，候选 7863af8e5cd24a22e6946dabd1fed4fd6bc4b74d 已在 Windows 编译成功。现有主机构建能力足够，新增机器不能替代证书申请。

## 申请路径

优先评估 DigiCert Code Signing + KeyLocker 云端密钥保管，避免实体令牌运输。必须先由供应商确认申请主体资格、具体套餐和报价。官方购买页呈现多种价格，尚未形成可批准订单，不以起价作为实际总价。

所需首批信息：公司法定名称、注册国家/地区、可登录的企业 CertCentral 账号（若已有）。证件、验证电话、账号 MFA 及付款应在供应商官方页面由授权人员完成，不写入仓库或聊天。

Microsoft Artifact Signing 作为符合地区资格的备选。2026-09-29 官方 Public Trust 组织地区列表不包含中国大陆；不能借用虚构主体或用 Private Trust 替代公众信任。

## 接入顺序

1. 确认真实主体资格与供应商订单明细，再确认购买金额及续费条件。
2. 完成 CA 身份验证、签发代码签名证书并在合规硬件或云端 HSM 保管私钥。
3. 从企业 KeyLocker 官方下载入口获取 Windows 客户端，检查安装器签名后安装。按官方流程配置客户端认证与 KSP、同步证书；认证凭据不进入源码或命令日志。
4. 在 Windows 验证证书有效期、CodeSigning EKU、可信链、私钥可用性。现有 builder 依赖 Windows 证书库和 Set-AuthenticodeSignature；KeyLocker 对该具体调用路径的兼容性尚未实测，不能提前标为兼容通过。
5. 使用独立测试文件分别验证 EXE 与 PS1 的签名、时间戳以及 Get-AuthenticodeSignature 状态。若需 SignTool 适配，保留当前固定签名者、整包哈希和安装绑定验证，再修改并测试。
6. 在干净候选根目录执行现有正式构建入口，输出 ZIP、包外签名安装器及 SHA256。安装后完成浏览器商家授权、重启宿主、新对话真实 MCP 与业务验收。

证书就绪后的现有命令模板（占位符不能直接执行）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/plugin/scripts/build-signed-windows-package.ps1 -OutputPath "$env:TEMP/storenova-win-7863af8.zip" -HelperDirectory "$env:TEMP/storenova-helper-7863af8" -CertificateThumbprint '<已验证生产证书指纹>' -TimestampServer '<已验证供应商时间戳地址>'
```

## 官方依据

- [DigiCert 产品、硬件密钥要求与购买入口](https://www.digicert.com/signing/code-signing-certificates)
- [DigiCert 证书申请与组织验证](https://docs.digicert.com/en/certcentral/order-and-manage-certificates/request-certificates/request-a-code-signing-or-ev-code-signing-certificate/request-code-signing-certificate.html)
- [KeyLocker Windows 客户端配置](https://knowledge.digicert.com/tutorials/keylocker-configuration-for-windows)
- [Microsoft Artifact Signing 资格与身份验证](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
- [PowerShell Authenticode 签名接口](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-authenticodesignature?view=powershell-5.1)

本准备文档不构成证书签发、签名服务开通或 Windows 安装验收通过证据。
