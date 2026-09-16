#!/bin/sh
# Configure the local Store Nova stdio bridge for one macOS user session.
#
# This script never writes a token to the repository, a config file, stdout, or
# stderr. The token is read from stdin (hidden when interactive) and handed to
# launchd. The bridge's managed-token mode reads the same launchd values and
# fails closed if the endpoint/workspace changes.
set -eu

usage() {
  cat >&2 <<'EOF'
用法：install-local-macos.sh --base-url <https://yxsona.com 或 http://127.0.0.1:8787> --workspace <ws_xxx>

token 从标准输入读取；交互执行时输入不会回显。不要把 token 写在命令行参数中。
EOF
  exit 2
}

[ "$(uname -s 2>/dev/null || true)" = "Darwin" ] || {
  echo '本地插件安装器仅支持 macOS 桌面宿主；当前不会伪造安装成功。' >&2
  exit 1
}
command -v launchctl >/dev/null 2>&1 || {
  echo '未找到 launchctl；请在 macOS 用户会话中运行。' >&2
  exit 1
}

base_url=
workspace=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url) [ "$#" -ge 2 ] || usage; base_url=$2; shift 2 ;;
    --workspace) [ "$#" -ge 2 ] || usage; workspace=$2; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[ -n "$base_url" ] && [ -n "$workspace" ] || usage
case "$base_url" in
  http://127.0.0.1:*|http://localhost:*|https://*) ;;
  *) echo 'base URL 必须是 HTTPS，或本机 loopback HTTP；不会发送不安全的远程请求。' >&2; exit 2 ;;
esac
case "$base_url" in
  *\?*|*\#*|*/mcp|*/mcp/) echo 'base URL 不得包含查询参数、片段或 /mcp 路径。' >&2; exit 2 ;;
esac
case "$workspace" in
  ws_[A-Za-z0-9_-]*|workspace_[A-Za-z0-9_-]*|demo-workspace) ;;
  *) echo 'workspace 必须是服务端分配的工作区标识。' >&2; exit 2 ;;
esac

token=
if [ -t 0 ]; then
  printf '请输入 Store Nova 本地连接 token（不会回显）：' >&2
  old_stty=$(stty -g 2>/dev/null || true)
  stty -echo 2>/dev/null || true
  IFS= read -r token
  [ -n "$old_stty" ] && stty "$old_stty" 2>/dev/null || true
  printf '\n' >&2
else
  IFS= read -r token || true
fi
[ -n "$token" ] || { echo '未提供 token；请从商家后台“连接本地插件”获取短期凭据。' >&2; exit 2; }

# launchctl output is deliberately not printed. The token remains in the
# current user's launchd environment and is not persisted in this checkout.
launchctl setenv MERCHANT_MCP_BASE_URL "$base_url"
launchctl setenv MERCHANT_WORKSPACE_ID "$workspace"
launchctl setenv MERCHANT_MCP_TOKEN "$token"
launchctl setenv MERCHANT_MCP_TOKEN_SOURCE launchd
launchctl setenv MERCHANT_STRICT_AUTH true
launchctl setenv MERCHANT_ALLOW_FIXTURE_FALLBACK false
launchctl setenv MERCHANT_MCP_WRITE_ENABLED false
launchctl setenv DEPLOY_ENV local_desktop

# Verify presence without ever echoing secret material.
[ "$(launchctl getenv MERCHANT_MCP_BASE_URL 2>/dev/null || true)" = "$base_url" ] || { echo '本地连接配置写入失败：服务地址未生效。' >&2; exit 1; }
[ "$(launchctl getenv MERCHANT_WORKSPACE_ID 2>/dev/null || true)" = "$workspace" ] || { echo '本地连接配置写入失败：工作区未生效。' >&2; exit 1; }
[ -n "$(launchctl getenv MERCHANT_MCP_TOKEN 2>/dev/null || true)" ] || { echo '本地连接配置写入失败：token 未生效。' >&2; exit 1; }

echo 'Store Nova 本地插件连接已配置。请完全退出并重新打开 ChatGPT/Codex，再新建会话验收。'
echo '本地模式不使用 ChatGPT OAuth；商家 token 仍由 Store Nova 服务端签发并可撤销。'
