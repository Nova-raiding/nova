#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_bin=${CODEX_NODE_BIN:-}

if [ -n "$node_bin" ] && [ -x "$node_bin" ]; then
  exec "$node_bin" "$script_dir/bridge.mjs" "$@"
fi

for candidate in \
  /opt/homebrew/opt/node@22/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$script_dir/bridge.mjs" "$@"
  fi
done

node_bin=$(command -v node 2>/dev/null || true)
if [ -n "$node_bin" ] && [ -x "$node_bin" ]; then
  exec "$node_bin" "$script_dir/bridge.mjs" "$@"
fi

echo 'merchant-marketing MCP bridge requires Node.js 18 or newer' >&2
exit 127
